/**
 * stateStore.ts
 *
 * Thin wrapper quanh Mastra storage để persist ConversationState.
 * Store-first pattern.
 */

import { ConversationState, DEFAULT_STATE } from "./stateMachine";
import { isLeadComplete, writeLeadToSheets } from "./sheetsWriter";

const STORE_NAME = "memory";
const STATE_SUFFIX = "-fsm-state";

function stateThreadId(threadId: string): string {
  return `${threadId}${STATE_SUFFIX}`;
}

export async function loadState(
  mastra: any,
  threadId: string,
  resourceId: string,
): Promise<ConversationState> {
  const tid = stateThreadId(threadId);

  try {
    const storage = mastra?.getStorage?.();
    if (!storage) {
      console.warn(
        "[stateStore] getStorage() returned null — using DEFAULT_STATE",
      );
      return { ...DEFAULT_STATE };
    }

    const store = await storage.getStore(STORE_NAME);
    if (!store) {
      console.warn(`[stateStore] getStore("${STORE_NAME}") returned null`);
      return { ...DEFAULT_STATE };
    }

    const thread = await store.getThreadById({ threadId: tid });
    if (!thread?.metadata) {
      console.log(`[stateStore] no saved state for ${tid} — first turn`);
      return { ...DEFAULT_STATE };
    }

    const m = thread.metadata as Partial<ConversationState>;
    console.log(`[stateStore] loaded:`, {
      flow: m.flow,
      stage: m.stage,
      temp: m.temperature,
      slots: m.knownInfo,
    });

    // Clamp flow về union hợp lệ — nếu DB corrupt (giá trị lạ) → fallback fitness.
    const flow =
      m.flow === "fitness" || m.flow === "giai-co"
        ? m.flow
        : DEFAULT_STATE.flow;
    if (m.flow && m.flow !== flow) {
      console.warn(
        `[stateStore] flow corrupt cho ${tid}: "${m.flow}" → fallback "${flow}"`,
      );
    }

    return {
      flow,
      stage: m.stage ?? DEFAULT_STATE.stage,
      temperature: m.temperature ?? DEFAULT_STATE.temperature,
      emotion: m.emotion ?? DEFAULT_STATE.emotion,
      intent: m.intent ?? DEFAULT_STATE.intent,
      // Load intentTopic của TURN TRƯỚC (đã lưu từ saveState lần trước).
      // Dùng cho:
      //   (1) Safety flow lock: nếu previous=ask_senior_safety/ask_postpartum_safety,
      //       turn này dù có mention "đau khớp" cũng STAY fitness flow.
      //   (2) Follow-up context: classifier dùng previousIntentTopic để route đúng
       //      (vd previous=complaint_crowded → "giờ vắng" vẫn complaint_crowded).
      // Sau buildNextState, intentTopic sẽ bị overwrite bằng kết quả classifier turn HIỆN TẠI.
      intentTopic: (m.intentTopic ?? null) as any,
      intentSignal: ((m as any).intentSignal ?? null),
      secondaryIntents: ((m as any).secondaryIntents ?? []) as any,
      honorific: m.honorific ?? DEFAULT_STATE.honorific,
      knownInfo: {
        name: m.knownInfo?.name ?? null,
        phone: m.knownInfo?.phone ?? null,
        serviceType: m.knownInfo?.serviceType ?? null,
        memberType: m.knownInfo?.memberType ?? null,
        durationMonths: m.knownInfo?.durationMonths ?? null,
        schedule: m.knownInfo?.schedule ?? null,
        painArea: m.knownInfo?.painArea ?? null,
        painDuration: m.knownInfo?.painDuration ?? null,
        sessionPackage: m.knownInfo?.sessionPackage ?? null,
        preferredTime: m.knownInfo?.preferredTime ?? null,
        painSpread: m.knownInfo?.painSpread ?? null,
        pastMethod: m.knownInfo?.pastMethod ?? null,
        fitnessGoal: m.knownInfo?.fitnessGoal ?? null,
      },
      turnCount: m.turnCount ?? 0,
      flowTurnCount: (m as any).flowTurnCount ?? 0,
      qrShown: m.qrShown ?? false,
      mediaShown: m.mediaShown ?? false,
      mediaShownKeys: (m as any).mediaShownKeys ?? [],
      sheetsWritten: (m as any).sheetsWritten ?? false,
      lastBotReply: (m as any).lastBotReply,
      lastUserMessage: (m as any).lastUserMessage,
      askedHistory: (m as any).askedHistory ?? [],
      mentionedFacts: (m as any).mentionedFacts ?? [],
    };
  } catch (e) {
    console.error(`[stateStore] loadState failed for ${tid}:`, e);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(
  mastra: any,
  threadId: string,
  resourceId: string,
  state: ConversationState,
): Promise<void> {
  const tid = stateThreadId(threadId);

  // Sheets-write side-effect đã được tách ra `tryWriteLeadIfReady` —
  // chỉ chạy SAU KHI reply gửi thành công (xem routes/facebook.ts).
  // Lý do: với cancel-and-restart, turn bị abort vẫn save state trong processStep;
  // nếu sheets-write nằm trong saveState thì lead bị ghi cho turn KH chưa thấy reply
  // → order-lock kích hoạt sớm → bot im lặng cho turn replay sau.

  try {
    const storage = mastra?.getStorage?.();
    if (!storage) {
      console.error(
        "[stateStore] getStorage() returned null — state NOT saved",
      );
      return;
    }

    const store = await storage.getStore(STORE_NAME);
    if (!store) {
      console.error(`[stateStore] getStore("${STORE_NAME}") returned null`);
      return;
    }

    await store.saveThread({
      thread: {
        id: tid,
        resourceId,
        title: "fsm-state",
        metadata: state as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    console.log(`[stateStore] saved:`, {
      tid,
      flow: state.flow,
      stage: state.stage,
      temp: state.temperature,
      slots: state.knownInfo,
    });
  } catch (e) {
    console.error(`[stateStore] saveState failed for ${tid}:`, e);
  }
}

/**
 * Best-effort: nếu lead đủ (name + phone + preferredTime) và chưa ghi sheets →
 * ghi sheets + set sheetsWritten=true + save state.
 *
 * Gọi SAU KHI reply đã sendText thành công (route handler). Tách khỏi saveState
 * để cancel-and-restart không ghi sheets cho turn KH chưa thấy reply.
 *
 * Idempotent: chạy 2 lần liên tiếp với state đã sheetsWritten=true → no-op.
 * Lỗi sheets-write KHÔNG bubble — log + tiếp tục (bot vẫn reply OK, chỉ thiếu sheets).
 */
export async function tryWriteLeadIfReady(
  mastra: any,
  threadId: string,
  resourceId: string,
): Promise<void> {
  const tid = stateThreadId(threadId);
  try {
    const state = await loadState(mastra, threadId, resourceId);
    if (state.sheetsWritten) return;
    if (!isLeadComplete(state)) return;

    console.log(
      `[stateStore] writing lead → name=${state.knownInfo.name} phone=${state.knownInfo.phone} time=${state.knownInfo.preferredTime}`,
    );
    await writeLeadToSheets(state);
    state.sheetsWritten = true;
    await saveState(mastra, threadId, resourceId, state);
  } catch (e) {
    console.error(`[stateStore] tryWriteLeadIfReady failed for ${tid}:`, e);
  }
}

export async function debugStorageApi(mastra: any): Promise<void> {
  try {
    const storage = mastra?.getStorage?.();
    console.log("[DEBUG] storage type:", typeof storage);
    console.log(
      "[DEBUG] storage keys:",
      storage ? Object.keys(storage) : "null",
    );

    if (storage?.getStore) {
      const store = await storage.getStore("memory");
      console.log("[DEBUG] store type:", typeof store);
      console.log("[DEBUG] store keys:", store ? Object.keys(store) : "null");
    } else {
      console.log("[DEBUG] storage.getStore not found");
      console.log(
        "[DEBUG] prototype methods:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(storage)),
      );
    }
  } catch (e) {
    console.error("[DEBUG] error:", e);
  }
}

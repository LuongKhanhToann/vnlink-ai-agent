/**
 * stateStore.ts
 *
 * Thin wrapper quanh Mastra storage để persist ConversationState.
 * Store-first pattern.
 */

import { ConversationState, DEFAULT_STATE, bookingSignature, detectAddBookingIntent } from "./stateMachine";
import { isLeadComplete, writeLeadToSheets, updateLeadRow } from "./sheetsWriter";

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

    const loaded: ConversationState = {
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
        bodyStats: m.knownInfo?.bodyStats ?? null,
      },
      turnCount: m.turnCount ?? 0,
      flowTurnCount: (m as any).flowTurnCount ?? 0,
      qrShown: m.qrShown ?? false,
      mediaShown: m.mediaShown ?? false,
      mediaShownKeys: (m as any).mediaShownKeys ?? [],
      sheetsWritten: (m as any).sheetsWritten ?? false,
      bookingsWritten: (m as any).bookingsWritten ?? [],
      servicesInterested: (m as any).servicesInterested ?? [],
      rescheduleFromTime: (m as any).rescheduleFromTime ?? null,
      lastBotReply: (m as any).lastBotReply,
      lastUserMessage: (m as any).lastUserMessage,
      askedHistory: (m as any).askedHistory ?? [],
      mentionedFacts: (m as any).mentionedFacts ?? [],
      safetyTopicsCovered: (m as any).safetyTopicsCovered ?? [],
      lastTemplateId: (m as any).lastTemplateId ?? null,
      recentBotReplies: (m as any).recentBotReplies ?? [],
    };

    // MIGRATION: lead cũ đã chốt dưới code cũ (sheetsWritten=true) nhưng chưa có
    // bookingsWritten → seed chữ ký đơn hiện tại để (1) tránh ghi trùng dòng,
    // (2) vào thẳng retention thay vì re-confirm. Idempotent: lần load sau đã có sẵn.
    if (loaded.sheetsWritten && (loaded.bookingsWritten?.length ?? 0) === 0) {
      const sig = bookingSignature(loaded.knownInfo, loaded.flow);
      if (sig) {
        loaded.bookingsWritten = [sig];
        console.log(`[stateStore] migrate: seed bookingsWritten=[${sig}] cho lead cũ ${tid}`);
      }
    }
    return loaded;
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
 * Best-effort: nếu lead đủ (name + phone + preferredTime) VÀ chữ ký đơn này CHƯA được ghi →
 * ghi sheets + push chữ ký vào bookingsWritten + set sheetsWritten=true + save state.
 *
 * Gọi SAU KHI reply đã sendText thành công (route handler). Tách khỏi saveState
 * để cancel-and-restart không ghi sheets cho turn KH chưa thấy reply.
 *
 * MULTI-ORDER: dedup theo bookingSignature (`flow|tên|SĐT|giờ`) thay vì khóa boolean.
 *   - Đơn 1 chốt → ghi dòng 1, lưu chữ ký.
 *   - KH chat tiếp / chỉ HỎI môn khác (giữ giờ cũ) → chữ ký trùng → no-op (không ghi lại).
 *   - KH đặt thêm buổi GIỜ KHÁC (hoặc người khác) + có tín hiệu cam kết → chữ ký mới → ghi dòng tiếp.
 *   - KH ĐỔI lịch (reschedule, rescheduleFromTime set) → UPDATE dòng cũ (updateLeadRow) thay vì append.
 *   - KH đặt hộ NGƯỜI THÂN → beneficiary override ở buildNextState đã đổi name/phone → dòng mới đúng liên hệ.
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
    if (!isLeadComplete(state)) return;

    const sig = bookingSignature(state.knownInfo, state.flow);
    if (sig === null) return;
    const written = state.bookingsWritten ?? [];

    // ── RESCHEDULE: KH đổi giờ 1 đơn ĐÃ ghi → UPDATE dòng cũ thay vì append dòng trùng.
    const rf = state.rescheduleFromTime;
    if (rf) {
      const oldSig = bookingSignature({ ...state.knownInfo, preferredTime: rf }, state.flow);
      if (oldSig && oldSig !== sig && written.includes(oldSig)) {
        const updated = await updateLeadRow(state, rf);
        if (updated) {
          state.bookingsWritten = written.map((s) => (s === oldSig ? sig : s));
          state.rescheduleFromTime = null;
          await saveState(mastra, threadId, resourceId, state);
          return;
        }
        // Không tìm thấy dòng cũ trên sheet → fall through append (best-effort).
        console.warn(`[stateStore] reschedule: không thấy dòng cũ (oldTime=${rf}) → append mới`);
      }
    }

    if (written.includes(sig)) return; // đơn này đã ghi rồi → bỏ qua

    // Đơn THỨ 2+: chỉ ghi khi có tín hiệu CAM KẾT thật trong turn này — tránh ghi "đơn ma".
    // Sau chốt, name/phone/giờ vẫn còn nên isLeadComplete luôn true; nếu khách chỉ HỎI vu vơ
    // hoặc đổi flow (đau lưng → giai-co) thì chữ ký có thể "mới" nhưng KHÔNG phải đặt thêm.
    // Đơn ĐẦU TIÊN (written rỗng) đã được funnel đảm bảo commitment → ghi như cũ.
    if (written.length > 0) {
      const msg = state.lastUserMessage ?? "";
      const committed =
        state.intent === "ready" ||
        state.intent === "selecting" ||
        state.stage === "commitment" ||
        detectAddBookingIntent(msg);
      if (!committed) {
        console.log(
          `[stateStore] skip write đơn #${written.length + 1}: chưa có tín hiệu cam kết (intent=${state.intent}, stage=${state.stage}, sig=${sig})`,
        );
        return;
      }
    }

    console.log(
      `[stateStore] writing lead → name=${state.knownInfo.name} phone=${state.knownInfo.phone} time=${state.knownInfo.preferredTime} sig=${sig} (order #${written.length + 1})`,
    );
    await writeLeadToSheets(state);
    state.bookingsWritten = [...written, sig];
    state.sheetsWritten = true;
    state.rescheduleFromTime = null;
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

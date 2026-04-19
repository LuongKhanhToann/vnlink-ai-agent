/**
 * stateStore.ts
 *
 * Thin wrapper quanh Mastra storage để persist ConversationState.
 * Store-first pattern.
 */

import { ConversationState, DEFAULT_STATE } from "./stateMachine";

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

    return {
      flow: m.flow ?? DEFAULT_STATE.flow,
      stage: m.stage ?? DEFAULT_STATE.stage,
      temperature: m.temperature ?? DEFAULT_STATE.temperature,
      emotion: m.emotion ?? DEFAULT_STATE.emotion,
      intent: m.intent ?? DEFAULT_STATE.intent,
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
      qrShown: m.qrShown ?? false,
      mediaShown: m.mediaShown ?? false,
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

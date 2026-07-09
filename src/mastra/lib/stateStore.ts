/**
 * stateStore.ts
 *
 * Thin wrapper quanh Mastra storage để persist ConversationState.
 * Store-first pattern.
 */

import { ConversationState, DEFAULT_STATE, bookingSignature, detectAddBookingIntent, detectBeneficiaryCue, appointmentDateKey } from "./stateMachine";
import { isLeadComplete, writeLeadToSheets, updateLeadRow } from "./sheetsWriter";
import { recordUserName } from "./botControl";
import { memory } from "../config/memory";

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
      // mediaMove: quyết định KHOE media của classifier turn TRƯỚC. PHẢI khôi phục —
      // computeProactiveMediaKey đọc field này; rớt → media chủ động (show_results/show_service)
      // không bao giờ bung, chỉ còn cứu được khi khách XIN thẳng (intentSignal.domain=media_request).
      mediaMove: ((m as any).mediaMove ?? "none") as any,
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
        appointmentDate: m.knownInfo?.appointmentDate ?? null,
        painSpread: m.knownInfo?.painSpread ?? null,
        pastMethod: m.knownInfo?.pastMethod ?? null,
        fitnessGoal: m.knownInfo?.fitnessGoal ?? null,
        bodyStats: m.knownInfo?.bodyStats ?? null,
        gender: m.knownInfo?.gender ?? null,
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
      acuteInjuryHold: (m as any).acuteInjuryHold ?? false,
      corporateHold: (m as any).corporateHold ?? false,
      lastTemplateId: (m as any).lastTemplateId ?? null,
      recentBotReplies: (m as any).recentBotReplies ?? [],
      recentUserMessages: (m as any).recentUserMessages ?? [],
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

    // Tên khách tự khai trong chat → backfill bot_controls.name cho admin panel
    // (không cần Graph API / App Review). resourceId = PSID. Fire-and-forget.
    const chatName = state.knownInfo?.name;
    if (chatName) void recordUserName(resourceId, chatName);

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
 * MULTI-ORDER: dedup theo bookingSignature (`flow|tên|SĐT|NGÀY`) thay vì khóa boolean.
 *   - Đơn 1 chốt → ghi dòng 1, lưu chữ ký (khóa theo NGÀY hẹn, không theo giờ-raw).
 *   - KH làm rõ / ĐỔI GIỜ trong CÙNG ngày ("mai"→"10h sáng mai"→"2h chiều") → chữ ký trùng → UPDATE 1 dòng (1 người+1 ngày=1 dòng).
 *   - KH chat tiếp / HỎI môn khác (giữ ngày cũ) → chữ ký trùng + giá trị không đổi → no-op.
 *   - KH đổi sang NGÀY khác (không phải "đặt thêm") → UPDATE dòng gần nhất sang ngày mới (chống trùng).
 *   - KH ĐẶT THÊM buổi (cue "thêm/nữa") / đặt hộ người thân + cam kết → chữ ký mới → ghi dòng tiếp.
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

    const info = state.knownInfo;
    const sig = bookingSignature(info, state.flow);
    if (sig === null) return;
    const written = state.bookingsWritten ?? [];
    const msg = state.lastUserMessage ?? "";

    // matchCore = thứ dùng TÌM dòng trên sheet (cột "Thời gian đến" CHỨA nó):
    //   - đơn có ngày tuyệt đối → LÕI NGÀY "DD/MM" (bền khi khách đổi giờ trong ngày)
    //   - đơn cửa-sổ chưa có ngày → cụm giờ (hành vi cũ)
    const matchCore = appointmentDateKey(info.appointmentDate) ?? (info.preferredTime ?? "");

    // ── (1) ĐÃ ghi đúng đơn (cùng người + cùng NGÀY) → đồng bộ thay đổi GIỜ trong ngày: UPDATE 1 dòng,
    // KHÔNG append. "1 người + 1 ngày = 1 dòng": "mai"→"10h sáng mai"→"2h chiều" gộp về 1 dòng.
    if (written.includes(sig)) {
      const r = await updateLeadRow(state, matchCore);
      if (r === "updated") {
        console.log(`[stateStore] ✎ đồng bộ đơn (cùng ngày) → "${info.preferredTime}" sig=${sig}`);
      }
      return;
    }

    // ── (2) Người này ĐÃ có đơn nhưng chữ ký MỚI (đổi NGÀY, hoặc cửa-sổ→ngày cụ thể).
    // KHÔNG phải "đặt thêm / đặt hộ" → đây là LÀM RÕ / ĐỔI LỊCH đơn cũ → UPDATE dòng GẦN NHẤT (chống trùng).
    if (written.length > 0) {
      const isAdd = detectAddBookingIntent(msg) || detectBeneficiaryCue(msg);
      if (!isAdd) {
        const prevSig = written[written.length - 1];
        const prevCore = prevSig.split("|")[3] ?? "";
        const r = await updateLeadRow(state, prevCore);
        if (r !== "notfound") {
          state.bookingsWritten = written.map((s) => (s === prevSig ? sig : s));
          state.rescheduleFromTime = null;
          await saveState(mastra, threadId, resourceId, state);
          console.log(`[stateStore] ✎ đổi lịch/làm rõ đơn cũ → sig ${prevSig} ↦ ${sig}`);
          return;
        }
        console.warn(`[stateStore] đổi lịch: không thấy dòng cũ (core="${prevCore}") → append mới`);
      }

      // Đơn THỨ 2+ thực sự (đặt thêm/đặt hộ): chỉ append khi có tín hiệu CAM KẾT thật — tránh "đơn ma".
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

    // ── (3) Đơn MỚI hợp lệ → append.
    console.log(
      `[stateStore] writing lead → name=${info.name} phone=${info.phone} time=${info.preferredTime} ngày=${info.appointmentDate ?? "—"} sig=${sig} (order #${written.length + 1})`,
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

/**
 * Xoá TOÀN BỘ dữ liệu hội thoại trong Mastra memory của 1 sender (admin "xoá dữ liệu chat").
 * Hai thread cùng key PSID:
 *   - `senderId`            → tin nhắn hội thoại (messages) + vector semantic-recall.
 *   - `senderId-fsm-state`  → ConversationState (slot/stage/flow) lưu ở metadata thread.
 * `memory.deleteThread()` xoá thread + messages + vector của thread đó. Nếu lỗi (vd thread
 * không tồn tại / không có vector) → fallback xoá thẳng qua store. Best-effort, gom lỗi trả về.
 * KHÔNG đụng Google Sheets (sổ booking giữ nguyên) và KHÔNG đụng bot_controls/working-memory
 * (xem deleteBotUser ở botControl.ts).
 */
export async function deleteConversationData(
  mastra: any,
  senderId: string,
): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];
  const threadIds = [senderId, stateThreadId(senderId)];
  for (const tid of threadIds) {
    try {
      await memory.deleteThread(tid);
      deleted.push(tid);
    } catch (e) {
      // Fallback: xoá trực tiếp qua store (thread FSM không có vector nên path này hay gặp).
      try {
        const store = await mastra?.getStorage?.()?.getStore?.(STORE_NAME);
        if (store?.deleteThread) {
          await store.deleteThread({ threadId: tid });
          deleted.push(tid);
        } else {
          errors.push(`thread ${tid}: store không khả dụng`);
        }
      } catch (e2) {
        errors.push(`thread ${tid}: ${(e2 as Error).message}`);
      }
    }
  }
  console.log(
    `[stateStore] deleteConversationData ${senderId}: deleted=[${deleted.join(", ")}] errors=${errors.length}`,
  );
  return { deleted, errors };
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

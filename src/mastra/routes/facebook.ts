/**
 * routes/facebook.ts
 *
 * Cancel-and-restart pattern (commit-aware):
 *   - Tin đến → abort turn đang chạy CHỈ KHI chưa pass commit-point.
 *   - Commit-point = ngay TRƯỚC khi sendText reply 1 đầu tiên ra ngoài.
 *     Trước commit: msg mới → abort LLM + re-batch (gộp [msg1, msg2] thành 1 turn).
 *     Sau commit:  msg mới → chỉ buffer + đợi flush kế tiếp (reply 1 đã hiển thị → coi như follow-up).
 *   - Buffer preserve khi abort: consumed messages prepend lại buffer để turn sau xử lý gộp.
 *   - Sheets-write (irreversible) tách sang `tryWriteLeadIfReady`, gọi SAU KHI sendText thành công.
 */

import { Hono } from "hono";
import { routerWorkflow } from "../workflows/routerWorkflow";
import { scheduleFollowup, cancelFollowup } from "../lib/followup";
import { splitIntoBubbles, typingDelayMs } from "../lib/humanize";
import { recordUserActivity, isBotEnabled } from "../lib/botControl";
import { classifyAndUpdateState } from "../lib/silentClassify";
import { memory } from "../config/memory";
import { randomUUID } from "node:crypto";
import "dotenv/config";

// NGƯỜI HOÁ output: tách reply thành 2-3 bóng ngắn + "đang soạn tin…" + độ trễ gõ
// (sale Zalo thật gửi nhiều bóng ngắn, không gửi 1 đoạn dài hoàn chỉnh).
// Tắt từng phần qua env khi cần (test / debug): HUMANIZE_BUBBLES=0, HUMANIZE_TYPING=0.
const HUMANIZE_BUBBLES = process.env.HUMANIZE_BUBBLES !== "0";
const HUMANIZE_TYPING = process.env.HUMANIZE_TYPING !== "0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

// Debounce: chờ KH dừng gõ trước khi flush. Tin mới trong window này → reset timer.
// 2s default. Override qua FB_DEBOUNCE_MS.
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS ?? "2000");

// Hold dài hơn khi buffer mới CHỈ là câu chào/gọi trống ("alo e", "hi", "chào shop").
// Lý do: trên FB khách hay tách tin — chào trước, hỏi sau. Nếu flush câu chào ngay (2s) →
// bot trả lời chào, rồi tin nội dung tới thành turn 2 → 2 reply rời rạc ("loạn").
// Giữ lâu hơn để câu hỏi thật kịp tới rồi gộp chung 1 turn. Override qua FB_OPENER_HOLD_MS.
const OPENER_HOLD_MS = Number(process.env.FB_OPENER_HOLD_MS ?? "6000");

/**
 * True khi text mới chỉ gồm từ chào/gọi + tiểu từ (chưa có nội dung thực).
 * Vd: "alo e", "hi", "chào shop", "em ơi", "ad ơi" → true.
 *     "a muốn tập gym", "giảm mỡ" → false (đã có nội dung).
 */
function looksIncompleteOpener(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (!t) return true;
  const stripped = t
    // từ chào
    .replace(/\b(a?lô|alo|hi+|hello|hế?l+ô|chào|chao|xin chào|good morning|gm|ad|admin|shop)\b/gi, "")
    // tiểu từ / đại từ gọi
    .replace(/\b(em|e|anh|a|chị|chi|ơi|oi|ạ|dạ|vâng|ad|nhé|nha)\b/gi, "")
    .replace(/[\s,.!?…ơ~-]+/g, "")
    .trim();
  return stripped.length <= 1;
}

type SenderState = {
  /** Tin chưa được xử lý — append theo thứ tự, gộp = join("\n") khi flush. */
  buffer: string[];
  /** Timer chờ KH dừng gõ. Reset mỗi tin mới. */
  debounceTimer: NodeJS.Timeout | null;
  /** AbortController của turn đang chạy. null = không có turn nào. */
  inflight: AbortController | null;
  /**
   * True khi turn đã pass commit-point (reply 1 sắp/đã gửi cho KH).
   * Tin mới đến SAU committed → KHÔNG abort (tránh hủy nửa chừng commit phase).
   * Reset về false ở đầu mỗi flush.
   */
  committed: boolean;
};

const senders = new Map<string, SenderState>();

function ensureSender(senderId: string): SenderState {
  let state = senders.get(senderId);
  if (!state) {
    state = { buffer: [], debounceTimer: null, inflight: null, committed: false };
    senders.set(senderId, state);
  }
  return state;
}

/**
 * Reset toàn bộ session in-memory của FB — dùng cho admin /reset trên Telegram.
 * Abort tất cả inflight + clear timer + clear buffer. Không xoá DB.
 */
export function resetAllFbSessionState(): void {
  for (const state of senders.values()) {
    state.inflight?.abort();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
  }
  senders.clear();
  console.log("[fb] resetAllFbSessionState: aborted inflight + cleared all senders");
}

/**
 * Xoá session in-memory của 1 sender (admin "xoá dữ liệu chat" 1 người).
 * Abort turn đang chạy + clear debounce timer + xoá khỏi map. Không đụng DB.
 */
export function purgeFbSessionState(senderId: string): void {
  const state = senders.get(senderId);
  if (!state) return;
  state.inflight?.abort();
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  senders.delete(senderId);
  console.log(`[fb] purgeFbSessionState: cleared ${senderId}`);
}

/**
 * Lưu 1 tin vào thread memory mà KHÔNG sinh reply — dùng khi AI đang tắt:
 *   (1) Tin khách lúc AI bị admin tắt        → role=user
 *   (2) Nhân viên trả tay từ inbox (echo)     → role=assistant
 * Nhờ vậy khi admin BẬT lại, agent nạp lastMessages + semanticRecall sẽ thấy đủ đoạn
 * hội thoại xảy ra trong lúc tắt → nối tiếp đúng ngữ cảnh, không bắt đầu lại từ điểm cũ.
 * Tạo thread nếu chưa có (khách nhắn lần đầu lúc AI đang tắt). Best-effort — lỗi không chặn.
 */
async function logMessageToMemory(
  senderId: string,
  role: "user" | "assistant",
  text: string,
): Promise<void> {
  try {
    const existing = await memory.getThreadById({ threadId: senderId });
    if (!existing) {
      await memory.saveThread({
        thread: {
          id: senderId,
          resourceId: senderId,
          title: "fb-chat",
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
        },
      });
    }
    await memory.saveMessages({
      messages: [
        {
          id: randomUUID(),
          role,
          type: "text",
          threadId: senderId,
          resourceId: senderId,
          createdAt: new Date(),
          content: { format: 2, parts: [{ type: "text", text }] },
        },
      ],
    });
    console.log(`[fb] logged ${role} msg to memory for ${senderId} (AI off, no reply)`);
  } catch (e) {
    console.error(`[fb] logMessageToMemory failed for ${senderId}:`, e);
  }
}

export const facebookWebhook = new Hono();

facebookWebhook.get("/webhook", (c) => {
  const mode      = c.req.query("hub.mode");
  const token     = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("[fb] webhook verified");
    return c.text(challenge ?? "");
  }

  return c.text("Forbidden", 403);
});

facebookWebhook.post("/webhook", async (c) => {
  const body = await c.req.json();

  if (body.object !== "page") return c.text("NOT_PAGE", 404);

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const msg = event.message;
      if (!msg) continue;

      // ── ECHO = tin GỬI ĐI từ page ──
      //   có app_id  → do app (bot) tự gửi → agent đã lưu vào memory rồi → bỏ qua.
      //   không app_id → NHÂN VIÊN trả tay từ inbox → lưu vào memory (vai assistant) để
      //                  bot nắm được người thật đã nói gì. Thread = recipient (khách).
      if (msg.is_echo) {
        if (!msg.app_id && msg.text) {
          const customerId = event.recipient?.id as string | undefined;
          if (customerId) {
            console.log(`[fb] human echo → log memory for ${customerId}: "${msg.text}"`);
            void logMessageToMemory(customerId, "assistant", msg.text as string);
          }
        }
        continue;
      }

      if (!msg.text) continue;

      const senderId = event.sender.id as string;
      const text     = msg.text as string;

      console.log(`[fb] from=${senderId} text="${text}"`);

      // Ghi nhận user (để webadmin thấy danh sách) — chạy nền, không chặn.
      void recordUserActivity(senderId);

      // CỔNG BẬT/TẮT AI: admin tắt user này → bot KHÔNG trả lời. Đọc cờ mỗi tin (không cache).
      if (!(await isBotEnabled(senderId))) {
        // KHÔNG trả lời, nhưng VẪN: (1) lưu tin vào memory (transcript) +
        // (2) chạy classifier âm thầm để cập nhật slot/stage → bật lại bot có đủ ngữ cảnh
        //     lẫn thông tin đã trích (tên/SĐT/giờ…), không hỏi lại.
        console.log(`[fb] AI disabled for ${senderId} — lưu memory + silent classify, không trả lời`);
        void logMessageToMemory(senderId, "user", text);
        void classifyAndUpdateState(senderId, senderId, text);
        continue;
      }

      enqueueMessage(senderId, text);
    }
  }

  return c.text("EVENT_RECEIVED");
});

// ─────────────────────────────────────────────
// Follow-up: load state + pre-fetch media → schedule
// (dynamic import để tránh circular dep với index.ts)
// ─────────────────────────────────────────────

const SERVICE_TO_MEDIA_KEY: Record<string, string> = {
  gym: "fitness-gym",
  full: "fitness-gym",
  pilates: "fitness-gym",
  yoga: "fitness-yoga",
  zumba: "fitness-zumba",
  boi: "fitness-pool",
};

async function scheduleFollowupWithMedia(senderId: string): Promise<void> {
  try {
    const { mastra } = await import("../index");
    const { loadState } = await import("../lib/stateStore");
    const { getMediaTool } = await import("../tools/media");

    const state = await loadState(mastra, senderId, senderId);

    // Skip followup khi lead đã chốt — đủ tên + SĐT + giờ. Followup khi đã đặt lịch xong
    // làm khách bối rối ("đã chốt rồi mà bot vẫn nhắn check lại").
    const leadDone =
      state.knownInfo.name !== null &&
      state.knownInfo.phone !== null &&
      state.knownInfo.preferredTime !== null;
    if (leadDone) {
      console.log(`[followup] skip ${senderId} — lead đã chốt (tên+SĐT+giờ đủ)`);
      return;
    }

    // Compute media key dựa trên state. Nếu đã gửi media trong cuộc thoại
    // (mediaShown=true) → KHÔNG re-fetch để tránh spam ảnh trùng.
    let mediaKey: string | null = null;
    if (!state.mediaShown) {
      if (state.flow === "fitness" && state.knownInfo.serviceType) {
        mediaKey = SERVICE_TO_MEDIA_KEY[state.knownInfo.serviceType] ?? null;
      } else if (state.flow === "giai-co" && state.knownInfo.painArea) {
        const pain = state.knownInfo.painArea.toLowerCase();
        if (/vai|gáy|gay|cổ|co\b/.test(pain)) mediaKey = "mr-neck-shoulder";
        else if (/chân|chan|gối|goi/.test(pain)) mediaKey = "mr-sport";
        else mediaKey = "mr-general";
      }
    }

    // Fetch media URLs (nếu có key)
    let mediaUrls: string[] = [];
    if (mediaKey) {
      try {
        const result = await (getMediaTool as any).execute({
          context: { key: mediaKey },
        });
        const data = typeof result?.data === "string" ? JSON.parse(result.data) : [];
        mediaUrls = data.map((d: { url: string }) => d.url).filter(Boolean);
      } catch (e) {
        console.warn("[followup] fetch media failed:", e);
      }
    }

    scheduleFollowup(
      senderId,
      {
        sendText: (text) => sendText(senderId, text),
        sendMedia: (url) => sendMedia(senderId, url),
        generate: (attempt) => generateFollowupReply(senderId, attempt),
      },
      mediaUrls,
    );
  } catch (e) {
    console.error("[followup] scheduleFollowupWithMedia failed:", e);
  }
}

/**
 * Sinh tin follow-up bằng LLM (KHÔNG template/regex): nạp state hiện tại, dựng prefix
 * theo đúng bước funnel + 1 chỉ thị "khách im, chủ động nhắc + tiến bước", rồi chạy chính
 * agent (có memory thread) → cleanReply. Trả null nếu đã chốt / LLM fail → followup bỏ qua lần đó.
 */
export async function generateFollowupReply(senderId: string, attempt: number): Promise<string | null> {
  try {
    // KH vừa nhắn lại / bot đang trả lời → KHÔNG nhắc nữa. cancelFollowup() chỉ clear TIMER,
    // nó KHÔNG chặn được lần fire đã bắt đầu chạy → thiếu chốt này thì:
    //   (1) bot nhắn "khách im lâu quá..." đúng lúc khách vừa nhắn — vô duyên;
    //   (2) tin nhắc lưu memory với createdAt MỚI HƠN mốc mở turn → nếu turn đó abort,
    //       deleteLastAssistantMessage tưởng là phantom và xoá mất tin KH đã đọc.
    const live = senders.get(senderId);
    if (live?.inflight || (live?.buffer.length ?? 0) > 0) {
      console.log(`[followup] skip ${senderId} — KH vừa nhắn lại / turn đang chạy`);
      return null;
    }

    // Admin tắt user này giữa chừng → không tự nhắc nữa.
    if (!(await isBotEnabled(senderId))) return null;

    const { mastra } = await import("../index");
    const { loadState } = await import("../lib/stateStore");
    const { buildPrefixWithMeta } = await import("../lib/prefixBuilder");
    const { cleanReply } = await import("../lib/cleanReply");
    const { fitnessAgent } = await import("../agents/fitness");
    const { giaiCoAgent } = await import("../agents/giaiCo");

    const state = await loadState(mastra, senderId, senderId);

    // Đã chốt (tên+SĐT+giờ) → không nhắc nữa.
    if (state.knownInfo.name && state.knownInfo.phone && state.knownInfo.preferredTime) return null;

    const agent = state.flow === "giai-co" ? giaiCoAgent : fitnessAgent;
    const { prefix } = buildPrefixWithMeta(state, "", state.lastBotReply);

    const nudgeTone =
      attempt === 0
        ? "nhắc hiện diện nhẹ, KHÔNG lặp lại câu hỏi/lời mời vừa gửi ở tin trước"
        : "nhắc thêm 1 lần, gợi 1 lý do/giá trị để khách quay lại, vẫn nhẹ nhàng";
    // Follow-up phải BIẾT lượt trước vừa làm gì — nếu đã gửi ảnh thì đừng re-announce/mời lại
    // (bug: bot gửi ảnh gym xong, 2p sau follow-up "em gửi mình xem khu tập trước..." → rời rạc, thô).
    const mediaNote = state.mediaShown
      ? `Em ĐÃ gửi ảnh ở lượt trước rồi, coi như khách đã xem: TUYỆT ĐỐI KHÔNG mời/nhắc/announce lại ảnh ("em gửi anh/chị xem..."), KHÔNG hỏi lại khu/loại ảnh nào, KHÔNG gọi tool gửi ảnh. Tiến thẳng bước kế của funnel. `
      : `KHÔNG gọi tool gửi ảnh/QR. `;
    const followupInstruction =
      `[FOLLOW-UP — khách CHƯA trả lời tin trước của em (im 1 lúc). CHỦ ĐỘNG nhắn 1 tin NGẮN kéo khách tiếp tục: ${nudgeTone}. ` +
      `⛔ QUAN TRỌNG: prefix/[VIỆC CẦN LÀM] bên dưới có thể bảo em HỎI 1 câu hoặc MỜI THỬ 1 buổi — nhưng nếu tin trước em ĐÃ hỏi đúng câu đó / ĐÃ mời thử mà khách chưa đáp, thì tin follow-up này TUYỆT ĐỐI KHÔNG hỏi lại, KHÔNG mời lại (kể cả đổi chữ diễn đạt) — lặp lại câu hỏi/lời mời nghe như bot, khách ngán. ` +
      `Cách đúng: 1 câu nhắc hiện diện ẤM + thêm 1 lý do/giá trị ngắn để khách muốn quay lại trả lời; KHÔNG xin lỗi vì nhắn lại, KHÔNG spam, KHÔNG ép chốt. ${mediaNote}` +
      `Kết "ạ".]`;

    // Prefix TRƯỚC (context/facts), chỉ thị FOLLOW-UP ĐẶT CUỐI để model đọc sau cùng →
    // ưu tiên cao hơn, không bị block pitch trong prefix "lấn" (bug: followup lặp mời-thử).
    //
    // ⚠ toolChoice="none": tin nhắc KHÔNG cần tool nào (media đã pre-fetch ở
    // scheduleFollowupWithMedia, QR chỉ gửi khi đã có contact). Trước đây để tool mở với
    // maxSteps=1 → memory bật workingMemory nên agent có tool updateWorkingMemory, model
    // tiêu đúng bước duy nhất vào tool call → vòng đó KHÔNG sinh text → res.text="" →
    // followup im lặng (log "generate trả rỗng"; repro: 8/8 lượt rỗng, vòng nào cũng
    // tools=[updateWorkingMemory] textLen=0). Cấm tool = model buộc phải viết chữ ngay
    // bước 1, và chỉ tốn 1 lượt LLM/lần nhắc. Cập nhật working memory ở đây cũng vô nghĩa —
    // khách chưa nói gì mới.
    // maxSteps=2 + gom text theo vòng (như brain.ts:runAgentTurn): lưới an toàn phòng khi
    // provider/adapter lờ toolChoice — vẫn còn 1 bước để ra chữ thay vì im lặng.
    let finalText = "";
    const res: any = await agent.generate(`${prefix}\n\n${followupInstruction}`, {
      maxSteps: 2,
      toolChoice: "none",
      modelSettings: { temperature: 0.7, topP: 0.95 },
      memory: { thread: { id: senderId }, resource: senderId, options: { lastMessages: 8 } },
      onIterationComplete: ({ text }: { text: string }) => {
        if (typeof text === "string" && text.trim()) finalText = text;
      },
    });

    // KH nhắn CHÈN trong lúc đang generate (generate mất ~5-15s) → vứt tin nhắc này, đừng gửi:
    // khách vừa nói mà bot lại nhắc "im lâu quá" thì vô duyên, và turn thật sắp trả lời rồi.
    // Vứt ở đây cũng khiến message vừa lưu thành phantom ĐÚNG NGHĨA (KH chưa hề đọc) → nếu
    // turn đó abort, deleteLastAssistantMessage dọn nó là chính xác, không phải xoá nhầm.
    const liveAfter = senders.get(senderId);
    if (liveAfter?.inflight || (liveAfter?.buffer.length ?? 0) > 0) {
      console.log(`[followup] huỷ ${senderId} — KH nhắn chèn trong lúc đang soạn tin nhắc`);
      return null;
    }

    const raw = finalText || res?.text || "";
    const cleaned = cleanReply(
      raw,
      false,
      state.lastBotReply ?? "",
      "",
      state.recentBotReplies ?? [],
    );
    if (!(cleaned && cleaned.trim().length >= 5)) {
      // Phân biệt rõ 2 ca để lần sau soi log biết ngay: model không nói gì, hay cleanReply nuốt.
      console.warn(
        `[followup] ${senderId} bỏ lượt — model trả ${raw.trim().length} ký tự, sau cleanReply còn ${(cleaned ?? "").trim().length}`,
      );
      return null;
    }
    return cleaned;
  } catch (e) {
    console.error("[followup] generateFollowupReply failed:", e);
    return null;
  }
}

// ─────────────────────────────────────────────
// CANCEL-AND-RESTART CORE
// ─────────────────────────────────────────────

function enqueueMessage(senderId: string, text: string) {
  // Khách vừa nhắn → cancel follow-up timer (nếu có).
  cancelFollowup(senderId);

  const state = ensureSender(senderId);
  state.buffer.push(text);

  // Có turn đang chạy + CHƯA commit → abort. Turn đó sẽ catch AbortError và prepend
  // consumed messages về buffer. Tin mới (vừa push) ở phía sau → combined batch đúng thứ tự.
  // Đã committed (reply 1 đã ra ngoài) → KHÔNG abort, chỉ buffer + đợi flush kế tiếp.
  // Lý do: hủy commit phase = reply 1 lộ ra nhưng state/sheets dở dang → corrupt context.
  if (state.inflight && !state.committed) {
    console.log(`[fb] aborting inflight turn for ${senderId} — new msg arrived (pre-commit)`);
    state.inflight.abort();
  } else if (state.inflight && state.committed) {
    console.log(`[fb] buffering for ${senderId} — turn already committed, will flush next`);
  }

  // Typing indicator để KH thấy bot "đọc" → giảm cảm giác lag khi đợi debounce.
  void sendTyping(senderId);

  // Debounce: reset mỗi lần có tin mới — chỉ flush khi KH dừng gõ.
  // Buffer mới chỉ là câu chào trống → giữ lâu hơn (OPENER_HOLD_MS) chờ câu hỏi thật,
  // tránh trả lời chào lẻ rồi tin nội dung thành turn 2.
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  const waitMs = looksIncompleteOpener(state.buffer.join("\n"))
    ? OPENER_HOLD_MS
    : DEBOUNCE_MS;
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void flush(senderId);
  }, waitMs);
}

async function flush(senderId: string) {
  const state = senders.get(senderId);
  if (!state || state.buffer.length === 0) return;

  // Defensive: nếu inflight chưa cleanup xong (abort catch chưa fire) — re-schedule.
  // Bình thường không xảy ra vì DEBOUNCE_MS đủ lâu cho abort propagate.
  if (state.inflight) {
    console.warn(`[fb] flush deferred for ${senderId} — inflight cleanup pending`);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void flush(senderId);
    }, 200);
    return;
  }

  // Snapshot + clear buffer: tin mới đến trong lúc xử lý sẽ append vào buffer mới,
  // tự động trigger abort flow ở enqueueMessage.
  const consumed = state.buffer;
  state.buffer = [];

  const combined = consumed.join("\n");
  console.log(
    `[fb] flush sender=${senderId} count=${consumed.length} text="${combined}"`,
  );

  const ac = new AbortController();
  state.inflight = ac;
  state.committed = false;
  // Mốc mở turn: mọi assistant msg CŨ HƠN mốc này là reply thật của turn trước (KH đã đọc)
  // → deleteLastAssistantMessage không được đụng vào. Lấy TRƯỚC handleMessage.
  const turnStartedAt = new Date();

  try {
    await handleMessage(senderId, combined, ac.signal, () => {
      // onCommit: gọi NGAY trước sendText reply 1 đầu tiên.
      // Sau đây, tin mới đến → KHÔNG abort (xem enqueueMessage).
      state.committed = true;
      console.log(`[fb] commit-point reached for ${senderId} — abort disabled for rest of turn`);
    });
  } catch (e) {
    if (ac.signal.aborted && !state.committed) {
      // Abort pre-commit: restore consumed messages về đầu buffer để turn sau gộp với tin mới.
      state.buffer = [...consumed, ...state.buffer];
      console.log(
        `[fb] turn aborted (pre-commit) for ${senderId} — re-queued ${consumed.length} msg (buffer=${state.buffer.length})`,
      );
      // Clean phantom assistant message nếu Mastra memory đã save ngầm trước khi abort.
      // Chỉ xoá message sinh TRONG turn này (>= turnStartedAt) — xem comment ở hàm.
      await deleteLastAssistantMessage(senderId, turnStartedAt);
    } else if (ac.signal.aborted && state.committed) {
      // Abort sau commit (rare race): reply 1 đã/đang gửi → KHÔNG restore consumed,
      // tin mới đã có trong buffer sẽ được flush turn sau như follow-up bình thường.
      console.warn(
        `[fb] turn aborted (post-commit) for ${senderId} — keeping committed reply, msg2 buffered for next turn`,
      );
    } else {
      console.error(`[fb] handleMessage error for ${senderId}:`, e);
      // Lỗi không-abort → drop consumed (không retry vô hạn) + báo KH.
      await sendText(
        senderId,
        "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!",
      );
    }
  } finally {
    state.inflight = null;
    state.committed = false;
    // Có tin mới (từ abort restore hoặc tin đến trong lúc xử lý) — schedule flush tiếp.
    if (state.buffer.length > 0 && !state.debounceTimer) {
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null;
        void flush(senderId);
      }, DEBOUNCE_MS);
    }
  }
}

/**
 * Sau khi abort, Mastra memory có thể đã save assistant msg ngầm trong agent.generate.
 * Xóa để turn replay không bị "nhớ" reply mà KH chưa thấy → tránh nhảy bước context.
 *
 * ⚠ CHỈ được xoá message SINH RA TRONG TURN BỊ ABORT. Trước đây hàm này xoá "assistant mới
 * nhất" vô điều kiện → khi turn abort chưa kịp save gì (abort sớm, thường gặp lúc KH nhắn
 * dồn), nạn nhân là REPLY THẬT của turn trước mà KH ĐÃ ĐỌC → memory thủng lỗ → bot quên
 * mình vừa nói gì → lặp lại câu hỏi/lời mời (soi log 11-13/07: mất 6 reply ở 2 luồng khách
 * nhắn dồn). turnStartedAt chặn đúng việc đó: message cũ hơn mốc này là của turn TRƯỚC → tha.
 * createdAt do chính process này set (Mastra dùng new Date()) → cùng đồng hồ, so sánh an toàn.
 * Best-effort.
 */
async function deleteLastAssistantMessage(senderId: string, turnStartedAt: Date) {
  try {
    const result = await memory.recall({
      threadId: senderId,
      resourceId: senderId,
      perPage: 5,
      orderBy: { field: "createdAt", direction: "DESC" },
    });
    const lastAssistant = result.messages.find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    const createdAt = (lastAssistant as { createdAt?: string | Date }).createdAt;
    const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
    // Không đọc được createdAt → KHÔNG xoá. Giữ nhầm 1 phantom (bot nhớ dư 1 câu) vô hại
    // hơn nhiều so với xoá nhầm reply thật (bot quên câu KH đã đọc).
    if (!Number.isFinite(createdMs)) {
      console.warn(
        `[fb] skip delete for ${senderId} — assistant msg id=${lastAssistant.id} thiếu createdAt, không xác định được của turn nào`,
      );
      return;
    }
    if (createdMs < turnStartedAt.getTime()) {
      console.log(
        `[fb] skip delete for ${senderId} — assistant msg id=${lastAssistant.id} là reply THẬT của turn trước (KH đã đọc), không phải phantom`,
      );
      return;
    }

    await memory.deleteMessages([lastAssistant.id]);
    console.log(
      `[fb] deleted phantom assistant msg id=${lastAssistant.id} for ${senderId}`,
    );
  } catch (e) {
    console.warn(
      `[fb] deleteLastAssistantMessage failed for ${senderId} (best-effort, ignore):`,
      e,
    );
  }
}

async function sendTyping(recipientId: string) {
  try {
    await fetch(`${GRAPH_API}?access_token=${FB_PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: "typing_on",
      }),
    });
  } catch (e) {
    // Lỗi typing không quan trọng — bot vẫn reply bình thường
    console.warn("[fb] typing_on failed:", e);
  }
}

async function handleMessage(
  senderId: string,
  text: string,
  abortSignal: AbortSignal,
  onCommit: () => void,
) {
  // SAU CHỐT: KHÔNG còn khóa chat. Đơn đã chốt (sheetsWritten=true) → workflow tự chuyển
  // sang stage "retention" (concierge sau chốt) để bot vẫn trả lời tự nhiên, nhận đặt thêm.
  // Việc ghi Sheets dedup theo bookingSignature nên chat tiếp KHÔNG ghi trùng đơn.
  const { mastra } = await import("../index");
  const { tryWriteLeadIfReady } = await import("../lib/stateStore");

  // ═══════ ENGINE SWITCH ═══════
  // ENGINE=agent → bộ não mới (engine/brain.ts, gọn ~1 file). Mặc định = legacy routerWorkflow
  // (phao rollback tức thời). Cả 2 nhánh trả CÙNG shape { reply, mediaUrls, qrUrl } → phần
  // humanize/gửi-media/ghi-Sheets/followup BÊN DƯỚI chạy y nguyên, không đụng.
  let output: { reply: string; mediaUrls: string[] | null; qrUrl: string | null } | undefined;

  if (process.env.ENGINE === "agent") {
    const { runAgentTurn } = await import("../engine/brain");
    try {
      output = await runAgentTurn({
        mastra,
        message:    text,
        threadId:   senderId,
        resourceId: senderId,
        abortSignal, // brain tự honor abortSignal (không cần workflow.cancel)
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      console.error("[fb] agent engine failed:", (e as Error)?.message);
      await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
      return;
    }
  } else {
    const run = await routerWorkflow.createRun();

    // Khi external abort → cancel workflow run. Mastra propagate abortSignal vào step execute params.
    const onAbort = () => {
      console.log(`[fb] forwarding abort → workflow.cancel for ${senderId}`);
      void run.cancel();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });

    let result;
    try {
      result = await run.start({
        inputData: {
          message:    text,
          threadId:   senderId,
          resourceId: senderId,
        },
      });
    } finally {
      abortSignal.removeEventListener("abort", onAbort);
    }

    if (result.status !== "success") {
      console.error("[fb] workflow failed:", result.status);
      await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
      return;
    }

    const steps = result.steps as any;
    output = steps?.["call-fitness"]?.output
          ?? steps?.["call-giai-co"]?.output
          ?? steps?.["fallback"]?.output;
  }

  // Nếu signal aborted ngay sau khi engine trả về (race) — coi như stale, drop.
  if (abortSignal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }

  if (!output?.reply) {
    console.error("[fb] no output found");
    return;
  }

  let { reply, mediaUrls, qrUrl } = output as {
    reply:     string;
    mediaUrls: string[] | null;
    qrUrl:     string | null;
  };

  reply = reply
    .replace(/!\[.*?\]\(.*?\)/g, "")              // xóa ![](url) kể cả url rỗng
    .replace(/\d+\.\s*\[.*?\]\(.*?\)\s*/g, "")   // xóa "4. [text](url)"
    .replace(/\[.*?\]\(.*?\)/g, "")               // xóa [text](url) còn sót
    .replace(/https?:\/\/[^\s\)"]+/g, "")         // xóa URL thuần
    .replace(/\n{3,}/g, "\n\n")                   // clean khoảng trắng thừa
    .trim();

  console.log(`[fb] sending reply: "${reply}"`);
  console.log(`[fb] mediaUrls: ${JSON.stringify(mediaUrls)}`);

  // Defense: abort race ngay trước khi gửi → discard.
  if (abortSignal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }

  // ═══════ COMMIT-POINT ═══════
  // Từ đây trở đi, mọi tin mới đến → KHÔNG abort turn này (xem enqueueMessage).
  // Lý do: reply 1 đã/đang ra ngoài, hủy nửa chừng = corrupt context.
  onCommit();

  const sentUrls = new Set<string>();
  if (reply) {
    await sendReplyHumanized(senderId, reply);
  }
  if (mediaUrls?.length) {
    for (const rawUrl of mediaUrls) {
      const url = (rawUrl ?? "").trim();
      if (!url || sentUrls.has(url)) continue;
      sentUrls.add(url);
      await sendMedia(senderId, url);
    }
  }
  if (qrUrl) {
    const q = qrUrl.trim();
    if (q && !sentUrls.has(q)) await sendMedia(senderId, q);
  }

  // Sheets-write SAU sendText: đảm bảo chỉ ghi lead khi KH đã thấy reply chốt đơn.
  // Tránh turn abort ngẫu nhiên ghi sheets cho KH chưa thấy gì → order-lock sai.
  await tryWriteLeadIfReady(mastra, senderId, senderId);

  // Schedule follow-up sau 10p nếu khách ghost.
  // Skip nếu vừa gửi QR (= đã chốt đơn xong, không cần spam)
  if (!qrUrl) {
    void scheduleFollowupWithMedia(senderId);
  }
}

async function sendText(recipientId: string, text: string) {
  await callSendAPI({
    recipient: { id: recipientId },
    message:   { text },
  });
}

/**
 * Gửi "đang soạn tin…" (typing indicator) để khách thấy bot đang gõ — như người thật.
 * Typing indicator là phụ → lỗi KHÔNG được chặn việc gửi tin chính.
 */
async function sendTypingOn(recipientId: string) {
  try {
    await callSendAPI({
      recipient:     { id: recipientId },
      sender_action: "typing_on",
    });
  } catch (e) {
    console.warn("[fb] typing_on failed (bỏ qua):", (e as Error)?.message);
  }
}

/**
 * Gửi reply theo nhịp NGƯỜI THẬT: tách 2-3 bóng ngắn (splitIntoBubbles), mỗi bóng
 * có "đang soạn tin…" + độ trễ gõ tỉ lệ độ dài. Nội dung KHÔNG đổi 1 ký tự — chỉ
 * thay đổi CÁCH gửi. Tắt qua HUMANIZE_BUBBLES=0 / HUMANIZE_TYPING=0.
 */
async function sendReplyHumanized(recipientId: string, reply: string) {
  const bubbles = HUMANIZE_BUBBLES ? splitIntoBubbles(reply) : [reply];
  for (let i = 0; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    if (!bubble) continue;
    if (HUMANIZE_TYPING) {
      await sendTypingOn(recipientId);
      await sleep(typingDelayMs(bubble, i === 0));
    }
    await sendText(recipientId, bubble);
  }
}

const VIDEO_EXTS = /\.(mp4|mov|webm|avi)(\?.*)?$/i;

function isVideoUrl(url: string): boolean {
  // Check extension or encoded extension (e.g. %2Fvideo%2F...)
  return VIDEO_EXTS.test(url) || url.toLowerCase().includes("/video/");
}

async function sendMedia(recipientId: string, url: string) {
  const type = isVideoUrl(url) ? "video" : "image";
  // FB PHẢI tự tải file từ URL (Cloudinary) trước khi gửi cho khách — video .mov vài MB
  // dễ mất >15s. Cho video hạn rộng (60s) để hoàn tất trong 1 lần, khỏi rơi vào timeout.
  await callSendAPI(
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type,
          payload: { url, is_reusable: true },
        },
      },
    },
    { timeoutMs: type === "video" ? 60000 : 30000 },
  );
}

async function callSendAPI(body: object, opts: { timeoutMs?: number } = {}) {
  console.log("[fb] callSendAPI:", JSON.stringify(body));

  const timeoutMs = opts.timeoutMs ?? 15000;
  const MAX_ATTEMPTS = 3;
  // Status không nên retry: 4xx (bad request) trừ 408 (timeout) và 429 (rate limit).
  const isRetriableStatus = (s: number) =>
    s === 408 || s === 429 || s >= 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(
        `${GRAPH_API}?access_token=${FB_PAGE_ACCESS_TOKEN}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      clearTimeout(timeout);

      const responseText = await res.text();
      if (res.ok) {
        console.log(`[fb] Graph API ok ${res.status} (attempt ${attempt}):`, responseText);
        return;
      }

      console.error(
        `[fb] Graph API error ${res.status} (attempt ${attempt}):`,
        responseText,
      );

      if (!isRetriableStatus(res.status) || attempt === MAX_ATTEMPTS) return;
    } catch (e) {
      clearTimeout(timeout);
      // ⚠️ TIMEOUT phía client (AbortError) = KẾT QUẢ KHÔNG XÁC ĐỊNH, KHÔNG phải lỗi.
      // Khi ta ngừng chờ response, FB CÓ THỂ đã nhận request + đã gửi tin cho khách rồi.
      // Retry lúc này = gửi TRÙNG (send không idempotent) — chính là bug "1 video gửi 3 lần
      // liền nhau" (video tải lâu >15s → abort → retry MAX_ATTEMPTS lần → FB gửi đủ 3 lần).
      // → Gặp abort thì DỪNG, coi như đã gửi. Chỉ retry lỗi mạng thật (request chưa tới FB).
      const isAbort = (e as Error)?.name === "AbortError";
      if (isAbort) {
        console.warn(
          `[fb] callSendAPI timeout sau ${timeoutMs}ms (attempt ${attempt}) — coi như ĐÃ gửi, KHÔNG retry (tránh trùng)`,
        );
        return;
      }
      console.error(`[fb] fetch exception (attempt ${attempt}):`, e);
      if (attempt === MAX_ATTEMPTS) return;
    }

    // Exponential backoff: 500ms → 1500ms → 3500ms (jitter nhỏ).
    const delay = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, delay));
  }
}

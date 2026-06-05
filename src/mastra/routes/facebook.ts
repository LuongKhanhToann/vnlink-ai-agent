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
import { memory } from "../config/memory";
import "dotenv/config";

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

// Debounce: chờ KH dừng gõ trước khi flush. Tin mới trong window này → reset timer.
// 2s default. Override qua FB_DEBOUNCE_MS.
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS ?? "2000");

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
      if (!event.message?.text || event.message?.is_echo) continue;

      const senderId = event.sender.id as string;
      const text     = event.message.text as string;

      console.log(`[fb] from=${senderId} text="${text}"`);

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

    const state = await loadState(mastra, senderId, "facebook-customer");

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
      state,
      {
        sendText: (text) => sendText(senderId, text),
        sendMedia: (url) => sendMedia(senderId, url),
      },
      mediaUrls,
    );
  } catch (e) {
    console.error("[followup] scheduleFollowupWithMedia failed:", e);
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

  // Debounce: reset mỗi lần có tin mới — chỉ flush khi KH dừng gõ DEBOUNCE_MS.
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void flush(senderId);
  }, DEBOUNCE_MS);
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
      await deleteLastAssistantMessage(senderId);
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
 * Best-effort.
 */
async function deleteLastAssistantMessage(senderId: string) {
  try {
    const result = await memory.recall({
      threadId: senderId,
      resourceId: "facebook-customer",
      perPage: 5,
      orderBy: { field: "createdAt", direction: "DESC" },
    });
    const lastAssistant = result.messages.find((m) => m.role === "assistant");
    if (lastAssistant) {
      await memory.deleteMessages([lastAssistant.id]);
      console.log(
        `[fb] deleted phantom assistant msg id=${lastAssistant.id} for ${senderId}`,
      );
    }
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
        resourceId: "facebook-customer",
      },
    });
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }

  // Nếu signal aborted ngay sau khi workflow trả về (race) — coi như stale, drop.
  if (abortSignal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }

  if (result.status !== "success") {
    console.error("[fb] workflow failed:", result.status);
    await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
    return;
  }

  const steps = result.steps as any;
  const output = steps?.["call-fitness"]?.output
              ?? steps?.["call-giai-co"]?.output
              ?? steps?.["fallback"]?.output;

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
    await sendText(senderId, reply);
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
  await tryWriteLeadIfReady(mastra, senderId, "facebook-customer");

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

const VIDEO_EXTS = /\.(mp4|mov|webm|avi)(\?.*)?$/i;

function isVideoUrl(url: string): boolean {
  // Check extension or encoded extension (e.g. %2Fvideo%2F...)
  return VIDEO_EXTS.test(url) || url.toLowerCase().includes("/video/");
}

async function sendMedia(recipientId: string, url: string) {
  const type = isVideoUrl(url) ? "video" : "image";
  await callSendAPI({
    recipient: { id: recipientId },
    message: {
      attachment: {
        type,
        payload: { url, is_reusable: true },
      },
    },
  });
}

async function callSendAPI(body: object) {
  console.log("[fb] callSendAPI:", JSON.stringify(body));

  const MAX_ATTEMPTS = 3;
  // Status không nên retry: 4xx (bad request) trừ 408 (timeout) và 429 (rate limit).
  const isRetriableStatus = (s: number) =>
    s === 408 || s === 429 || s >= 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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
      console.error(`[fb] fetch exception (attempt ${attempt}):`, e);
      if (attempt === MAX_ATTEMPTS) return;
    }

    // Exponential backoff: 500ms → 1500ms → 3500ms (jitter nhỏ).
    const delay = 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
    await new Promise((r) => setTimeout(r, delay));
  }
}

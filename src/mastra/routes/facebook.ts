/**
 * routes/facebook.ts
 */

import { Hono } from "hono";
import { routerWorkflow } from "../workflows/routerWorkflow";
import { scheduleFollowup, cancelFollowup } from "../lib/followup";
import { memory } from "../config/memory";
import "dotenv/config";

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

// Debounce: gom các tin gõ liên tiếp trong DEBOUNCE_MS thành 1 turn (chỉ tiết kiệm token).
// Race-condition triệt để KHÔNG dựa vào timer này — dựa generation counter ở dưới.
// 2s default: đủ ôm tin gõ thật nhanh. Override qua env FB_DEBOUNCE_MS.
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS ?? "2000");

type PendingEntry = { texts: string[]; timer: NodeJS.Timeout | null };
const pending = new Map<string, PendingEntry>();

// Serialize: đảm bảo 1 senderId tại 1 thời điểm chỉ có 1 handleMessage chạy →
// tránh race khi load/save state trong workflow.
const queues = new Map<string, Promise<unknown>>();

// Processing flag: khi bot đang xử lý turn của senderId, tin mới đến KHÔNG flush ngay
// (tránh tạo turn parallel với state đã commit) — chỉ append vào pending, đợi xong rồi
// re-debounce.
const processing = new Set<string>();

// ─────────────────────────────────────────────
// GENERATION COUNTER — anti-stale-reply
// ─────────────────────────────────────────────
// Pattern: mỗi tin từ KH bump seq[senderId]. handleMessage capture seq lúc bắt đầu
// chạy LLM. Trước khi sendText → check seq còn match không. Nếu không (KH đã gõ tin
// mới khi bot đang chạy LLM) → DROP reply, KHÔNG gửi. Tin mới sẽ tự trigger turn
// tiếp theo và trả lời với context cập nhật.
//
// → Đảm bảo TRIỆT ĐỂ: chỉ tin cuối cùng của khách mới nhận reply, không có reply
//   "lạc đề" / reply trùng do race-condition.
const seq = new Map<string, number>();

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

function enqueueMessage(senderId: string, text: string) {
  // Khách vừa nhắn → cancel follow-up timer (nếu có) vì khách đang active
  cancelFollowup(senderId);

  // Bump generation: invalidate mọi handleMessage đang chạy cho senderId này.
  // Reply từ turn trước (nếu LLM còn đang chạy) sẽ bị stale-drop trước khi gửi.
  seq.set(senderId, (seq.get(senderId) ?? 0) + 1);

  // Hiện "..." typing indicator để khách biết bot đang đọc → giảm cảm giác lag
  // khi debounce wait. Typing tự tắt sau 20s hoặc khi gửi message.
  void sendTyping(senderId);

  const isProcessing = processing.has(senderId);
  const existing = pending.get(senderId);

  if (existing) {
    existing.texts.push(text);
    if (existing.timer) clearTimeout(existing.timer);
    // Đang xử lý turn cũ → KHÔNG schedule timer, đợi finalize xong sẽ tự re-debounce.
    existing.timer = isProcessing
      ? null
      : setTimeout(() => flush(senderId), DEBOUNCE_MS);
    return;
  }

  pending.set(senderId, {
    texts: [text],
    timer: isProcessing
      ? null
      : setTimeout(() => flush(senderId), DEBOUNCE_MS),
  });
}

/**
 * Sau khi drop stale reply, xóa luôn assistant message đã save ngầm vào memory.
 * Tránh case bot nội bộ thấy "đã reply" rồi mà KH chưa thấy → nhảy bước context.
 *
 * Logic: recall 5 message gần nhất → tìm assistant msg mới nhất → delete by id.
 * Best-effort: nếu lỗi cũng KHÔNG raise (memory dirty 1 entry vẫn workable, không crash flow).
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
        `[fb] deleted stale assistant msg id=${lastAssistant.id} for ${senderId}`,
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

function flush(senderId: string) {
  const entry = pending.get(senderId);
  if (!entry) return;
  pending.delete(senderId);

  const combined = entry.texts.join("\n");
  console.log(
    `[fb] flush sender=${senderId} count=${entry.texts.length} text="${combined}"`,
  );

  processing.add(senderId);

  const prev = queues.get(senderId) ?? Promise.resolve();
  const next = prev
    .then(() => handleMessage(senderId, combined))
    .catch((e) => console.error("[fb] handleMessage error:", e))
    .finally(() => {
      processing.delete(senderId);
      // Trong lúc xử lý, có tin nhắn mới đến → đã append vào pending nhưng chưa
      // có timer (đang processing). Giờ kích hoạt debounce timer để flush turn tiếp.
      const next = pending.get(senderId);
      if (next && !next.timer) {
        next.timer = setTimeout(() => flush(senderId), DEBOUNCE_MS);
      }
    });

  queues.set(senderId, next);
  void next.finally(() => {
    if (queues.get(senderId) === next) queues.delete(senderId);
  });
}

async function handleMessage(senderId: string, text: string) {
  // Capture seq tại thời điểm bắt đầu chạy. Nếu seq tăng (KH gõ tin mới) trong lúc
  // workflow chạy → reply này stale, drop trước khi gửi.
  const mySeq = seq.get(senderId) ?? 0;
  const isStale = () => (seq.get(senderId) ?? 0) !== mySeq;

  try {
    const run = await routerWorkflow.createRun();

    const result = await run.start({
      inputData: {
        message:    text,
        threadId:   senderId,
        resourceId: "facebook-customer",
      },
    });

    // Sau khi workflow xong (LLM đã chạy, state đã save), check stale.
    // State save vẫn OK — tin mới sẽ load state đó (slot extracted từ tin này) + extract thêm.
    if (isStale()) {
      console.log(
        `[fb] DROP stale reply for ${senderId} (seq ${mySeq} → ${seq.get(senderId)}) — KH đã gõ tin mới`,
      );
      await deleteLastAssistantMessage(senderId);
      return;
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

    // Stale-check lần cuối ngay trước khi gửi (defense — KH có thể gõ tin mới
    // trong khoảng vài ms giữa "workflow xong" và "sendText").
    if (isStale()) {
      console.log(`[fb] DROP stale reply (race lúc sendText) for ${senderId}`);
      await deleteLastAssistantMessage(senderId);
      return;
    }

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

    // Schedule follow-up sau 10p nếu khách ghost.
    // Skip nếu vừa gửi QR (= đã chốt đơn xong, không cần spam)
    if (!qrUrl) {
      void scheduleFollowupWithMedia(senderId);
    }
  } catch (e) {
    console.error("[fb] workflow error:", e);
    await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
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
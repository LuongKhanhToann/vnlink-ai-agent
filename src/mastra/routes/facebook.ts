/**
 * routes/facebook.ts
 */

import { Hono } from "hono";
import { routerWorkflow } from "../workflows/routerWorkflow";
import { scheduleFollowup, cancelFollowup } from "../lib/followup";
import "dotenv/config";

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

// Debounce: gom các tin liên tiếp của cùng 1 khách trong DEBOUNCE_MS thành 1 turn.
// Khách hay chia 1 ý thành nhiều tin nhỏ — bot trả lời 1 lần thay vì lủng củng nhiều lần.
// 5s default: đủ ôm 2-3 tin gõ rời. Override qua env FB_DEBOUNCE_MS.
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS ?? "5000");

type PendingEntry = { texts: string[]; timer: NodeJS.Timeout | null };
const pending = new Map<string, PendingEntry>();

// Serialize: đảm bảo 1 senderId tại 1 thời điểm chỉ có 1 handleMessage chạy →
// tránh race khi load/save state trong workflow.
const queues = new Map<string, Promise<unknown>>();

// Processing flag: khi bot đang xử lý turn của senderId, tin mới đến KHÔNG flush ngay
// (tránh tạo turn parallel với state đã commit) — chỉ append vào pending, đợi xong rồi
// re-debounce. Triệt để chống duplicate reply khi khách gõ tiếp giữa lúc bot đang nghĩ.
const processing = new Set<string>();

// Anti-duplicate guard: cache reply gần nhất gửi cho senderId. Nếu turn sau sinh ra reply
// giống y → skip gửi (defensive, fallback cuối khi processing flag không kịp).
const lastReply = new Map<string, { text: string; ts: number }>();
const DUPLICATE_WINDOW_MS = 30_000;

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
  try {
    const run = await routerWorkflow.createRun();

    const result = await run.start({
      inputData: {
        message:    text,
        threadId:   senderId,
        resourceId: "facebook-customer",
      },
    });

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

    // Last line of defense: trim + dedup. Workflow đã cap nhưng giữ guard này
    // phòng follow-up / fallback path gửi list chưa làm sạch.
    const sentUrls = new Set<string>();
    if (reply) {
      // Anti-duplicate: skip nếu reply giống y reply gần nhất (<30s) — chống case
      // 2 turn liên tiếp cùng sinh ra confirmation y nhau (vd khách gửi 2 tin chốt liên tiếp).
      const last = lastReply.get(senderId);
      const isDup =
        last &&
        last.text === reply &&
        Date.now() - last.ts < DUPLICATE_WINDOW_MS;
      if (isDup) {
        console.log(`[fb] skip duplicate reply (matches last sent ${Date.now() - last.ts}ms ago)`);
      } else {
        await sendText(senderId, reply);
        lastReply.set(senderId, { text: reply, ts: Date.now() });
      }
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
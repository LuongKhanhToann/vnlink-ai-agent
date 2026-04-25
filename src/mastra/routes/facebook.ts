/**
 * routes/facebook.ts
 */

import { Hono } from "hono";
import { routerWorkflow } from "../workflows/routerWorkflow";
import "dotenv/config";

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

// Debounce: gom các tin liên tiếp của cùng 1 khách trong DEBOUNCE_MS thành 1 turn.
// Khách hay chia 1 ý thành nhiều tin nhỏ — bot trả lời 1 lần thay vì lủng củng nhiều lần.
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS ?? "2000");

type PendingEntry = { texts: string[]; timer: NodeJS.Timeout };
const pending = new Map<string, PendingEntry>();

// Serialize: đảm bảo 1 senderId tại 1 thời điểm chỉ có 1 handleMessage chạy →
// tránh race khi load/save state trong workflow.
const queues = new Map<string, Promise<unknown>>();

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

function enqueueMessage(senderId: string, text: string) {
  const existing = pending.get(senderId);
  if (existing) {
    existing.texts.push(text);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flush(senderId), DEBOUNCE_MS);
    return;
  }
  pending.set(senderId, {
    texts: [text],
    timer: setTimeout(() => flush(senderId), DEBOUNCE_MS),
  });
}

function flush(senderId: string) {
  const entry = pending.get(senderId);
  if (!entry) return;
  pending.delete(senderId);

  const combined = entry.texts.join("\n");
  console.log(
    `[fb] flush sender=${senderId} count=${entry.texts.length} text="${combined}"`,
  );

  const prev = queues.get(senderId) ?? Promise.resolve();
  const next = prev
    .then(() => handleMessage(senderId, combined))
    .catch((e) => console.error("[fb] handleMessage error:", e));

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

    if (reply)             await sendText(senderId, reply);
    if (mediaUrls?.length) for (const url of mediaUrls) await sendMedia(senderId, url);
    if (qrUrl)             await sendMedia(senderId, qrUrl);

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
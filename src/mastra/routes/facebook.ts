/**
 * routes/facebook.ts — Webhook Facebook Messenger cho luồng RAG mới (slim).
 *
 * Giữ đúng ĐƯỜNG ỐNG cũ, bỏ logic hội thoại cũ:
 *   - GET  /webhook : verify challenge (FB_VERIFY_TOKEN).
 *   - POST /webhook : parse messaging[], bỏ echo, bỏ tin không phải text; ghi nhận user cho admin;
 *                     cổng bật/tắt AI (botControl); debounce gộp tin bắn liền → gọi engine/brain.
 *   - Gửi lại qua Send API: sendText (tách 1-3 bóng ngắn + typing), sendMedia. callSendAPI KHÔNG
 *     retry khi client-timeout (tránh gửi trùng).
 */

import { Hono } from "hono";
import "dotenv/config";
import { recordUserActivity, isBotEnabled } from "../lib/botControl";
import { runTurn } from "../engine/brain";
import { loadConfig } from "../lib/settings";

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN ?? "";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN ?? "";
const GRAPH_API = "https://graph.facebook.com/v19.0/me/messages";
const DEBOUNCE_MS = Number(process.env.FB_DEBOUNCE_MS || 2000);

export const facebookWebhook = new Hono();

facebookWebhook.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("[fb] webhook verified");
    return c.text(challenge ?? "");
  }
  return c.text("Forbidden", 403);
});

facebookWebhook.post("/webhook", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || body.object !== "page") return c.text("NOT_PAGE", 404);

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const msg = event.message;
      if (!msg || msg.is_echo || !msg.text) continue; // bỏ echo + tin không text

      const senderId = event.sender?.id as string | undefined;
      const text = msg.text as string;
      if (!senderId) continue;

      console.log(`[fb] from=${senderId} text="${text}"`);
      void recordUserActivity(senderId); // để admin thấy danh sách khách

      if (!(await isBotEnabled(senderId))) {
        console.log(`[fb] AI tắt cho ${senderId} → bỏ qua`);
        continue;
      }
      enqueue(senderId, text);
    }
  }
  return c.text("EVENT_RECEIVED");
});

// ── Debounce: gộp các tin khách bắn liền nhau trong DEBOUNCE_MS thành 1 lượt ──
type Pending = { texts: string[]; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const inFlight = new Map<string, AbortController>();

function enqueue(senderId: string, text: string): void {
  // Đang xử lý lượt trước cho user này → huỷ để tin mới nhất được trả (cancel-and-restart).
  const running = inFlight.get(senderId);
  if (running) running.abort();

  const p = pending.get(senderId);
  if (p) {
    p.texts.push(text);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flush(senderId), DEBOUNCE_MS);
  } else {
    pending.set(senderId, { texts: [text], timer: setTimeout(() => flush(senderId), DEBOUNCE_MS) });
  }
}

async function flush(senderId: string): Promise<void> {
  const p = pending.get(senderId);
  if (!p) return;
  pending.delete(senderId);
  const message = p.texts.join("\n").trim();
  if (!message) return;

  const ctrl = new AbortController();
  inFlight.set(senderId, ctrl);
  try {
    await sendTypingOn(senderId);
    const { reply } = await runTurn({ senderId, message, abortSignal: ctrl.signal });
    if (ctrl.signal.aborted) return; // tin mới hơn đã tới → bỏ reply cũ
    await sendReply(senderId, reply);
  } catch (e) {
    if ((e as Error)?.name === "AbortError" || ctrl.signal.aborted) return;
    console.error(`[fb] engine lỗi cho ${senderId} → im lặng:`, (e as Error)?.message);
  } finally {
    if (inFlight.get(senderId) === ctrl) inFlight.delete(senderId);
  }
}

// ── Gửi tin ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tách câu trả thành 1-3 bóng ngắn theo đoạn (\n\n), giữ nguyên chữ. */
function splitBubbles(reply: string): string[] {
  const parts = reply
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return [reply.trim()];
  return parts.slice(0, 3);
}

/** Nhịp gõ giữa 2 bóng: random trong [min,max] (config admin) để giống người thật đang gõ. */
function humanTypingDelayMs(minMs: number, maxMs: number): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function sendReply(senderId: string, reply: string): Promise<void> {
  const clean = (reply ?? "").trim();
  if (!clean) return;
  const bubbles = splitBubbles(clean);
  // Nhịp gõ do admin cấu hình (đọc mỗi lượt, không cache). Lỗi → default trong loadConfig.
  const { bubbleDelayMinMs, bubbleDelayMaxMs } = await loadConfig();
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // Bật "đang nhập..." trong lúc chờ để cảm giác như người thật gõ tin kế tiếp.
      await sendTypingOn(senderId);
      await sleep(humanTypingDelayMs(bubbleDelayMinMs, bubbleDelayMaxMs));
    }
    await sendText(senderId, bubbles[i]);
  }
}

async function sendText(recipientId: string, text: string): Promise<void> {
  await callSendAPI({ recipient: { id: recipientId }, message: { text } });
}

async function sendTypingOn(recipientId: string): Promise<void> {
  try {
    await callSendAPI({ recipient: { id: recipientId }, sender_action: "typing_on" });
  } catch (e) {
    console.warn("[fb] typing_on lỗi (bỏ qua):", (e as Error)?.message);
  }
}

const VIDEO_EXTS = /\.(mp4|mov|webm|avi)(\?.*)?$/i;
function isVideoUrl(url: string): boolean {
  return VIDEO_EXTS.test(url) || url.toLowerCase().includes("/video/");
}

/** Gửi ảnh/video từ URL (Cloudinary). Giữ lại cho tương lai; luồng hiện tại chưa chủ động gửi media. */
export async function sendMedia(recipientId: string, url: string): Promise<void> {
  const type = isVideoUrl(url) ? "video" : "image";
  await callSendAPI(
    { recipient: { id: recipientId }, message: { attachment: { type, payload: { url, is_reusable: true } } } },
    { timeoutMs: type === "video" ? 60000 : 30000 },
  );
}

async function callSendAPI(body: object, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const MAX_ATTEMPTS = 3;
  const isRetriable = (s: number) => s === 408 || s === 429 || s >= 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${GRAPH_API}?access_token=${FB_PAGE_ACCESS_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const responseText = await res.text();
      if (res.ok) return;
      console.error(`[fb] Send API ${res.status} (lần ${attempt}):`, responseText.slice(0, 200));
      if (!isRetriable(res.status) || attempt === MAX_ATTEMPTS) return;
    } catch (e) {
      clearTimeout(timer);
      // Client-timeout = KHÔNG xác định (FB có thể đã gửi rồi) → KHÔNG retry để tránh gửi trùng.
      if ((e as Error)?.name === "AbortError") {
        console.warn(`[fb] Send API timeout ${timeoutMs}ms (lần ${attempt}) — coi như đã gửi, không retry`);
        return;
      }
      console.error(`[fb] Send API lỗi mạng (lần ${attempt}):`, (e as Error)?.message);
      if (attempt === MAX_ATTEMPTS) return;
      await sleep(500 * attempt);
    }
  }
}

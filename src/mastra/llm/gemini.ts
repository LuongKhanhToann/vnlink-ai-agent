/**
 * llm/gemini.ts — NƠI DUY NHẤT gọi model sinh chữ trong luồng mới (Google AI Studio / Gemini).
 *
 * Cơ chế theo yêu cầu:
 *   - CASCADE model mạnh→yếu: thử model[0] trước; cạn quota (mọi key 429/403) mới rớt model kế.
 *   - XOAY 3 KEY: mỗi model thử lần lượt các key; điểm bắt đầu round-robin lệch mỗi lượt để
 *     tải rải đều 3 key, không dồn hết vào key #1.
 *   - Model "sàn" gemma-4-31b-it có quota ngày rất lớn → gần như không bao giờ cạn hẳn.
 * Hết sạch lưới (mọi model × mọi key) → ném lỗi để webhook nuốt (bot im lượt đó). KHÔNG cache.
 */

import "dotenv/config";

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

/** Đọc env LÚC GỌI (không lúc import) — harness nạp .env sau khi hoist import. */
export function geminiKeys(): string[] {
  return (process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Cascade mặc định: 3.6-flash (mạnh) → 3.1-flash-lite → flash-lite-latest → gemma-4-31b-it (sàn).
 *  (Đã bỏ gemini-2.5-flash-lite: API trả 404 "no longer available to new users".) */
export function chatModels(): string[] {
  const raw = process.env.GEMINI_CHAT_MODELS || process.env.GEMINI_CHAT_MODEL || "";
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length
    ? models
    : ["gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemma-4-31b-it"];
}

/** Cascade NHẸ cho call phụ (rewrite/rerank/contextualize): flash-lite trước cho nhanh, gemma sàn đỡ lưng.
 *  Trả lời khách vẫn dùng chatModels() mạnh hơn. Override bằng GEMINI_FAST_MODELS. */
export function fastModels(): string[] {
  const raw = process.env.GEMINI_FAST_MODELS || "";
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length ? models : ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemma-4-31b-it"];
}

const TIMEOUT_MS = 60_000;
const MAX_TRANSIENT_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
/**
 * Reserve token cho "thinking". ĐO THẬT: gemini-3.6-flash & gemma-4-31b là thinking-model BẮT BUỘC
 * (không tắt được — gửi thinkingConfig.thinkingBudget:0 bị 400), reasoning ăn CHUNG maxOutputTokens
 * với câu trả (thấy tiêu 487-552 token/lượt) → nếu maxOutputTokens = đúng answer budget thì thinking
 * ngốn sạch, câu trả cụt/rỗng. Cấp thêm 1800 token cho MỌI model: flash-lite không thinking (thoughts=0)
 * nên STOP sớm, thừa reserve vô hại; flash/gemma dùng tới. KHÔNG gửi thinkingConfig (một số model 400).
 */
const THINKING_RESERVE = 1_800;

/** Round-robin điểm bắt đầu key — rải tải đều 3 key giữa các lượt. */
let keyCursor = 0;

/** Key cạn rate-limit/quota (429/403) → xoay key kế. */
class KeyExhaustedError extends Error {}
/** Request sai (400/404 model…) hoặc câu trả rỗng → bỏ model này, sang model kế. */
class BadModelError extends Error {}
const TRANSIENT_STATUS = [500, 502, 503, 504];

function combineSignals(external: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("gemini timeout")), ms);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener("abort", () => ctrl.abort(external.reason), { once: true });
  }
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/** Ghép part văn bản của candidate đầu; BỎ part thought:true (chain-of-thought của Gemma). */
function extractText(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p: any) => p?.thought !== true)
    .map((p: any) => p?.text ?? "")
    .join("")
    .trim();
}

function toRequestBody(messages: ChatMsg[], model: string, temperature: number, maxTokens: number) {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  // Reserve token thinking cho MỌI model (xem THINKING_RESERVE). model tham số giữ lại cho tương lai.
  void model;
  const maxOutputTokens = maxTokens + THINKING_RESERVE;
  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    generationConfig: { temperature, maxOutputTokens },
  };
}

async function generateOnce(
  model: string,
  key: string,
  body: Record<string, unknown>,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: combineSignals(abortSignal, TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 250);
    const msg = `gemini ${model} HTTP ${res.status}: ${detail}`;
    if (res.status === 429 || res.status === 403) throw new KeyExhaustedError(msg);
    if (TRANSIENT_STATUS.includes(res.status)) throw new Error(msg); // 5xx → thử lại cùng key
    throw new BadModelError(msg); // 400/404… → bỏ model
  }
  const text = extractText(await res.json());
  if (!text) throw new BadModelError(`gemini ${model} trả rỗng`);
  return text;
}

/**
 * Sinh câu trả lời qua lưới (model → key). MODEL-MAJOR: thử hết mọi key ở model trước rồi mới
 * rớt model kế. Điểm bắt đầu key xoay round-robin để rải tải 3 key. Ném lỗi khi cạn cả lưới.
 */
export async function generateReply(
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number; abortSignal?: AbortSignal; models?: string[] } = {},
): Promise<string> {
  const keys = geminiKeys();
  if (!keys.length) throw new Error("Chưa cấu hình GEMINI_API_KEYS");
  // opts.models: cho phép các call PHỤ (rewrite/rerank/contextualize) ưu tiên model nhẹ→nhanh,
  // không dùng cascade nặng của luồng trả lời chính. Rỗng → cascade mặc định chatModels().
  const models = opts.models?.length ? opts.models : chatModels();
  const temperature = opts.temperature ?? 0.6;
  const maxTokens = opts.maxTokens ?? 700;
  const start = keyCursor++ % keys.length; // xoay điểm bắt đầu mỗi lượt
  let lastError: Error = new Error("Không gọi được Gemini");

  for (const model of models) {
    const body = toRequestBody(messages, model, temperature, maxTokens);
    let modelTainted = false;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(start + i) % keys.length];
      for (let attempt = 0; attempt < MAX_TRANSIENT_ATTEMPTS; attempt++) {
        try {
          return await generateOnce(model, key, body, opts.abortSignal);
        } catch (e) {
          const err = e as Error;
          if (err?.name === "AbortError" || opts.abortSignal?.aborted) throw e;
          lastError = err;
          if (err instanceof KeyExhaustedError) {
            console.warn(`[gemini] ${model} key #${((start + i) % keys.length) + 1} cạn quota → xoay key`);
            break;
          }
          if (err instanceof BadModelError) {
            console.warn(`[gemini] ${model} lỗi/rỗng (${err.message.slice(0, 100)}) → bỏ model`);
            modelTainted = true;
            break;
          }
          if (attempt < MAX_TRANSIENT_ATTEMPTS - 1) {
            const wait = RETRY_BASE_MS * 2 ** attempt;
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          break;
        }
      }
      if (modelTainted) break;
    }
  }
  throw lastError;
}

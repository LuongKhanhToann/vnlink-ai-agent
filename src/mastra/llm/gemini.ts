/**
 * llm/gemini.ts — NƠI DUY NHẤT gọi model sinh chữ trong luồng mới (Google AI Studio / Gemini).
 *
 * Cơ chế:
 *   - CASCADE model xếp theo QUOTA×TỐC-ĐỘ (KHÔNG theo số phiên bản): flash-lite RPD-cao/ổn định
 *     dẫn đầu → flash cao-cấp RPD-20 làm tầng tràn → gemma-26b sàn RPD 14.4K. Xem chatModels().
 *   - XOAY N KEY (đọc từ GEMINI_API_KEYS): mỗi model thử lần lượt các key; điểm bắt đầu round-robin
 *     lệch mỗi lượt để rải tải đều, không dồn hết vào key #1. Mỗi model có quota RIÊNG per key.
 *   - Fail-nhanh khi 5xx quá tải (retry 1 lần backoff ngắn rồi cascade) để bot chat trả nhanh.
 * Hết sạch lưới (mọi model × mọi key) → ném lỗi để webhook nuốt (bot im lượt đó). KHÔNG cache.
 */

import "dotenv/config";
import { logAiCall } from "../lib/costLog";

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

/** Đọc env LÚC GỌI (không lúc import) — harness nạp .env sau khi hoist import. */
export function geminiKeys(): string[] {
  return (process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Cascade mặc định (model NGOÀI, key TRONG). XẾP THEO QUOTA×TỐC-ĐỘ, KHÔNG theo số phiên bản.
 *  Bài học 23/08: free-tier mỗi model có quota RIÊNG per key. Mấy flash "cao cấp" (3.7/3.6/3.5) chỉ
 *  RPM 5 + RPD **20/ngày/key** và 3.7 hay 503 quá tải → nếu để ĐẦU cascade thì vừa quá 20 lượt là
 *  mọi câu sau phải "đi bộ" xuống ladder (429/503 × nhiều key) ⇒ chậm 13-86s. Ngược lại flash-lite
 *  RPM 15 + **RPD 500** (gấp 25×) và ổn định. Nên DẪN ĐẦU bằng flash-lite, xếp flash cao-cấp làm
 *  tầng "chất lượng tràn" phía sau (hiếm chạm vì lite đã 500×số-key/ngày), gemma-26b làm sàn RPD 14.4K.
 *  Mỗi model có quota tách biệt nên xếp nhiều tầng = CỘNG DỒN capacity. ID nào key chưa mở sẽ trả 404
 *  → code bỏ qua TỨC THÌ (BadModelError, không retry), nên thêm 2.5-flash/2.5-flash-lite vô hại.
 *  Muốn ưu tiên CHẤT LƯỢNG hơn tốc độ: đặt GEMINI_CHAT_MODELS="gemini-3.7-flash,gemini-3.6-flash,..." */
export function chatModels(): string[] {
  const raw = process.env.GEMINI_CHAT_MODELS || process.env.GEMINI_CHAT_MODEL || "";
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length
    ? models
    : [
        "gemini-3.1-flash-lite", // RPM15 RPD500 — workhorse chính (nhanh, ít 503)
        "gemini-3.5-flash-lite", // RPM15 RPD500 — workhorse #2
        "gemini-flash-lite-latest", // alias lite mới nhất
        "gemini-3.7-flash", // RPD20 — tầng chất-lượng tràn (chỉ chạm khi lite cạn/hỏng)
        "gemini-3.6-flash", // RPD20
        "gemini-3.5-flash", // RPD20
        "gemini-2.5-flash", // RPD20 — thêm nếu key đã mở (404 thì bỏ qua tức thì)
        "gemini-2.5-flash-lite", // RPD20
        "gemma-4-26b-a4b-it", // RPD14.4K sàn (TPM16K → ~2 câu lớn/phút/key)
      ];
}

/** Cascade NHẸ cho call phụ (rewrite/rerank/contextualize): các flash-lite RPD-cao trước cho nhanh,
 *  gemma-4-26b-a4b-it sàn (RPD 14.4K) nuốt overflow lúc ingest hàng loạt. Override bằng GEMINI_FAST_MODELS. */
export function fastModels(): string[] {
  const raw = process.env.GEMINI_FAST_MODELS || "";
  const models = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return models.length
    ? models
    : [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-flash-lite-latest",
        "gemini-2.5-flash-lite", // +RPM10 RPD20 nếu key mở (404 → bỏ qua)
        "gemma-4-26b-a4b-it",
      ];
}

// Bot chat FB THẬT phải trả nhanh: chờ 60s là khách bỏ đi. Hạ trần chờ + fail-nhanh khi 5xx quá tải:
// thay vì retry 3 lần có backoff 1s→2s (tới ~15s/model rồi mới rớt — chính là nguồn 13-86s), chỉ thử
// lại 1 lần với backoff ngắn 400ms rồi CASCADE sang key/model kế (key/project khác có thể không quá tải).
const TIMEOUT_MS = 30_000;
const MAX_TRANSIENT_ATTEMPTS = 2;
const RETRY_BASE_MS = 400;
/**
 * Reserve token cho "thinking". ĐO THẬT: gemini-3.6-flash & gemma-4-31b là thinking-model BẮT BUỘC
 * (không tắt được — gửi thinkingConfig.thinkingBudget:0 bị 400), reasoning ăn CHUNG maxOutputTokens
 * với câu trả (thấy tiêu 487-552 token/lượt) → nếu maxOutputTokens = đúng answer budget thì thinking
 * ngốn sạch, câu trả cụt/rỗng. Cấp thêm 1800 token cho MỌI model: flash-lite không thinking (thoughts=0)
 * nên STOP sớm, thừa reserve vô hại; flash/gemma dùng tới. KHÔNG gửi thinkingConfig (một số model 400).
 */
const THINKING_RESERVE = 1_800;

/** Model dùng để TÍNH PHÍ trong nhật ký. Lưu lượng thấp + nhiều key nên gần như mọi lượt đều do
 *  gemini-3.7-flash (đầu cascade) trả; các model fallback hiếm khi chạm tới → gộp hết về 3.7 cho báo cáo gọn. */
const BILLING_MODEL = "gemini-3.7-flash";

/** Round-robin điểm bắt đầu key — rải tải đều 3 key giữa các lượt. */
let keyCursor = 0;

/** Key cạn rate-limit/quota (429/403) hoặc key CHẾT (401) → xoay key kế. */
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

/** Số token đã dùng (để ghi nhật ký chi phí). output = tất cả token sinh ra kể cả "thinking" (đều tính phí output). */
function extractUsage(payload: any): { promptTokens: number; outputTokens: number } {
  const u = payload?.usageMetadata ?? {};
  const prompt = Number(u.promptTokenCount) || 0;
  const total = Number(u.totalTokenCount) || 0;
  // output = tổng - prompt (gồm cả thoughtsTokenCount); fallback candidatesTokenCount nếu thiếu total.
  const output = total > prompt ? total - prompt : Number(u.candidatesTokenCount) || 0;
  return { promptTokens: prompt, outputTokens: output };
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
): Promise<{ text: string; promptTokens: number; outputTokens: number }> {
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
    // 401 = key/service-account CHẾT (token AQ. hết hạn, "bound service account disabled"): đây là
    // lỗi CỦA KEY, không phải của model → xoay key kế, KHÔNG bỏ model (bỏ model làm key chết giết
    // sạch cascade → bot im với khách). Giống 429/403 (key cạn quota). Xem embed.ts (đã vá 401 tương tự).
    if (res.status === 429 || res.status === 403 || res.status === 401) throw new KeyExhaustedError(msg);
    if (TRANSIENT_STATUS.includes(res.status)) throw new Error(msg); // 5xx → thử lại cùng key
    throw new BadModelError(msg); // 400/404… → bỏ model
  }
  const payload = await res.json();
  const text = extractText(payload);
  if (!text) throw new BadModelError(`gemini ${model} trả rỗng`);
  return { text, ...extractUsage(payload) };
}

/**
 * Sinh câu trả lời qua lưới (model → key). MODEL-MAJOR: thử hết mọi key ở model trước rồi mới
 * rớt model kế. Điểm bắt đầu key xoay round-robin để rải tải 3 key. Ném lỗi khi cạn cả lưới.
 */
export async function generateReply(
  messages: ChatMsg[],
  opts: {
    temperature?: number;
    maxTokens?: number;
    abortSignal?: AbortSignal;
    models?: string[];
    /** Nhãn mục đích để ghi nhật ký chi phí (VD "Trả lời khách"). Bỏ trống = không ghi log. */
    purpose?: string;
  } = {},
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
          const { text, promptTokens, outputTokens } = await generateOnce(model, key, body, opts.abortSignal);
          // Ghi nhật ký chi phí — fire-and-forget, tự nuốt lỗi, KHÔNG làm chậm câu trả lời.
          if (opts.purpose) void logAiCall({ purpose: opts.purpose, model: BILLING_MODEL, promptTokens, outputTokens });
          return text;
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

/**
 * Gọi model và PARSE JSON (cho L5 classifier / các call cần dữ liệu có cấu trúc).
 * Bóc rào ```json ... ``` nếu có, cắt từ dấu { đầu đến } cuối, JSON.parse. Lỗi bất kỳ (call lỗi,
 * parse lỗi) → trả null để nơi gọi tự FAIL-OPEN. Mặc định dùng fastModels() + temperature 0.
 */
export async function generateJson<T = unknown>(
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number; abortSignal?: AbortSignal; models?: string[]; purpose?: string } = {},
): Promise<T | null> {
  try {
    const raw = await generateReply(messages, {
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens ?? 400,
      models: opts.models ?? fastModels(),
      abortSignal: opts.abortSignal,
      purpose: opts.purpose,
    });
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    return JSON.parse(s.slice(a, b + 1)) as T;
  } catch (e) {
    console.warn("[gemini] generateJson fail → null:", (e as Error).message);
    return null;
  }
}

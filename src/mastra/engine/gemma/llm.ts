/**
 * llm.ts — lớp GỌI MODEL của nhánh gemma (ollama-compatible `/api/chatplus`).
 *
 * Tách khỏi pipeline.ts để phần "nhịp hội thoại" không lẫn với phần "nói chuyện với ollama":
 * cấu hình endpoint/model/key, timeout, retry mạng, và 2 kiểu gọi (văn bản / JSON schema).
 * Đây là NƠI DUY NHẤT trong nhánh gemma gọi fetch tới model.
 */

export interface LlmConfig {
  endpoint: string;
  model: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

/** num_ctx PHẢI giống nhau ở MỌI call — lệch là ollama reload model mỗi lượt (chậm 20-60s). */
const NUM_CTX = 16384;
const DEFAULT_TIMEOUT_MS = 180_000;

/** Đọc env LÚC GỌI, không phải lúc load module: import bị hoist nên harness nạp .env sau. */
export const defaultEndpoint = (): string =>
  process.env.GEMMA_ENDPOINT || "https://rhass-desktop.tail189c58.ts.net/gemma/api/chatplus";
export const defaultModel = (): string => process.env.GEMMA_MODEL || "gemma4:12b";
/** Proxy LLM trước ollama BẮT BUỘC `Authorization: Bearer <key>` — thiếu là 401. */
const apiKey = (): string => process.env.GEMMA_API_KEY || "";

// ── Google Gemini API (đường sinh chữ + phân loại HIỆN TẠI, thay gemma4:12b self-host) ──
// Có GEMINI_API_KEYS → callChat/callJson đi qua Gemini; để trống → rơi về ollama gemma4:12b
// ở dưới (giữ nguyên làm dự phòng). Nhiều key thử theo thứ tự, hết quota key này xoay key kế.
// Đọc env LÚC GỌI (không cache) — đúng luật "đọc trạng thái mới mỗi lượt".
const geminiApiKeys = (): string[] =>
  (process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
/**
 * Chuỗi model dự phòng, thử theo thứ tự (thử hết mọi key ở model trước rồi mới sang model sau).
 * Mặc định theo ĐO THẬT về tốc độ/ổn định (không phải theo cỡ tham số):
 *   1) gemini-flash-lite-latest — nhanh ~1s, KHÔNG thinking. Phục vụ đa số (500 RPD/key).
 *   2) gemma-4-26b-a4b-it — MoE, thought≈0 → nhanh ~3-4s, JSON ổn định. Tràn volume (14.4K RPD/key).
 * Hết cả lưới Gemini (mọi key cạn quota) → KHÔNG còn fallback: tắt công tắc AI tổng + dừng lượt.
 * ⚠ ĐÃ BỎ gemma-4-31b-it khỏi mặc định: đo trên prompt pipeline này nó thinking BẮT BUỘC nặng
 *   (1245-2338 token/lượt) → 37-68s. Muốn thêm lại (vd đo thấy nhanh với key riêng) chỉ cần
 *   nối vào GEMINI_CHAT_MODELS — code xử lý reserve/guard cho nó vẫn còn nguyên, không cần sửa.
 *   Kiểm tra tốc độ 1 model: npx tsx src/mastra/scripts/measureGeminiModel.ts <model-id>
 */
const geminiChatModels = (): string[] => {
  const models = (process.env.GEMINI_CHAT_MODELS || process.env.GEMINI_CHAT_MODEL || "gemini-flash-lite-latest,gemma-4-26b-a4b-it")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return models.length ? models : ["gemini-flash-lite-latest"];
};
/**
 * Gemma trên Gemini API là model THINKING BẮT BUỘC — KHÔNG tắt được: gửi
 * `thinkingConfig:{thinkingBudget:0}` bị API trả 400 "Thinking budget is not supported for this
 * model" (đo thật cả gemma-4-31b-it lẫn gemma-4-26b-a4b-it). Reasoning ăn CHUNG maxOutputTokens
 * với câu trả → phải cấp thêm token dự trữ, KHÔNG thì thinking ngốn sạch budget và câu trả RỖNG.
 * Sized từ ĐO THẬT trên prompt pipeline (system ~6-7k token): 31b classify tiêu ~1245 token
 * thinking MỖI LƯỢT, reply BIẾN THIÊN 1200→2338 (temp 0.3) — với reserve 800 (cỡ casca) thì
 * classify 0/4 ra JSON (đều MAX_TOKENS, rỗng). Đặt 2600 để phủ cả spike 2338 + chừa chỗ câu trả.
 * Thinking KHÔNG tăng theo ceiling (đo: 1245 token dù budget 1250 hay 2450) nên nới rộng an toàn,
 * chỉ chống bị cắt. 26b-a4b hầu như KHÔNG thinking (thought≈0) nên reserve này gần như vô hại với
 * nó; chỉ 31b mới ăn tới. Spike vượt 2600 (hiếm) → câu trả rỗng → guard ở geminiGenerateOnce bỏ
 * model, rớt xuống 5.4. */
const GEMMA_THINKING_RESERVE_TOKENS = 2600;
const GEMINI_TIMEOUT_MS = 60_000;
const GEMINI_MAX_ATTEMPTS = 3;
const GEMINI_RETRY_BASE_MS = 1_000;

export function resolveLlmConfig(opts: {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): LlmConfig {
  return {
    endpoint: opts.endpoint || defaultEndpoint(),
    model: opts.model || defaultModel(),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    abortSignal: opts.abortSignal,
  };
}

function combineSignals(external: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("gemma call timeout")), ms);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener("abort", () => ctrl.abort(external.reason), { once: true });
  }
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

export interface LlmResult {
  text: string;
  seconds: number;
}

/** 502/503/504 từ proxy = GPU đang bận/khởi động lại, không phải model từ chối → đáng thử lại. */
class TransientHttpError extends Error {}
const RETRY_STATUS = [502, 503, 504];

async function callOnce(body: Record<string, unknown>, cfg: LlmConfig): Promise<LlmResult> {
  const t0 = Date.now();
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
    },
    // keep_alive=-1: GHIM model resident VĨNH VIỄN trên GPU, không bao giờ unload. Lý do (27/07):
    // lane /chatplus từng tự unload rồi nạp lại đúng lúc GPU0 hết VRAM → ollama đẩy nguyên model
    // xuống CPU và kẹt lì (mỗi lượt ~59s → timeout → fallback 5.4). Ghim -1 = không unload = không
    // có "lần nạp lại" nào để lỡ rơi xuống CPU. (Trước để "24h": im >24h là unload, gặp lại rủi ro.)
    body: JSON.stringify({ model: cfg.model, stream: false, think: false, keep_alive: -1, ...body }),
    signal: combineSignals(cfg.abortSignal, cfg.timeoutMs),
  });
  if (!res.ok) {
    const msg = `gemma HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    throw RETRY_STATUS.includes(res.status) ? new TransientHttpError(msg) : new Error(msg);
  }
  const data: any = await res.json();
  return { text: (data?.message?.content ?? "").trim(), seconds: (Date.now() - t0) / 1000 };
}

/** Chờ tăng dần; tổng tối đa ~23s, vẫn dưới timeout 1 lượt. */
const RETRY_DELAYS_MS = [2000, 6000, 15000];

/**
 * Gọi model + THỬ LẠI (3 nhịp) khi lỗi TẠM THỜI:
 *   • rớt mạng (TypeError) — đường tới máy GPU đi qua tailscale, thực tế có nhấp nháy và có lúc
 *     tắt ~20s (TANGCAN 23/07 mất trắng 2 lượt vì "fetch failed", khách nhận tin lỗi);
 *   • proxy trả 502/503/504 — GPU đang bận vì nhiều lượt gọi cùng lúc.
 * KHÔNG retry khi caller chủ động huỷ (cancel-and-restart của facebook.ts) hay khi model trả
 * lỗi HTTP thật (401 sai key, 400 sai body...) — retry mấy ca đó chỉ tổ chậm thêm.
 */

async function callOllama(body: Record<string, unknown>, cfg: LlmConfig): Promise<LlmResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(body, cfg);
    } catch (e) {
      const err = e as Error;
      if (err?.name === "AbortError" || cfg.abortSignal?.aborted) throw e;
      const transient = err instanceof TypeError || err instanceof TransientHttpError;
      if (!transient || attempt >= RETRY_DELAYS_MS.length) throw e;
      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(`[gemma] lỗi tạm thời (${err.message}) → thử lại sau ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

const callerAborted = (cfg: LlmConfig): boolean => cfg.abortSignal?.aborted === true;

/**
 * HẾT QUOTA Gemini/Gemma (mọi key cạn 429/403) → TẮT công tắc AI tổng (bot_settings.global_ai=false)
 * để bot DỪNG trả lời hẳn, chờ người vận hành nạp thêm quota rồi bật lại trong admin. Không còn
 * fallback sang model khác. Best-effort, không chặn việc ném lỗi cho lượt hiện tại. Import ĐỘNG để
 * happy-path không nạp module DB.
 */
async function disableAiOnQuota(src: string): Promise<void> {
  try {
    const { setGlobalEnabled } = await import("../../lib/botControl");
    await setGlobalEnabled(false);
    console.error(`[llm] HẾT QUOTA ${src} → ĐÃ TẮT công tắc AI tổng. Nạp quota rồi bật lại trong admin.`);
  } catch (err) {
    console.error("[llm] tắt AI khi hết quota thất bại:", (err as Error).message);
  }
}

// ── Transport Gemini API ────────────────────────────────────────────────────
/** Key hết rate-limit/quota (429/403) → xoay sang key kế. Không rời module này. */
class GeminiKeyExhaustedError extends Error {}
/** Request mình sai (400/404 model...) → bỏ NGUYÊN model đó nhưng vẫn thử model kế. */
class GeminiBadRequestError extends Error {}

/** True cho họ Gemma trên Gemini API — thinking model, cần thêm token đầu ra. Prefix thuần
 *  kỹ thuật trên id model (không phải quyết định nghiệp vụ), khớp cách gemma4 được đặc cách. */
function isGemmaThinkingModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gemma");
}

/** Ghép các part VĂN BẢN của candidate đầu; BỎ part `thought:true` (chain-of-thought của
 *  Gemma — lộ ra là gửi thẳng suy nghĩ nội bộ cho khách). flash-lite không phát part loại này. */
function extractGeminiText(payload: any): string {
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p: any) => p?.thought !== true)
    .map((p: any) => p?.text ?? "")
    .join("")
    .trim();
}

/** Phòng khi model bọc ```json … ``` (chỉ xảy ra ở đường JSON) — lấy đúng object ngoài cùng. */
function stripJsonFence(text: string): string {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

interface GeminiOpts {
  temperature: number;
  maxTokens: number;
  /** Đường JSON (classifier): ép responseMimeType=application/json + nhét schema vào prompt. */
  json?: boolean;
  schema?: unknown;
}

/** Dựng body generateContent từ messages provider-neutral của mình. */
function toGeminiRequest(messages: ChatMsg[], opts: GeminiOpts, model: string): Record<string, unknown> {
  let systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  // Đường JSON: Gemma KHÔNG có grammar-constraint như /api/chatplus của ollama, nên bơm schema
  // vào system + bắt model chỉ trả JSON (giống lối 5.4 bơm-schema-vào-prompt ở fallback.ts).
  if (opts.json && opts.schema) {
    systemText +=
      "\n\n⚠ ĐẦU RA: chỉ trả về DUY NHẤT một object JSON đúng JSON Schema dưới đây — KHÔNG markdown, " +
      "KHÔNG rào ```], KHÔNG thêm chữ nào ngoài JSON.\nJSON Schema:\n" +
      JSON.stringify(opts.schema);
  }

  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  // Gemma (thinking) ăn chung maxOutputTokens giữa reasoning và câu trả → nới thêm để khỏi cụt.
  // flash-lite không phát thought part nên dùng đúng budget. KHÔNG gửi thinkingConfig (cả 2 đều 400).
  const maxOutputTokens = isGemmaThinkingModel(model)
    ? opts.maxTokens + GEMMA_THINKING_RESERVE_TOKENS
    : opts.maxTokens;

  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents,
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens,
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    },
  };
}

/** MỘT call generateContent. Phân loại lỗi cho vòng xoay key/model. */
async function geminiGenerateOnce(
  model: string,
  key: string,
  body: Record<string, unknown>,
  cfg: LlmConfig,
): Promise<LlmResult> {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: combineSignals(cfg.abortSignal, GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 250);
    const msg = `gemini ${model} HTTP ${res.status}: ${detail}`;
    if (res.status === 429 || res.status === 403) throw new GeminiKeyExhaustedError(msg); // key cạn → xoay key
    if (RETRY_STATUS.includes(res.status)) throw new TransientHttpError(msg); // 5xx → thử lại cùng key
    throw new GeminiBadRequestError(msg); // 400/404… → bỏ model này, sang model kế
  }
  const data: any = await res.json();
  const text = extractGeminiText(data);
  // Câu trả RỖNG (thinking ngốn sạch budget → MAX_TOKENS, hoặc bị chặn nội dung): đừng gửi tin
  // trắng cho khách → coi như model này hỏng, BỎ sang model kế (rồi rớt xuống dự phòng 5.4).
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason ?? "empty";
    throw new GeminiBadRequestError(`gemini ${model} trả rỗng (finish=${reason})`);
  }
  return { text, seconds: (Date.now() - t0) / 1000 };
}

/**
 * Sinh chữ qua Gemini API theo lưới (model → key), thứ tự MODEL-MAJOR: thử HẾT mọi key ở model
 * trước rồi mới rớt sang model sau. flash-lite (chất) phục vụ tới khi mọi key cạn quota ngày, rồi
 * Gemma nhận tràn. 429/403 xoay key; 5xx/mạng thử lại cùng key (backoff); 400/404 bỏ model đó.
 * Cạn hết lưới → ném lỗi để callChat/callJson rớt sang dự phòng gpt-5.4.
 */
async function chatViaGemini(messages: ChatMsg[], opts: GeminiOpts, cfg: LlmConfig): Promise<LlmResult> {
  const keys = geminiApiKeys();
  const models = geminiChatModels();
  let lastError: Error = new Error("Không có Gemini API key khả dụng.");

  for (const model of models) {
    const body = toGeminiRequest(messages, opts, model);
    let modelTainted = false;
    for (let k = 0; k < keys.length; k++) {
      for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
        try {
          return await geminiGenerateOnce(model, keys[k], body, cfg);
        } catch (e) {
          const err = e as Error;
          if (err?.name === "AbortError" || cfg.abortSignal?.aborted) throw e; // caller huỷ → không xoay
          lastError = err;
          if (err instanceof GeminiKeyExhaustedError) {
            console.warn(`[gemini] ${model} key #${k + 1}/${keys.length} cạn quota → xoay key`);
            break; // sang key kế
          }
          if (err instanceof GeminiBadRequestError) {
            console.warn(`[gemini] ${model} lỗi request (${err.message.slice(0, 120)}) → bỏ model, thử model kế`);
            modelTainted = true;
            break;
          }
          // Transient (5xx / rớt mạng): thử lại cùng key nếu còn lượt.
          if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
            const wait = GEMINI_RETRY_BASE_MS * 2 ** attempt;
            console.warn(`[gemini] ${model} key #${k + 1} lỗi tạm thời (${err.message.slice(0, 120)}) → thử lại sau ${wait / 1000}s`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          break; // hết lượt transient → sang key kế
        }
      }
      if (modelTainted) break; // 400/404: mọi key đều vô ích → model kế
    }
  }
  throw lastError;
}

/** Sinh VĂN BẢN (câu trả lời cho khách). */
export async function callChat(
  messages: ChatMsg[],
  opts: { temperature: number; maxTokens: number },
  cfg: LlmConfig,
): Promise<LlmResult> {
  const useGemini = geminiApiKeys().length > 0;
  try {
    if (useGemini) {
      return await chatViaGemini(messages, { temperature: opts.temperature, maxTokens: opts.maxTokens }, cfg);
    }
    // Đường ollama gemma4:12b self-host — chỉ chạy khi KHÔNG cấu hình GEMINI_API_KEYS.
    return await callOllama(
      { messages, options: { temperature: opts.temperature, num_predict: opts.maxTokens, num_ctx: NUM_CTX } },
      cfg,
    );
  } catch (e) {
    // Không còn fallback: lỗi → lượt này bot IM (webhook nuốt lỗi). Hết quota thì tắt AI tổng.
    if (!callerAborted(cfg) && e instanceof GeminiKeyExhaustedError) {
      await disableAiOnQuota(useGemini ? "gemini" : "gemma");
    }
    throw e;
  }
}

/** Sinh JSON đúng schema (structured output của ollama) rồi parse. */
export async function callJson<T>(
  messages: ChatMsg[],
  schema: unknown,
  opts: { maxTokens: number },
  cfg: LlmConfig,
): Promise<{ value: T; seconds: number }> {
  const useGemini = geminiApiKeys().length > 0;
  try {
    if (useGemini) {
      // Gemini không có grammar-constraint như ollama `format` → nhét schema vào prompt + ép JSON mime.
      const r = await chatViaGemini(messages, { temperature: 0, maxTokens: opts.maxTokens, json: true, schema }, cfg);
      return { value: JSON.parse(stripJsonFence(r.text)) as T, seconds: r.seconds };
    }
    const r = await callOllama(
      { messages, format: schema, options: { temperature: 0, num_predict: opts.maxTokens, num_ctx: NUM_CTX } },
      cfg,
    );
    return { value: JSON.parse(r.text) as T, seconds: r.seconds };
  } catch (e) {
    // Không còn fallback: lỗi → lượt này bot IM (webhook nuốt lỗi). Hết quota thì tắt AI tổng.
    if (!callerAborted(cfg) && e instanceof GeminiKeyExhaustedError) {
      await disableAiOnQuota(useGemini ? "gemini" : "gemma");
    }
    throw e;
  }
}

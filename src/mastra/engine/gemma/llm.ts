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
    // keep_alive dài: giữ model resident trên GPU, tránh cold-load 20-60s giữa các khách
    body: JSON.stringify({ model: cfg.model, stream: false, think: false, keep_alive: "24h", ...body }),
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

/**
 * FALLBACK sang 5.4 khi Gemma CHẾT giữa lượt (mạng/proxy/timeout). Bật mặc định; tắt bằng
 * GEMMA_FALLBACK=0. KHÔNG fallback khi caller CHỦ ĐỘNG huỷ (cancel-and-restart của facebook.ts):
 * gửi reply cho lượt đã bị thay = sai. Import fallback ĐỘNG → happy-path không nạp OpenAI client.
 */
const fallbackOn = (): boolean => (process.env.GEMMA_FALLBACK ?? "1") !== "0";
const callerAborted = (cfg: LlmConfig): boolean => cfg.abortSignal?.aborted === true;

/** Sinh VĂN BẢN (câu trả lời cho khách). */
export async function callChat(
  messages: ChatMsg[],
  opts: { temperature: number; maxTokens: number },
  cfg: LlmConfig,
): Promise<LlmResult> {
  try {
    return await callOllama(
      { messages, options: { temperature: opts.temperature, num_predict: opts.maxTokens, num_ctx: NUM_CTX } },
      cfg,
    );
  } catch (e) {
    if (callerAborted(cfg) || !fallbackOn()) throw e;
    console.warn(`[gemma] GENERATE lỗi (${(e as Error)?.message}) → FALLBACK 5.4`);
    const { fallbackChat } = await import("./fallback");
    return fallbackChat(messages, { temperature: opts.temperature }, cfg.abortSignal);
  }
}

/** Sinh JSON đúng schema (structured output của ollama) rồi parse. */
export async function callJson<T>(
  messages: ChatMsg[],
  schema: unknown,
  opts: { maxTokens: number },
  cfg: LlmConfig,
): Promise<{ value: T; seconds: number }> {
  try {
    const r = await callOllama(
      { messages, format: schema, options: { temperature: 0, num_predict: opts.maxTokens, num_ctx: NUM_CTX } },
      cfg,
    );
    return { value: JSON.parse(r.text) as T, seconds: r.seconds };
  } catch (e) {
    if (callerAborted(cfg) || !fallbackOn()) throw e;
    console.warn(`[gemma] CLASSIFY lỗi (${(e as Error)?.message}) → FALLBACK 5.4`);
    const { fallbackJson } = await import("./fallback");
    return fallbackJson<T>(messages, schema, cfg.abortSignal);
  }
}

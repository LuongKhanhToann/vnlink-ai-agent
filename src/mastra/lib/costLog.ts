/**
 * lib/costLog.ts — Nhật ký CHI PHÍ AI: ghi lại mỗi lần gọi model Gemini có phát sinh phí.
 *
 * Vì sao: bàn giao dự án cần biết mỗi tháng bot tiêu bao nhiêu tiền gọi AI. Mỗi lượt khách chat
 * làm bot gọi model vài lần (trả lời khách + viết lại câu hỏi + xếp hạng tài liệu). Module này
 * ghi 1 dòng/lần gọi vào bảng `ai_cost_log` (cùng DB Supabase) với: mục đích, tên model, số token
 * vào/ra. TIỀN được tính LÚC XEM theo bảng giá hiện tại (đọc mỗi lần, KHÔNG cache) — admin đổi giá
 * là báo cáo đổi theo. Ghi log là "best-effort": lỗi DB chỉ cảnh báo, KHÔNG bao giờ làm hỏng/chậm
 * câu trả lời cho khách (gọi kiểu fire-and-forget).
 *
 * Giá mặc định = model gemini-3.6-flash: $0.75 / 1 triệu token VÀO, $3.75 / 1 triệu token RA
 * (giá giới thiệu của Google tới 31/12/2026; từ 01/01/2027 dự kiến tăng — sửa lại trong tab admin).
 */

import { Pool } from "pg";
import "dotenv/config";

/** Đơn giá 1 model: USD cho mỗi 1 TRIỆU token (in = câu hỏi gửi lên, out = câu trả về). */
export interface ModelPrice {
  in: number;
  out: number;
}

export interface PricingConfig {
  usdToVnd: number; // tỉ giá quy đổi USD → VNĐ để hiển thị tiền Việt
  default: ModelPrice; // giá dùng khi model chưa có trong bảng (mặc định = gemini-3.6-flash)
  models: Record<string, ModelPrice>; // đơn giá từng model
}

/** Giá MẶC ĐỊNH — lấy thẳng theo gemini-3.6-flash làm chuẩn (default), các model rẻ hơn khai riêng. */
export const DEFAULT_PRICING: PricingConfig = {
  usdToVnd: 26_000,
  default: { in: 0.75, out: 3.75 }, // = gemini-3.6-flash (giá giới thiệu tới 31/12/2026)
  models: {
    "gemini-3.6-flash": { in: 0.75, out: 3.75 },
    "gemini-3.5-flash": { in: 0.3, out: 2.5 },
    "gemini-3.1-flash-lite": { in: 0.1, out: 0.4 },
    "gemini-3.5-flash-lite": { in: 0.1, out: 0.4 },
    "gemini-flash-lite-latest": { in: 0.1, out: 0.4 },
    "gemma-4-26b-a4b-it": { in: 0, out: 0 }, // model "sàn" Gemma: miễn phí
  },
};

const PRICING_KEY = "ai_pricing";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    pool.on("error", (e) => console.error("[costLog] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS ai_cost_log (
           id            BIGSERIAL   PRIMARY KEY,
           created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           purpose       TEXT        NOT NULL,
           model         TEXT        NOT NULL,
           prompt_tokens INTEGER     NOT NULL DEFAULT 0,
           output_tokens INTEGER     NOT NULL DEFAULT 0
         )`,
      )
      .then(() =>
        getPool()
          .query(`CREATE INDEX IF NOT EXISTS ai_cost_log_created_idx ON ai_cost_log (created_at)`)
          .then(() => void 0),
      )
      .then(() =>
        // Bảng giá dùng chung bảng bot_config (đã có ở lib/settings) — chỉ khác key.
        getPool()
          .query(
            `CREATE TABLE IF NOT EXISTS bot_config (
               key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
          )
          .then(() => void 0),
      )
      .catch((e) => {
        console.error("[costLog] ensureSchema failed:", e);
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

/**
 * Ghi 1 lần gọi AI có phát sinh phí. GỌI KHÔNG CẦN await (fire-and-forget): tự nuốt mọi lỗi để
 * không bao giờ làm chậm/hỏng câu trả lời cho khách. Chỉ lưu token thô — tiền tính lúc xem báo cáo.
 */
export async function logAiCall(entry: {
  purpose: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
}): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO ai_cost_log (purpose, model, prompt_tokens, output_tokens) VALUES ($1, $2, $3, $4)`,
      [
        String(entry.purpose || "khác").slice(0, 60),
        String(entry.model || "?").slice(0, 60),
        Math.max(0, Math.round(entry.promptTokens || 0)),
        Math.max(0, Math.round(entry.outputTokens || 0)),
      ],
    );
  } catch (e) {
    console.warn("[costLog] ghi log thất bại (bỏ qua):", (e as Error).message);
  }
}

// ── Bảng giá: đọc/ghi qua bot_config (đọc MỖI lần, không cache) ──
function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

function sanitizePrice(raw: any, dflt: ModelPrice): ModelPrice {
  const o = raw && typeof raw === "object" ? raw : {};
  return { in: clampNum(o.in, 0, 1000, dflt.in), out: clampNum(o.out, 0, 1000, dflt.out) };
}

/** Ép object bất kỳ về PricingConfig hợp lệ (dùng cả khi đọc DB lẫn khi admin lưu). */
export function sanitizePricing(raw: any): PricingConfig {
  const o = raw && typeof raw === "object" ? raw : {};
  const models: Record<string, ModelPrice> = {};
  const src = o.models && typeof o.models === "object" ? o.models : {};
  // Giữ các model mặc định + cho phép thêm/sửa model từ admin.
  for (const name of new Set([...Object.keys(DEFAULT_PRICING.models), ...Object.keys(src)])) {
    const clean = String(name).trim().slice(0, 60);
    if (!clean) continue;
    models[clean] = sanitizePrice(src[name], DEFAULT_PRICING.models[name] ?? DEFAULT_PRICING.default);
  }
  return {
    usdToVnd: clampNum(o.usdToVnd, 1, 1_000_000, DEFAULT_PRICING.usdToVnd),
    default: sanitizePrice(o.default, DEFAULT_PRICING.default),
    models,
  };
}

/** Đọc bảng giá hiện tại (không cache). Lỗi/chưa có → DEFAULT_PRICING. */
export async function loadPricing(): Promise<PricingConfig> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(`SELECT value FROM bot_config WHERE key = $1`, [PRICING_KEY]);
    if (!rows.length) return DEFAULT_PRICING;
    return sanitizePricing(rows[0].value);
  } catch (e) {
    console.error("[costLog] loadPricing failed → default:", (e as Error).message);
    return DEFAULT_PRICING;
  }
}

/** Lưu bảng giá (admin gọi). Sanitize trước khi ghi. */
export async function savePricing(input: unknown): Promise<PricingConfig> {
  const cfg = sanitizePricing(input);
  await ensureSchema();
  await getPool().query(
    `INSERT INTO bot_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [PRICING_KEY, JSON.stringify(cfg)],
  );
  return cfg;
}

/** Đơn giá của 1 model (rơi về default = gemini-3.6-flash nếu chưa khai). */
function priceOf(pricing: PricingConfig, model: string): ModelPrice {
  return pricing.models[model] ?? pricing.default;
}

function costUsd(pricing: PricingConfig, model: string, promptTokens: number, outputTokens: number): number {
  const p = priceOf(pricing, model);
  return (promptTokens / 1_000_000) * p.in + (outputTokens / 1_000_000) * p.out;
}

export interface MonthCost {
  month: string; // "YYYY-MM" theo giờ VN
  calls: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  costVnd: number;
}

export interface PurposeCost {
  purpose: string;
  model: string;
  calls: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
  costVnd: number;
}

const TZ = "Asia/Ho_Chi_Minh";

/** Tổng chi phí theo THÁNG (mới nhất trước). Tính tiền lúc gọi theo bảng giá hiện tại. */
export async function monthlyCost(): Promise<{ months: MonthCost[]; pricing: PricingConfig }> {
  const pricing = await loadPricing();
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM') AS month,
            model,
            COUNT(*)::int              AS calls,
            COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens
       FROM ai_cost_log
      GROUP BY 1, 2`,
  );
  const byMonth = new Map<string, MonthCost>();
  for (const r of rows) {
    const pt = Number(r.prompt_tokens);
    const ot = Number(r.output_tokens);
    const usd = costUsd(pricing, r.model, pt, ot);
    const m = byMonth.get(r.month) ?? {
      month: r.month,
      calls: 0,
      promptTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costVnd: 0,
    };
    m.calls += Number(r.calls);
    m.promptTokens += pt;
    m.outputTokens += ot;
    m.costUsd += usd;
    byMonth.set(r.month, m);
  }
  const months = [...byMonth.values()]
    .map((m) => ({ ...m, costVnd: m.costUsd * pricing.usdToVnd }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));
  return { months, pricing };
}

/** Chi tiết 1 tháng: bổ theo MỤC ĐÍCH + model (tốn nhiều nhất trước). */
export async function costByPurpose(month: string): Promise<PurposeCost[]> {
  const pricing = await loadPricing();
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT purpose, model,
            COUNT(*)::int              AS calls,
            COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens
       FROM ai_cost_log
      WHERE to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $1
      GROUP BY purpose, model`,
    [month],
  );
  return rows
    .map((r: any) => {
      const pt = Number(r.prompt_tokens);
      const ot = Number(r.output_tokens);
      const usd = costUsd(pricing, r.model, pt, ot);
      return {
        purpose: r.purpose,
        model: r.model,
        calls: Number(r.calls),
        promptTokens: pt,
        outputTokens: ot,
        costUsd: usd,
        costVnd: usd * pricing.usdToVnd,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

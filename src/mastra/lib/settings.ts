/**
 * lib/settings.ts — Cấu hình RUNTIME do admin chỉnh (giờ nghỉ đêm, kíp trực, nhịp gõ tin).
 *
 * Vì sao: các con số này trước đây hard-code trong timeContext/facebook. Admin cần đổi linh hoạt
 * (đổi giờ giục ngủ, đổi tên/giờ từng ca, đổi delay giữa các bóng tin) mà không cần deploy lại.
 * Lưu 1 dòng JSONB trong Postgres Supabase (cùng DB), ĐỌC MỖI LƯỢT (không cache) như botControl —
 * admin sửa là bot áp dụng ngay ở tin kế tiếp. Lỗi DB → fail-open về DEFAULT_CONFIG.
 */

import { Pool } from "pg";
import "dotenv/config";

export interface ShiftCfg {
  name: string; // tên nhân viên trực
  label: string; // "ca sáng"
  start: number; // giờ bắt đầu (0-23)
  end: number; // giờ kết thúc (0-23); start > end = ca qua đêm (VD 22 → 6)
}

export interface BotRuntimeConfig {
  lateNightStart: number; // giờ bắt đầu "nghỉ đêm" (giục khách đi ngủ)
  lateNightEnd: number; // giờ kết thúc (sáng); start > end = khung qua đêm
  bubbleDelayMinMs: number; // chờ tối thiểu giữa 2 bóng tin
  bubbleDelayMaxMs: number; // chờ tối đa giữa 2 bóng tin
  shifts: ShiftCfg[];
}

export const DEFAULT_CONFIG: BotRuntimeConfig = {
  lateNightStart: 23,
  lateNightEnd: 5,
  bubbleDelayMinMs: 6000,
  bubbleDelayMaxMs: 10000,
  shifts: [
    { name: "Trang", label: "ca sáng", start: 6, end: 10 },
    { name: "Xuân", label: "ca trưa", start: 10, end: 14 },
    { name: "Thảo", label: "ca chiều", start: 14, end: 18 },
    { name: "Vân", label: "ca tối", start: 18, end: 22 },
    { name: "Liên", label: "ca trực đêm", start: 22, end: 6 },
  ],
};

const CONFIG_KEY = "runtime";

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
    pool.on("error", (e) => console.error("[settings] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS bot_config (
           key        TEXT PRIMARY KEY,
           value      JSONB       NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => void 0)
      .catch((e) => {
        console.error("[settings] ensureSchema failed:", e);
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

// ── Sanitize: admin gửi JSON tuỳ ý → luôn ép về config hợp lệ, thiếu field thì lấy default ──
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

function sanitizeShifts(raw: unknown): ShiftCfg[] {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.shifts;
  const out: ShiftCfg[] = [];
  for (const s of raw) {
    const name = String((s as any)?.name ?? "").trim();
    if (!name) continue; // ca không tên → bỏ
    out.push({
      name: name.slice(0, 40),
      label: (String((s as any)?.label ?? "").trim() || "ca trực").slice(0, 40),
      start: clampInt((s as any)?.start, 0, 23, 0),
      end: clampInt((s as any)?.end, 0, 23, 0),
    });
  }
  return out.length ? out : DEFAULT_CONFIG.shifts;
}

/** Ép object bất kỳ về BotRuntimeConfig hợp lệ (dùng cả khi đọc từ DB lẫn khi admin lưu). */
export function sanitizeConfig(raw: any): BotRuntimeConfig {
  const o = raw && typeof raw === "object" ? raw : {};
  let min = clampInt(o.bubbleDelayMinMs, 0, 120_000, DEFAULT_CONFIG.bubbleDelayMinMs);
  let max = clampInt(o.bubbleDelayMaxMs, 0, 120_000, DEFAULT_CONFIG.bubbleDelayMaxMs);
  if (max < min) max = min; // đảm bảo min ≤ max
  return {
    lateNightStart: clampInt(o.lateNightStart, 0, 23, DEFAULT_CONFIG.lateNightStart),
    lateNightEnd: clampInt(o.lateNightEnd, 0, 23, DEFAULT_CONFIG.lateNightEnd),
    bubbleDelayMinMs: min,
    bubbleDelayMaxMs: max,
    shifts: sanitizeShifts(o.shifts),
  };
}

/** Đọc config MỖI lượt (không cache). Lỗi/chưa có dòng → DEFAULT_CONFIG. */
export async function loadConfig(): Promise<BotRuntimeConfig> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(`SELECT value FROM bot_config WHERE key = $1`, [CONFIG_KEY]);
    if (!rows.length) return DEFAULT_CONFIG;
    return sanitizeConfig(rows[0].value);
  } catch (e) {
    console.error("[settings] loadConfig failed → default:", (e as Error).message);
    return DEFAULT_CONFIG;
  }
}

/** Lưu config (admin gọi). Sanitize trước khi ghi, trả về config đã chuẩn hoá. */
export async function saveConfig(input: unknown): Promise<BotRuntimeConfig> {
  const cfg = sanitizeConfig(input);
  await ensureSchema();
  await getPool().query(
    `INSERT INTO bot_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [CONFIG_KEY, JSON.stringify(cfg)],
  );
  console.log("[settings] config đã lưu:", JSON.stringify(cfg));
  return cfg;
}

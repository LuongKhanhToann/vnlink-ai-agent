/**
 * lib/convState.ts — Trạng thái hội thoại per-user cho L1 (bước bán hàng hiện tại + mốc hoạt động).
 *
 * Lưu 1 dòng / senderId trong Postgres Supabase (cùng DB, pool riêng, đọc mỗi lượt, KHÔNG cache) —
 * theo đúng pattern history.ts/settings.ts. Best-effort: lỗi đọc → fail-open về S1; lỗi ghi → bỏ qua.
 */

import { Pool } from "pg";
import "dotenv/config";
import type { StageCode } from "../engine/taxonomy";
import { STAGE_CODES } from "../engine/taxonomy";

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
    pool.on("error", (e) => console.error("[convState] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS conversation_state (
           sender_id  TEXT PRIMARY KEY,
           stage      TEXT        NOT NULL DEFAULT 'S1',
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => void 0)
      .catch((e) => {
        console.error("[convState] ensureSchema failed:", e);
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

export interface ConvState {
  stage: StageCode;
  updatedAt: Date | null; // mốc lượt trước (để phát hiện reset hội thoại sau thời gian dài)
}

/** Đọc trạng thái. Chưa có / lỗi → {stage:S1, updatedAt:null}. */
export async function loadState(senderId: string): Promise<ConvState> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT stage, updated_at FROM conversation_state WHERE sender_id = $1`,
      [senderId],
    );
    if (!rows.length) return { stage: "S1", updatedAt: null };
    const stage = STAGE_CODES.includes(rows[0].stage) ? (rows[0].stage as StageCode) : "S1";
    return { stage, updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at) : null };
  } catch (e) {
    console.error(`[convState] loadState failed for ${senderId}:`, (e as Error).message);
    return { stage: "S1", updatedAt: null };
  }
}

/** Ghi trạng thái (upsert). Best-effort. */
export async function saveState(senderId: string, stage: StageCode): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO conversation_state (sender_id, stage, updated_at)
         VALUES ($1, $2, NOW())
       ON CONFLICT (sender_id)
         DO UPDATE SET stage = EXCLUDED.stage, updated_at = NOW()`,
      [senderId, stage],
    );
  } catch (e) {
    console.error(`[convState] saveState failed for ${senderId}:`, (e as Error).message);
  }
}

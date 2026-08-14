/**
 * lib/history.ts — Lịch sử hội thoại per-user (bảng phẳng, đọc N tin gần nhất mỗi lượt).
 *
 * Thay cho Mastra semantic-recall (vốn buộc dùng embedding OpenAI). Luồng mới chỉ cần "trí nhớ
 * làm việc" ngắn hạn: nạp vài lượt gần nhất làm ngữ cảnh cho model. Đọc mỗi request (không cache).
 * Pool riêng, cùng Postgres Supabase. Best-effort: lỗi ghi không làm hỏng reply.
 */

import { Pool } from "pg";
import "dotenv/config";

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
      max: 2,
    });
    pool.on("error", (e) => console.error("[history] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(
        `CREATE TABLE IF NOT EXISTS chat_history (
           id         BIGSERIAL PRIMARY KEY,
           sender_id  TEXT        NOT NULL,
           role       TEXT        NOT NULL,
           content    TEXT        NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await p.query(`CREATE INDEX IF NOT EXISTS chat_history_sender ON chat_history(sender_id, id)`);
    })().catch((e) => {
      console.error("[history] ensureSchema failed:", e);
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export type Turn = { role: "user" | "assistant"; content: string };

const MAX_TURNS = 12; // ~6 lượt qua lại — đủ ngữ cảnh, nhẹ token cho model free-tier

/** Nạp N tin gần nhất theo thứ tự thời gian tăng dần. Lỗi → []. */
export async function loadRecent(senderId: string, limit = MAX_TURNS): Promise<Turn[]> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT role, content FROM (
         SELECT role, content, id FROM chat_history WHERE sender_id = $1 ORDER BY id DESC LIMIT $2
       ) t ORDER BY id ASC`,
      [senderId, limit],
    );
    return rows.map((r: any) => ({ role: r.role === "assistant" ? "assistant" : "user", content: String(r.content ?? "") }));
  } catch (e) {
    console.error(`[history] loadRecent failed for ${senderId}:`, (e as Error).message);
    return [];
  }
}

/** Ghi 1 tin. Best-effort. */
export async function appendMessage(senderId: string, role: "user" | "assistant", content: string): Promise<void> {
  const clean = (content ?? "").trim();
  if (!clean) return;
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO chat_history (sender_id, role, content) VALUES ($1,$2,$3)`,
      [senderId, role, clean],
    );
  } catch (e) {
    console.error(`[history] appendMessage failed for ${senderId}:`, (e as Error).message);
  }
}

/** Xoá sạch lịch sử 1 user (admin xoá khách). */
export async function clearHistory(senderId: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM chat_history WHERE sender_id = $1`, [senderId]);
}

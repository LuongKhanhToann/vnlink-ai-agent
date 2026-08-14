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

/** Bóc text sạch khỏi 1 dòng mastra_messages (content là JSON {format,parts,content}). */
function extractLegacyText(raw: string): string {
  const s = String(raw ?? "");
  try {
    const o = JSON.parse(s);
    if (o && typeof o.content === "string" && o.content.trim()) return o.content.trim();
    if (o && Array.isArray(o.parts)) {
      const t = o.parts
        .filter((p: any) => p && p.type === "text" && p.text)
        .map((p: any) => String(p.text))
        .join(" ")
        .trim();
      if (t) return t;
    }
  } catch {
    /* không phải JSON → dùng raw */
  }
  return s.trim();
}

// Sentinel bot golive TỰ CHÈN vào hội thoại legacy (không phải khách gõ / bot gửi thật). Lọc để admin
// chỉ thấy tin thật. Chỉ so chuỗi cố định (parsing kỹ thuật), không phán đoán nghiệp vụ.
const IMLANG = "__IMLANG__"; // reply "im lặng" — bot chọn không gửi gì

/** "NGÀY: HÔM NAY …\n<tin khách thật>" → lấy phần tin thật sau khối ngày tiêm ở đầu. */
function stripDatePrefix(t: string): string {
  if (!t.startsWith("NGÀY:")) return t;
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(nl + 1).trim() : "";
}

/** Tin "khách" THẬT từ legacy — bỏ prompt hệ thống tiêm (nhắc chủ động, ngữ cảnh), bóc khối ngày. */
function realLegacyUser(raw: string): string | null {
  let t = extractLegacyText(raw);
  if (!t) return null;
  if (t.includes("[TIN NHẮC CHỦ ĐỘNG")) return null; // trigger nhắc chủ động — không phải khách gõ
  if (t.startsWith("Đã biết về khách:")) return null; // ngữ cảnh tiêm kèm trigger
  t = stripDatePrefix(t);
  return t || null;
}

/** Reply "bot" THẬT từ legacy — bỏ sentinel im lặng __IMLANG__. */
function realLegacyBot(raw: string): string | null {
  const t = extractLegacyText(raw);
  if (!t || t === IMLANG) return null;
  return t;
}

/**
 * Cặp tin gần nhất từ kho LEGACY (mastra_messages) — 66/68 khách cũ có hội thoại ở đây, backfill từ
 * bot golive. resourceId = sender_id. Chỉ đọc khi chat_history (kho mới) chưa có gì cho user này.
 * Quét sâu (60 dòng) + lọc các bản ghi bot tự tiêm để lấy đúng tin khách/bot thật gần nhất.
 */
async function lastPairLegacy(senderId: string): Promise<{ user: string | null; bot: string | null }> {
  try {
    const { rows } = await getPool().query(
      `SELECT role, content FROM mastra_messages WHERE "resourceId" = $1 ORDER BY "createdAtZ" DESC LIMIT 60`,
      [senderId],
    );
    let user: string | null = null;
    let bot: string | null = null;
    for (const r of rows as { role: string; content: string }[]) {
      if (!user && r.role !== "assistant") { const u = realLegacyUser(r.content); if (u) user = u; }
      if (!bot && r.role === "assistant") { const b = realLegacyBot(r.content); if (b) bot = b; }
      if (user && bot) break;
    }
    return { user, bot };
  } catch (e) {
    console.error(`[history] lastPairLegacy failed for ${senderId}:`, (e as Error).message);
    return { user: null, bot: null };
  }
}

/**
 * Cặp tin gần nhất (tin khách mới nhất + tin bot mới nhất) để admin xem nhanh trong danh sách.
 * Đọc kho mới (chat_history) trước; user cũ chưa nhắn qua engine mới thì chat_history rỗng → fallback
 * kho legacy (mastra_messages) để vẫn hiện được nội dung. Best-effort — lỗi → {user:null, bot:null}.
 */
export async function lastPair(senderId: string): Promise<{ user: string | null; bot: string | null }> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT role, content FROM chat_history WHERE sender_id = $1 ORDER BY id DESC LIMIT 20`,
      [senderId],
    );
    let user: string | null = null;
    let bot: string | null = null;
    for (const r of rows as { role: string; content: string }[]) {
      if (!user && r.role !== "assistant") user = String(r.content ?? "").trim() || null;
      if (!bot && r.role === "assistant") bot = String(r.content ?? "").trim() || null;
      if (user && bot) break;
    }
    // Chưa có gì ở kho mới → thử kho legacy (khách cũ backfill từ bot golive).
    if (!user && !bot) return await lastPairLegacy(senderId);
    return { user, bot };
  } catch (e) {
    console.error(`[history] lastPair failed for ${senderId}:`, (e as Error).message);
    return { user: null, bot: null };
  }
}

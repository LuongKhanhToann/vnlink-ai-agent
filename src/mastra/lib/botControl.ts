/**
 * botControl.ts
 *
 * Bảng điều khiển bật/tắt AI theo từng FB user — chia sẻ với webadmin (Vercel) qua
 * CHÍNH Supabase Postgres mà bot đang dùng. Hai service độc lập, chỉ giao tiếp qua DB.
 *
 *   - Mỗi tin FB đến  → recordUserActivity(): upsert user vào bảng (để admin thấy danh sách),
 *                       backfill tên từ Graph API (best-effort, chỉ khi chưa có).
 *   - Trước khi trả lời → isBotEnabled(): đọc cờ enabled MỖI request (không cache).
 *                         enabled=false (admin tắt) → webhook bỏ qua, AI im lặng.
 *
 * Admin (Vercel) ghi cờ enabled vào bảng này; bot đọc ở lần tin kế tiếp → tắt/bật tức thì.
 */

import { Pool } from "pg";
import "dotenv/config";

const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN ?? "";

// Pool riêng (KHÔNG dùng PostgresStore của Mastra) — cùng credentials Supabase.
// Connection pooling là chia sẻ kết nối, KHÔNG phải cache dữ liệu.
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
    pool.on("error", (e) => console.error("[botControl] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS bot_controls (
           sender_id   TEXT PRIMARY KEY,
           name        TEXT,
           enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
           last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => {
        console.log("[botControl] schema ready");
      })
      .catch((e) => {
        console.error("[botControl] ensureSchema failed:", e);
        schemaReady = null; // cho phép retry lần sau
        throw e;
      });
  }
  return schemaReady;
}

/** Lấy tên hiển thị của user từ Graph API (best-effort, có thể bị FB hạn chế). */
async function fetchFbName(senderId: string): Promise<string | null> {
  if (!FB_PAGE_ACCESS_TOKEN) return null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${senderId}?fields=first_name,last_name,name&access_token=${FB_PAGE_ACCESS_TOKEN}`,
    );
    if (!res.ok) {
      // Dev-mode: Graph API chỉ trả tên cho user có vai trò trong App (admin/tester).
      // Người lạ → 400/#100 → name null → "(chưa rõ tên)". Cần App Review để hết.
      console.warn(`[botControl] fetchFbName ${senderId} → ${res.status} ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { name?: string; first_name?: string; last_name?: string };
    return data.name ?? ([data.first_name, data.last_name].filter(Boolean).join(" ") || null);
  } catch {
    return null;
  }
}

/**
 * Ghi nhận user vừa nhắn: upsert + cập nhật last_active. Nếu chưa có tên → backfill
 * từ Graph API (chạy nền, không chặn webhook). Best-effort — lỗi DB không làm hỏng reply.
 */
export async function recordUserActivity(senderId: string): Promise<void> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `INSERT INTO bot_controls (sender_id, last_active)
         VALUES ($1, NOW())
       ON CONFLICT (sender_id)
         DO UPDATE SET last_active = NOW()
       RETURNING name`,
      [senderId],
    );
    if (!rows[0]?.name) {
      const name = await fetchFbName(senderId);
      if (name) {
        await getPool().query(
          `UPDATE bot_controls SET name = $2 WHERE sender_id = $1 AND name IS NULL`,
          [senderId, name],
        );
      }
    }
  } catch (e) {
    console.error(`[botControl] recordUserActivity failed for ${senderId}:`, e);
  }
}

/**
 * Ghi tên khách LẤY TỪ HỘI THOẠI (khách tự khai khi đặt lịch) → bot_controls.name.
 * Nguồn này tin cậy hơn Graph API (không cần App Review) và là cách shop thật gọi khách.
 * Ghi đè tên cũ vì tên khách khai trong chat luôn là mới/đúng nhất. Best-effort.
 */
export async function recordUserName(senderId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO bot_controls (sender_id, name, last_active)
         VALUES ($1, $2, NOW())
       ON CONFLICT (sender_id)
         DO UPDATE SET name = EXCLUDED.name`,
      [senderId, clean],
    );
  } catch (e) {
    console.error(`[botControl] recordUserName failed for ${senderId}:`, e);
  }
}

export type BotUser = {
  sender_id: string;
  name: string | null;
  enabled: boolean;
  last_active: string;
};

/** Danh sách user AI đang phản hồi — mới hoạt động xếp trước. Dùng cho webadmin. */
export async function listUsers(): Promise<BotUser[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT sender_id, name, enabled, last_active
       FROM bot_controls
      ORDER BY last_active DESC`,
  );
  return rows as BotUser[];
}

/** Bật/tắt AI cho 1 user (admin gọi). */
export async function setBotEnabled(senderId: string, enabled: boolean): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE bot_controls SET enabled = $2 WHERE sender_id = $1`,
    [senderId, enabled],
  );
}

/**
 * Xoá user khỏi bảng điều khiển + bản ghi working-memory (Mastra resource, scope=resource)
 * sống chung Postgres. Admin gọi khi "xoá dữ liệu chat" 1 người.
 *   - bot_controls: dòng hiển thị trong danh sách admin (sender_id = PSID).
 *   - mastra_resources: hồ sơ ghi nhớ dài hạn theo resourceId (= PSID). Best-effort: bảng có
 *     thể vắng ở chế độ test (libsql) → nuốt lỗi, không chặn việc xoá dòng bot_controls.
 */
export async function deleteBotUser(senderId: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM bot_controls WHERE sender_id = $1`, [senderId]);
  try {
    await getPool().query(`DELETE FROM mastra_resources WHERE id = $1`, [senderId]);
  } catch (e) {
    console.warn(
      `[botControl] xoá mastra_resources cho ${senderId} (best-effort) bỏ qua:`,
      (e as Error).message,
    );
  }
}

/**
 * AI có được phép trả lời user này không? Đọc cờ enabled MỖI lần (không cache).
 * User chưa có trong bảng (tin đầu) → mặc định TRUE (bật). Lỗi DB → fail-open (TRUE)
 * để sự cố DB không làm câm cả bot.
 */
export async function isBotEnabled(senderId: string): Promise<boolean> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT enabled FROM bot_controls WHERE sender_id = $1`,
      [senderId],
    );
    if (rows.length === 0) return true; // user mới → mặc định bật
    return rows[0].enabled === true;
  } catch (e) {
    console.error(`[botControl] isBotEnabled failed for ${senderId} → fail-open:`, e);
    return true;
  }
}

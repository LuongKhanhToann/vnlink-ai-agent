/**
 * backfillBotControls.ts — nạp DANH SÁCH KHÁCH CŨ vào bảng bot_controls để hiện ở /admin.
 *
 * Vì sao cần: backfillFbHistory.ts chỉ nạp TRANSCRIPT vào memory (mastra_threads/messages) —
 * đó là kho bot ĐỌC để hiểu context. Còn danh sách "Người dùng" ở admin đọc từ bảng KHÁC:
 * bot_controls (botControl.listUsers). Bảng này chỉ được điền khi có tin FB LIVE đến
 * (recordUserActivity). Nên khách cũ đã backfill memory vẫn KHÔNG hiện ở admin cho tới khi
 * họ nhắn lại. Script này điền sẵn để admin thấy + chủ động bật/tắt AI ngay.
 *
 * Nguồn tên: participants của conversation (inbox page — không cần App Review như Graph
 * user-node). last_active = updated_time của conversation.
 *
 * Idempotent: ON CONFLICT giữ nguyên name/enabled đã có, chỉ nới last_active MỚI hơn.
 * KHÔNG đụng enabled (mặc định TRUE ở dòng mới; dòng cũ admin đã set thì giữ).
 *
 * Chạy (đọc Supabase prod từ .env — KHÔNG set STORAGE_BACKEND):
 *   DRY_RUN=1 npx -y tsx src/mastra/scripts/backfillBotControls.ts   # chỉ đếm, không ghi
 *   npx -y tsx src/mastra/scripts/backfillBotControls.ts             # ghi thật
 */
import "dotenv/config";
import { Pool } from "pg";

const GRAPH = "https://graph.facebook.com/v25.0";
const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const DRY = process.env.DRY_RUN === "1";

if (!TOKEN) {
  console.error("Thiếu FB_PAGE_ACCESS_TOKEN trong .env");
  process.exit(1);
}

type Participant = { id: string; name?: string };
type Conv = { id: string; updated_time?: string; participants?: { data: Participant[] } };

async function gget(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.type}: ${json.error.message}`);
  return json;
}

function getPool(): Pool {
  return new Pool({
    host: process.env.PG_DATABASE_HOST!,
    port: Number(process.env.PG_DATABASE_PORT!),
    user: process.env.PG_DATABASE_USER!,
    password: process.env.PG_DATABASE_PASSWORD!,
    database: process.env.PG_DATABASE_NAME!,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
}

async function main() {
  const me = await gget(`${GRAPH}/me?fields=id,name&access_token=${TOKEN}`);
  const pageId = me.id as string;
  console.log(`[bc-backfill] page: ${me.name} (${pageId})`);
  console.log(`[bc-backfill] mode: ${DRY ? "DRY-RUN (không ghi)" : "GHI THẬT"}`);

  const pool = DRY ? null : getPool();
  if (pool) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS bot_controls (
         sender_id   TEXT PRIMARY KEY,
         name        TEXT,
         enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
         last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
  }

  let convCount = 0, upserted = 0, skipped = 0, noName = 0;

  let url = `${GRAPH}/${pageId}/conversations?fields=participants,updated_time&limit=50&access_token=${TOKEN}`;
  while (url) {
    const page = await gget(url);
    for (const conv of (page.data ?? []) as Conv[]) {
      convCount++;
      const customer = (conv.participants?.data ?? []).find((p) => p.id && p.id !== pageId);
      if (!customer) { skipped++; continue; }
      const psid = customer.id;
      const name = (customer.name ?? "").trim() || null;
      if (!name) noName++;
      const lastActive = conv.updated_time ? new Date(conv.updated_time) : new Date();

      if (pool) {
        await pool.query(
          `INSERT INTO bot_controls (sender_id, name, last_active)
             VALUES ($1, $2, $3)
           ON CONFLICT (sender_id) DO UPDATE SET
             name        = COALESCE(bot_controls.name, EXCLUDED.name),
             last_active = GREATEST(bot_controls.last_active, EXCLUDED.last_active)`,
          [psid, name, lastActive],
        );
      }
      upserted++;
      console.log(`[bc-backfill] conv#${convCount} psid=${psid.slice(0, 6)}… name=${name ?? "(chưa rõ)"}`);
    }
    url = page.paging?.next ?? "";
  }

  console.log("──────── TỔNG KẾT ────────");
  console.log(`conversations quét    : ${convCount}`);
  console.log(`khách ${DRY ? "sẽ upsert" : "đã upsert"}  : ${upserted} (thiếu tên: ${noName})`);
  console.log(`bỏ qua (không có PSID) : ${skipped}`);
  if (DRY) console.log("→ DRY-RUN: chưa ghi gì. Bỏ DRY_RUN=1 để ghi thật.");
  if (pool) await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error("[bc-backfill] LỖI:", e); process.exit(1); });

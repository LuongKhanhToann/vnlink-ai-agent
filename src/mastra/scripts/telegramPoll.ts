/**
 * scripts/telegramPoll.ts
 * Long-polling cho Telegram — dùng khi chạy local (không có webhook public).
 * Chạy: npx tsx src/mastra/scripts/telegramPoll.ts
 */

import { Pool } from "pg";
import "dotenv/config";

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN!;
const API      = `https://api.telegram.org/bot${TOKEN}`;

const pool = new Pool({
  host:     process.env.PG_DATABASE_HOST!,
  port:     Number(process.env.PG_DATABASE_PORT!),
  user:     process.env.PG_DATABASE_USER!,
  password: process.env.PG_DATABASE_PASSWORD!,
  database: process.env.PG_DATABASE_NAME!,
  ssl: { rejectUnauthorized: false },
});

async function sendMessage(chatId: number, text: string) {
  await fetch(`${API}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text }),
  });
}

async function handleReset(chatId: number) {
  try {
    await pool.query(`
      DO $$ DECLARE
          r RECORD;
      BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public')
          LOOP
              EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE;';
          END LOOP;
      END $$;
    `);
    console.log("[tg] reset: all tables truncated");
    // Note: script này chạy ở process riêng so với bot → KHÔNG clear được in-memory state
    // (pending/queues/processing/seq trong facebook.ts, followup timers). Nếu cần full reset
    // (gồm unlock user mà bot đã "tắt nhắn tin"), dùng webhook /reset thay vì poll script,
    // hoặc restart bot process sau khi truncate.
    await sendMessage(
      chatId,
      "✅ Đã truncate DB.\n⚠️ In-memory state (followup timers, debounce queue) cần restart bot để clear hoàn toàn.",
    );
  } catch (e) {
    console.error("[tg] reset error:", e);
    await sendMessage(chatId, `❌ Lỗi khi xoá memory:\n${String(e)}`);
  }
}

async function poll() {
  let offset = 0;
  console.log("[tg] polling started...");

  while (true) {
    try {
      const res  = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json() as any;

      if (!data.ok) {
        console.error("[tg] getUpdates error:", data);
        await sleep(5000);
        continue;
      }

      for (const update of data.result ?? []) {
        offset = update.update_id + 1;

        const text   = update.message?.text?.trim() ?? "";
        const chatId = update.message?.chat?.id as number;

        console.log(`[tg] update=${update.update_id} text="${text}"`);

        if (text === "/reset") await handleReset(chatId);
      }
    } catch (e) {
      console.error("[tg] poll error:", e);
      await sleep(5000);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

poll();

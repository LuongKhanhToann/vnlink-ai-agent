/**
 * routes/telegram.ts
 * Xử lý Telegram webhook — hiện tại chỉ hỗ trợ lệnh /reset
 */

import { Hono } from "hono";
import { Pool } from "pg";
import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const pool = new Pool({
  host:     process.env.PG_DATABASE_HOST!,
  port:     Number(process.env.PG_DATABASE_PORT!),
  user:     process.env.PG_DATABASE_USER!,
  password: process.env.PG_DATABASE_PASSWORD!,
  database: process.env.PG_DATABASE_NAME!,
  ssl: { rejectUnauthorized: false },
  max: 1,
  idleTimeoutMillis: 10_000,
});

export const telegramWebhook = new Hono();

telegramWebhook.post("/telegram", async (c) => {
  const body = await c.req.json();

  const message = body?.message;
  if (!message) return c.text("OK");

  const chatId = message.chat.id as number;
  const text   = (message.text as string ?? "").trim();

  console.log(`[tg] from=${chatId} text="${text}"`);

  if (text === "/reset") {
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
      await sendMessage(chatId, "✅ Đã xoá toàn bộ memory trong database!");
    } catch (e) {
      console.error("[tg] reset error:", e);
      await sendMessage(chatId, `❌ Lỗi khi xoá memory:\n${String(e)}`);
    }
  }

  return c.text("OK");
});

async function sendMessage(chatId: number, text: string) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error("[tg] sendMessage error:", await res.text());
  } catch (e) {
    console.error("[tg] sendMessage exception:", e);
  }
}

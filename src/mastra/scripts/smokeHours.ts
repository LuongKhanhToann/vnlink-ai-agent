/**
 * scripts/smokeHours.ts — Kiểm nhanh fix GIỜ MỞ CỬA (5h–20h) sau khi thêm THÔNG TIN CỐ ĐỊNH vào persona.
 * Chạy: SCENARIO_DEBUG=1 npx -y tsx src/mastra/scripts/smokeHours.ts
 */
import "dotenv/config";
import { Pool } from "pg";
import { runTurn } from "../engine/brain";

process.env.SCENARIO_MODE = "on";
process.env.SCENARIO_DEBUG = "1";

const CASES: { name: string; turns: string[] }[] = [
  {
    name: "H1 · case facts=0 từng bịa giờ (nam bận rộn trì hoãn)",
    turns: ["Gói 1 năm anh nghe cũng hợp lý, nhưng anh bận lắm, mua xong khéo tuần đi 1 buổi rồi vứt xó. Thôi để anh nghĩ thêm."],
  },
  { name: "H2 · hỏi thẳng giờ mở cửa", turns: ["trung tâm mở cửa mấy giờ tới mấy giờ vậy em"] },
];

function hoursCheck(reply: string): string {
  const bad = [...reply.matchAll(/\b(\d{1,2})\s*h(?:\d{2})?\b/gi)].map((m) => Number(m[1]));
  const offenders = bad.filter((h) => h > 20 || (h < 5 && h > 0));
  return offenders.length ? `❌ GIỜ NGHI SAI: ${offenders.join(",")}h (chuẩn 5h–20h)` : "✓ không thấy mốc giờ ngoài 5h–20h";
}

async function cleanup() {
  const pool = new Pool({
    host: process.env.PG_DATABASE_HOST!,
    port: Number(process.env.PG_DATABASE_PORT!),
    user: process.env.PG_DATABASE_USER!,
    password: process.env.PG_DATABASE_PASSWORD!,
    database: process.env.PG_DATABASE_NAME!,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  for (const t of ["chat_history", "conversation_state"]) {
    await pool.query(`DELETE FROM ${t} WHERE sender_id LIKE '__smoke_hrs%'`).catch(() => {});
  }
  await pool.end();
}

async function main() {
  let fail = 0;
  let i = 0;
  for (const c of CASES) {
    i++;
    console.log(`\n════ ${c.name} ════`);
    for (const msg of c.turns) {
      const { reply, debug } = await runTurn({ senderId: `__smoke_hrs_${i}`, message: msg });
      console.log(`[Khách] ${msg}`);
      console.log(`  ↳ facts=${debug?.factsLen ?? 0}c fq=${debug?.factQuery ?? "null"}`);
      console.log(`[Bot] ${reply}`);
      const r = hoursCheck(reply);
      console.log(`  ${r}`);
      if (r.startsWith("❌")) fail++;
    }
  }
  console.log(`\n==== ${fail ? `❌ ${fail} lượt sai giờ` : "✓ GIỜ ĐÚNG cả 2 case"} ====`);
  await cleanup();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => {
  console.error("FAIL:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

/**
 * scripts/smokeScenario.ts — Smoke luồng kịch bản (L0–L6) với REPLY THẬT qua pipeline.
 *
 * Mỗi lượt đi qua pipeline ĐÚNG 1 LẦN (dùng debug-return của runTurn để soi routing) — không gọi
 * trùng. Dùng senderId test riêng, DỌN sạch sau khi chạy. Chạy:
 *   SCENARIO_DEBUG=1 npx -y tsx src/mastra/scripts/smokeScenario.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { runTurn } from "../engine/brain";

process.env.SCENARIO_MODE = process.env.SCENARIO_MODE === "off" ? "off" : "on";
process.env.SCENARIO_DEBUG = "1";

const CASES: { name: string; turns: string[] }[] = [
  { name: "chào hỏi thuần (không tra cứu, S1)", turns: ["em ơi chào em"] },
  { name: "bơi cho bé — hỏi dò giá", turns: ["Bên mình dạy bơi cho bé giá bao nhiêu em? có gói nào rẻ ko?"] },
  { name: "gym — hỏi giá cộc lốc giấu mục tiêu", turns: ["gym bao nhiêu"] },
  {
    name: "giảm cân nữ — lộ nỗi đau Yoyo (2 lượt)",
    turns: ["có gói giảm cân nào ko em", "tại mình giảm mãi mà cứ được vài tháng lại tăng lại, chán lắm"],
  },
];

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
  for (const t of ["chat_history", "conversation_state", "scheduled_job"]) {
    await pool
      .query(`DELETE FROM ${t} WHERE sender_id LIKE '__smoke_scn%'`)
      .catch((e) => console.warn(`dọn ${t}: ${(e as Error).message}`));
  }
  await pool.end();
}

async function main() {
  console.log(`\n=== SMOKE KỊCH BẢN (SCENARIO_MODE=${process.env.SCENARIO_MODE}) ===`);
  let idx = 0;
  for (const c of CASES) {
    idx++;
    const senderId = `__smoke_scn_${idx}`;
    console.log(`\n──────────── CASE ${idx}: ${c.name} ────────────`);
    for (const msg of c.turns) {
      const t0 = Date.now();
      const { reply, debug } = await runTurn({ senderId, message: msg });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n[Khách] ${msg}`);
      if (debug)
        console.log(
          `  ↳ route(${secs}s): service=${debug.service} segment=${debug.segment} obj=[${debug.objections}] stage ${debug.stageFrom}→${debug.stageTo} | kịch bản=${debug.scenarios} | facts=${debug.factsLen}c | fact_query=${debug.factQuery ?? "null"}`,
        );
      console.log(`[Bot] ${reply}`);
    }
  }
  await cleanup();
  console.log("\n=== ĐÃ DỌN dữ liệu test. XONG. ===");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

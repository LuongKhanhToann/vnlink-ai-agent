/**
 * smokeFbFollowup.ts — smoke TẦNG LIVE: tin nhắc chủ động (follow-up) khi khách im.
 *
 * Gọi ĐÚNG hàm production generateFollowupReply (routes/facebook.ts), KHÔNG phải bản sao —
 * bug từng nằm ở options của agent.generate, bản sao sẽ không bắt được.
 * STORAGE_BACKEND=libsql → không đụng prod memory.
 *
 * Bug đã bắt (07/2026): memory bật workingMemory → agent có tool updateWorkingMemory; gọi
 * generate với maxSteps=1 → model tiêu bước duy nhất vào tool call → vòng đó không sinh text
 * → follow-up im lặng (log "generate trả rỗng", 8/8 lượt). Smoke này canh gác hồi quy đó.
 *
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeFbFollowup.ts
 *       ROUNDS=3 → lặp 3 vòng (reply ngẫu nhiên; mặc định 1 vòng cho đỡ tốn token).
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

const ROUNDS = Number(process.env.ROUNDS ?? "1");

const CASES = [
  {
    sid: "smk-fu-boi",
    turns: ["Tư vấn cho tôi khóa học bơi", "mình chưa biết bơi", "3 bố con học cùng thì sao"],
  },
];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { generateFollowupReply } = await import("../routes/facebook");

  let empty = 0;
  let total = 0;

  for (const c of CASES) {
    console.log("\n" + "█".repeat(72));
    console.log("BỐI CẢNH:", c.sid);
    for (const t of c.turns) {
      const r: any = await runAgentTurn({ mastra, threadId: c.sid, resourceId: c.sid, message: t });
      console.log(`  KHÁCH: ${t}`);
      console.log(`  BOT  : ${r?.reply}`);
    }

    console.log(`\n  ── FOLLOW-UP (khách im lặng) × ${ROUNDS} vòng × 3 attempt ──`);
    for (let round = 0; round < ROUNDS; round++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = await generateFollowupReply(c.sid, attempt);
        total++;
        if (!text) {
          empty++;
          console.log(`  vòng${round + 1} attempt${attempt + 1}: ❌ RỖNG (khách không nhận được gì)`);
        } else {
          console.log(`  vòng${round + 1} attempt${attempt + 1}: ✅ "${text}"`);
        }
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    empty === 0
      ? `✅ PASS — ${total}/${total} lượt nhắc đều có câu chữ gửi khách`
      : `❌ FAIL — ${empty}/${total} lượt nhắc bị RỖNG`,
  );
  process.exit(empty === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});

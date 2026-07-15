/**
 * smokeReplyVoice.ts — smoke ĐỌC CÂU reply chính sau khi hạ temp 0.85 → 0.6 (brain.ts).
 *
 * Mục tiêu: câu discovery tin-đầu (gym/bơi/yoga) — chỗ hay văng ngữ pháp ("nếu anh chưa tập
 * rồi") — giờ có đủ CHỦ NGỮ + đúng ngữ pháp + tự nhiên không? Reply ngẫu nhiên → chạy VÀI VÒNG.
 * Đây là ĐỌC câu (không assert cứng) — mắt người phán tự nhiên, script chỉ soi vài dấu hiệu cụt.
 *
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeReplyVoice.ts
 * ⚠ isBotEnabled ghi prod bot_controls → xong xoá dòng smk-rv-* khỏi bot_controls.
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

const ROUNDS = 2;
// Mảnh câu hỏi CỤT (thiếu chủ ngữ) — chỉ để soi nhanh, KHÔNG phải luật chặn (mắt người mới quyết).
const SUSPECT = ["chưa tập rồi", "chưa rồi", "đã chưa", "tập chưa ạ.", "biết chưa ạ."];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");

  const scen = [
    { key: "gym", first: "mình muốn tập gym" },
    { key: "boi", first: "cho hỏi bên mình dạy bơi không ạ" },
    { key: "yoga", first: "em muốn tập yoga" },
  ];

  for (let r = 0; r < ROUNDS; r++) {
    console.log("\n" + "█".repeat(70) + `  VÒNG ${r + 1}/${ROUNDS}`);
    for (const s of scen) {
      const sid = `smk-rv-${s.key}-${r}`;
      const res = await runAgentTurn({ mastra, threadId: sid, resourceId: sid, message: s.first });
      const bad = SUSPECT.filter((w) => res.reply.toLowerCase().includes(w));
      console.log(`\n  [${s.key}] KHÁCH: ${s.first}`);
      console.log(`         BOT  : ${res.reply}${bad.length ? `   ⚠️ NGHI CỤT: ${bad.join(",")}` : ""}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("👁  ĐỌC LẠI: câu hỏi có đủ chủ ngữ (anh/chị/mình) + đúng ngữ pháp + tự nhiên chưa?");
  console.log("⚠ Nhớ xoá bot_controls dòng 'smk-rv-*' sau smoke.");
  process.exit(0);
}
main().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });

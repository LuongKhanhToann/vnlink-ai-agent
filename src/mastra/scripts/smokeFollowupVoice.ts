/**
 * smokeFollowupVoice.ts — smoke GIỌNG tin nhắc follow-up (sau khi chuyển sang brain agent).
 *
 * Bug live 15/07: follow-up dùng agent legacy + prefix cũ → giọng sáo "em đang giữ mạch tư vấn
 * để sắp cho anh khung tập thư giãn". Fix: dùng brain agent (khớp giọng reply) + prompt nguyên tắc
 * + cho phép IM (__IMLANG__) khi không có gì đáng nói.
 *
 * Đọc CÂU CHỮ THẬT (reply ngẫu nhiên → chạy vài lần). Chạy:
 *   STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeFollowupVoice.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

// Từ ngữ sáo rỗng/nội bộ KHÔNG nên xuất hiện trong tin nhắn khách (chỉ để soi hồi quy, không phải prompt).
const JARGON = ["giữ mạch", "mạch tư vấn", "khung tập", "tối ưu", "lộ trình cá nhân hoá", "trải nghiệm dịch vụ"];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { generateFollowupReply } = await import("../routes/facebook");

  const scen = [
    { sid: "smk-fv-boi", title: "A · CÓ info (bé 7 tuổi học bơi) — nhắc phải móc vào bé/bơi", turns: ["cho hỏi bé 7 tuổi học bơi bên mình thế nào ạ"] },
    { sid: "smk-fv-vague", title: "B · MƠ HỒ (thư giãn → vg) — nhắc tự nhiên hoặc IM", turns: ["a muốn tập thư giãn", "vg"] },
  ];

  let jarHits = 0;
  for (const s of scen) {
    console.log("\n" + "█".repeat(72) + "\n" + s.title);
    for (const t of s.turns) {
      const r = await runAgentTurn({ mastra, threadId: s.sid, resourceId: s.sid, message: t });
      console.log(`  KHÁCH: ${t}\n  BOT  : ${r.reply}`);
    }
    console.log("  ── tin nhắc (khách im) × 3 ──");
    for (let i = 0; i < 3; i++) {
      const text = await generateFollowupReply(s.sid, i);
      if (text) {
        const bad = JARGON.filter((j) => text.toLowerCase().includes(j));
        if (bad.length) jarHits++;
        console.log(`  nhắc${i + 1}: "${text}"${bad.length ? `   ⚠️ SÁO: ${bad.join(",")}` : ""}`);
      } else {
        console.log(`  nhắc${i + 1}: (IM LẶNG — không gửi gì)`);
      }
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(jarHits === 0 ? "✅ Không thấy từ sáo/nội bộ. ĐỌC LẠI câu trên: có tự nhiên như người thật không?" : `⚠️ ${jarHits} câu dính từ sáo — đọc kỹ.`);
  console.log(`\n⚠ Nhớ xoá bot_controls dòng 'smk-fv-*' sau smoke.`);
  process.exit(0);
}
main().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });

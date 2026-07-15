/**
 * smokeFunnelVoice.ts — ĐỌC CÂU reply qua CẢ PHỄU (temp 0.6), soi câu ngớ ngẩn / rườm rà.
 *
 * Khác smokeReplyVoice (chỉ tin đầu): đây chạy hội thoại NHIỀU LƯỢT cả 2 nhánh
 * (fitness: discovery→giá→từ chối→chốt; giải cơ: đau→hiểu→giá→thử) — chỗ câu hay văng
 * không chỉ ở tin đầu. Mỗi lượt in reply THẬT để mắt người phán tự nhiên/đúng ngữ pháp.
 * SUSPECT chỉ là lưới soi nhanh — KHÔNG phải luật; đọc kỹ mới là chuẩn nghiệm thu.
 *
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeFunnelVoice.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

// Mảnh nghi cụt/sáo — CHỈ để chú ý, mắt người quyết. Không assert cứng.
const SUSPECT = [
  "chưa tập rồi", "chưa rồi", "đã chưa ", "giữ mạch", "mạch tư vấn", "khung tập",
  "note lại", "ghi nhận", "tuyệt vời", "lựa chọn đúng", "chuẩn rồi", "trải nghiệm dịch vụ",
];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");

  const convos = [
    {
      key: "fitness-funnel",
      turns: [
        "mình muốn tập gym",
        "chưa tập bao giờ, muốn tăng cân tí",
        "cao 1m70 nặng 55kg",
        "thế gói bao nhiêu tiền",
        "đắt thế",
        "thôi để mình qua tập thử xem",
        "chiều mai mình qua được không",
      ],
    },
    {
      key: "giaico-funnel",
      turns: [
        "dạo này cổ vai gáy đau mỏi quá bạn ơi",
        "chắc do ngồi máy tính nhiều, đau cả tháng nay rồi",
        "làm có đau không",
        "giá một buổi bao nhiêu",
        "ok cho mình thử 1 buổi",
      ],
    },
  ];

  // Chạy TỪNG nhánh (đỡ tốn token): `... smokeFunnelVoice.ts fitness|giaico`. Không truyền → chạy hết.
  const pick = process.argv[2];
  const run = pick ? convos.filter((c) => c.key.startsWith(pick)) : convos;

  let flags = 0, total = 0;
  for (const c of run) {
    const sid = `smk-fn-${c.key}`;
    console.log("\n" + "█".repeat(72) + "\n" + c.key);
    for (const t of c.turns) {
      const res = await runAgentTurn({ mastra, threadId: sid, resourceId: sid, message: t });
      total++;
      const bad = SUSPECT.filter((w) => res.reply.toLowerCase().includes(w));
      if (bad.length) flags++;
      console.log(`\n  KHÁCH: ${t}`);
      console.log(`  BOT  : ${res.reply}${bad.length ? `   ⚠️ NGHI: ${bad.join(",")}` : ""}`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(`${flags === 0 ? "✅" : "⚠️"} soi tự động: ${flags}/${total} câu dính mảnh nghi.`);
  console.log("👁  ĐỌC LẠI TỪNG CÂU: có câu nào cụt / sai ngữ pháp / rườm rà / máy móc không?");
  console.log("⚠ smoke gọi runAgentTurn (không đụng isBotEnabled) → không rò bot_controls.");
  process.exit(0);
}
main().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });

/**
 * smokePriceCheck.ts — verify BẢNG GIÁ mới (tháng 07/2026) qua engine LIVE (runAgentTurn).
 * Mỗi câu hỏi giá = 1 thread mới (fresh state) để đọc thẳng con số bot trả.
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokePriceCheck.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
process.env.ENGINE = "agent";

// [câu hỏi, số kỳ vọng thấy trong reply (bất kỳ 1 trong list)]
const CASES: Array<{ q: string; want: string[]; note: string }> = [
  { q: "em không mua gói tháng, bơi lẻ tính theo lượt thì bao nhiêu 1 lượt ạ", want: ["20", "30", "40"], note: "Vé bơi lẻ: <1m 20k / 1m-1m5 30k / >1m5 40k mỗi lượt" },
  { q: "em muốn thuê riêng 1 huấn luyện viên gym kèm theo giờ thì giá sao ạ", want: ["50", "50k", "50 nghìn"], note: "HLV Gym thuê theo giờ = 50k/giờ" },
  { q: "bên mình cho thuê nguyên phòng tập trọn gói không, giá thế nào", want: ["thoả thuận", "thỏa thuận", "trao đổi", "liên hệ", "sđt", "sale"], note: "Thuê phòng trọn gói = thoả thuận" },
  { q: "nhà em 4 người tập cùng thì tính sao ạ", want: ["14", "tặng", "thêm 1 người", "4 người"], note: "Gia đình: gói 3 người 14tr tặng thêm 1 người → 4 người vẫn 14tr" },
  { q: "học bơi bên mình có tặng thêm gì không ạ", want: ["1 tháng", "miễn phí", "biết bơi"], note: "Học bơi tặng 1 tháng bơi + cam kết biết bơi" },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/\./g, ".").replace(/\s+/g, " ");
}

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const stamp = Date.now();
  let pass = 0;

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const threadId = `smoke-price-${stamp}-${i}`;
    console.log("\n" + "═".repeat(72));
    console.log(`▶ CASE ${i + 1}: ${c.note}`);
    console.log(`[KH] ${c.q}`);
    try {
      const out = await runAgentTurn({ mastra, message: c.q, threadId, resourceId: threadId });
      console.log(`[BOT] ${out.reply}`);
      const r = norm(out.reply);
      const hit = c.want.filter((w) => r.includes(norm(w)));
      const ok = hit.length > 0;
      if (ok) pass++;
      console.log(`   ${ok ? "✅" : "⚠️ "} khớp số: [${hit.join(", ")}]  (kỳ vọng 1 trong: ${c.want.join(" | ")})`);
    } catch (e) {
      console.error(`[BOT] ✖ LỖI: ${(e as Error).message}`);
    }
  }
  console.log(`\n✔ smoke xong: ${pass}/${CASES.length} case có số khớp bảng mới.`);
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

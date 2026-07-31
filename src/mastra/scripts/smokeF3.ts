/**
 * smokeF3.ts — đo TỶ LỆ F3 (vợ chồng khác môn) có nêu thẻ RIÊNG từng môn không,
 * sau khi sửa teaching gia-dinh cho E5. Chạy nhiều vòng.
 * STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeF3.ts [ROUNDS=6]
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

const turns = ["2 vợ chồng mình muốn đăng ký, chồng tập gym còn vợ tập yoga thì tính thế nào em", "vậy tổng 2 người 1 năm là bao nhiêu"];

function hasSeparate(txt: string): boolean {
  const t = txt.toLowerCase();
  // đúng: nêu thẻ riêng Gym 4.5 + Yoga 5.8
  return (t.includes("4.5") && t.includes("5.8"));
}
function familyOnly(txt: string): boolean {
  const t = txt.toLowerCase();
  return t.includes("gia đình") && t.includes("12 triệu") && !(t.includes("4.5") && t.includes("5.8"));
}

async function main() {
  const rounds = Number(process.env.ROUNDS ?? "6");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  let sep = 0, famOnly = 0, other = 0;
  for (let r = 1; r <= rounds; r++) {
    const threadId = `f3-r${r}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`\n──── v${r} ────`);
    let lastReply = "";
    for (const msg of turns) {
      console.log(`KH: ${msg}`);
      try {
        const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
        lastReply = out.reply ?? "";
        console.log(`BOT: ${lastReply}`);
      } catch (e) { console.log(`✗ ${(e as Error)?.message}`); }
    }
    // đánh giá dựa trên tổng 2 lượt (nêu riêng ở bất kỳ lượt nào là đạt)
    const combined = lastReply;
    if (hasSeparate(combined)) { sep++; console.log("→ ✅ có thẻ riêng"); }
    else if (familyOnly(combined)) { famOnly++; console.log("→ 🏠 CHỈ gói gia đình (thiếu thẻ riêng)"); }
    else { other++; console.log("→ ? khác"); }
  }
  console.log(`\n=== F3 rate: có-thẻ-riêng=${sep}/${rounds}  chỉ-gia-đình=${famOnly}/${rounds}  khác=${other}/${rounds} ===`);
  process.exit(0);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

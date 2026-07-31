/**
 * smokeE5.ts — verify fix: doi_tuong=gia-dinh CHỈ khi 2+ người nhà.
 *  - E5/E5b: hỏi cho 1 người thân → KHÔNG được leo gói gia đình.
 *  - GD:     đăng ký cho CẢ NHÀ 3 người → PHẢI ra gói gia đình (không được vỡ chiều ngược).
 *  - F3:     vợ chồng khác môn → phải nêu thẻ riêng từng môn (không cộng sai).
 * STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeE5.ts [ROUNDS=2]
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

const SCN = [
  { id: "E5", name: "mẹ 60t huyết áp — 1 người", watch: "CẤM leo gói gia đình 2-3 người/12tr/14tr",
    turns: ["mẹ mình 60 tuổi bị cao huyết áp muốn tập nhẹ cho khoẻ thì bên em có phù hợp không", "bà cũng hay đau đầu gối nữa", "chi phí ra sao em"] },
  { id: "E5b", name: "bố tập gym — 1 người", watch: "1 người → giá gym 1 người, KHÔNG gói gia đình",
    turns: ["bố mình muốn đăng ký tập gym cho khoẻ", "giá thế nào em"] },
  { id: "GD", name: "CẢ NHÀ 3 người cùng tập full — PHẢI ra gói gia đình", watch: "PHẢI ra gói Gia đình (12tr/14tr) — không được vỡ chiều ngược",
    turns: ["nhà mình 3 người cả hai vợ chồng và mẹ muốn đăng ký tập full cùng nhau thì có gói gia đình không em", "giá bao nhiêu em"] },
  { id: "F3", name: "vợ chồng khác môn", watch: "nêu thẻ RIÊNG Gym 4.5 + Yoga 5.8, KHÔNG cộng sai",
    turns: ["2 vợ chồng mình muốn đăng ký, chồng tập gym còn vợ tập yoga thì tính thế nào em", "vậy tổng 2 người 1 năm là bao nhiêu"] },
];

function familyPkg(txt: string): boolean {
  const t = txt.toLowerCase();
  return t.includes("gia đình") && (t.includes("12 triệu") || t.includes("14 triệu") || t.includes("2 người") || t.includes("3 người"));
}

async function main() {
  const rounds = Number(process.env.ROUNDS ?? "2");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  for (let r = 1; r <= rounds; r++) {
    for (const s of SCN) {
      const threadId = `e5-${s.id}-r${r}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      console.log(`\n${"═".repeat(80)}\n▶ [v${r}] ${s.id} — ${s.name}\n  👁 ${s.watch}\n${"═".repeat(80)}`);
      for (const msg of s.turns) {
        console.log(`\nKH: ${msg}`);
        try {
          const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
          const reply = out.reply ?? "(rỗng)";
          const flag = familyPkg(reply) ? "  🏠 GÓI-GIA-ĐÌNH" : "";
          console.log(`BOT: ${reply}${flag}`);
        } catch (e) {
          console.log(`  ✗ LỖI: ${(e as Error)?.message}`);
        }
      }
    }
  }
  console.log("\n--- xong ---");
  process.exit(0);
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });

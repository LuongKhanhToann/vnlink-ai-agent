/**
 * smokeFfix.ts — smoke REPLY THẬT cho 5 fix đợt 0731-F (adversarial) + vài regression.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeFfix.ts [ROUNDS=2]
 * Eyeball reply (không oracle chuỗi — bài học false-positive trong memory).
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

interface Scn {
  id: string;
  name: string;
  watch: string; // điều cần soi bằng mắt
  turns: string[];
}
const SCN: Scn[] = [
  { id: "F7", name: "bé 8t tự đi bơi + trông bé", watch: "PHẢI: cần người lớn đi kèm; CẤM 'tự đến được'/'yên tâm gửi bé'",
    turns: ["bé nhà em 8 tuổi muốn cho đi học bơi mà bố mẹ bận không đưa đi được, bé tự đi có được không", "thế ở trung tâm có ai trông bé giúp không em", "vậy học phí 1 khoá bao nhiêu"] },
  { id: "F2", name: "bạn bảo tặng 3 tháng", watch: "CẤM xác nhận tặng 3 tháng/15 tháng; nói chưa có CT đó",
    turns: ["bạn em vừa đăng ký bảo giờ đăng ký gói năm được tặng thêm 3 tháng đúng không em", "thế đăng ký full 1 năm 7 triệu được tặng 3 tháng nhỉ", "vậy có tặng gì không em"] },
  { id: "F6", name: "web ghi 400k + không giảm được à", watch: "CẤM bịa gói 400k; turn3 'không giảm được à' KHÔNG lái sang giảm cân",
    turns: ["trên web bên mình em thấy ghi gym có 400k thôi mà", "thế lấy anh giá 400k như trên web đi", "không giảm được thật à"] },
  { id: "F3", name: "chồng gym vợ yoga", watch: "PHẢI nêu hướng mua thẻ RIÊNG từng môn, không chỉ đẩy gói gia đình 12tr",
    turns: ["2 vợ chồng mình muốn đăng ký, chồng tập gym còn vợ tập yoga thì tính thế nào em", "cả 2 đăng ký 1 năm luôn", "vậy tổng 2 người 1 năm là bao nhiêu"] },
  { id: "F4", name: "60->70kg rồi hỏi dư mấy cân", watch: "turn3 PHẢI nêu dư ~11kg (mốc 49-59kg), không lảng",
    turns: ["em muốn giảm cân, nữ cao 1m60 nặng 60kg", "à nhầm em 70kg chứ không phải 60", "vậy em dư mấy cân ạ"] },
  // ── regression: các case đã GIỮ VỮNG, đảm bảo fix không phá ──
  { id: "F1r", name: "regression: giá điện thoại giả 300k", watch: "vẫn GIỮ 500k, không cave",
    turns: ["gym 1 tháng bao nhiêu em", "ơ hôm qua anh gọi điện bên mình báo có 300k mà sao giờ 500k", "thế chốt cho anh 300k như báo hôm qua đi"] },
  { id: "F8r", name: "regression: mặc cả cứng", watch: "vẫn không giảm, gợi gói ngắn",
    turns: ["full 1 năm 7 triệu à, giảm cho anh 500k anh đăng ký luôn", "thôi giảm 300k cũng được, chốt nhé"] },
  { id: "E9r", name: "regression: gym -> con 7t bơi", watch: "học bơi 1.5tr, không leak thẻ gym",
    turns: ["gym 1 tháng bao nhiêu em", "à mà thôi, con mình 7 tuổi muốn học bơi thì học phí thế nào", "bé học 1 khoá bao nhiêu buổi em"] },
];

async function main() {
  const rounds = Number(process.env.ROUNDS ?? "2");
  const only = (process.argv[2] ?? "").toUpperCase();
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  for (let r = 1; r <= rounds; r++) {
    for (const s of SCN) {
      if (only && !s.id.toUpperCase().startsWith(only)) continue;
      const threadId = `ffix-${s.id}-r${r}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      console.log(`\n${"═".repeat(80)}\n▶ [v${r}] ${s.id} — ${s.name}\n  👁 ${s.watch}\n${"═".repeat(80)}`);
      for (const msg of s.turns) {
        console.log(`\nKH: ${msg}`);
        const t0 = Date.now();
        try {
          const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
          console.log(`BOT (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out.reply ?? "(rỗng)"}`);
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

/**
 * scripts/smokeKichban.ts — Kiểm 2 file kịch bản mới THẬT SỰ được retrieve + dùng.
 * (1) retrieveForTurn: câu hỏi tình huống có kéo được đoạn từ "Kịch bản AI – ..." không.
 * (2) runTurn: đọc reply thật xem có xử lý theo hướng kịch bản (đồng cảm + reframe + giải pháp mềm), không bịa.
 * STORAGE_BACKEND=libsql để không đụng prod.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeKichban.ts
 */
import "dotenv/config";
import { retrieveForTurn } from "../rag/retrieve";
import { runTurn } from "../engine/brain";

// Câu khách hay nói, nhắm trúng nội dung Doc 2 (rào cản giá/thời gian/nỗi sợ) + 1 câu chạm Doc 1.
const CASES: { msg: string; want: string }[] = [
  { msg: "gói của bên em đắt quá, anh chưa có đủ tiền", want: "Kịch bản AI" },
  { msg: "thôi để anh về suy nghĩ thêm đã rồi báo lại sau", want: "Kịch bản AI" },
  { msg: "anh sợ đăng ký xong lại lười không đi tập đều thì phí tiền", want: "Kịch bản AI" },
  { msg: "trung tâm hơi xa nhà anh, đi lại ngại quá", want: "Kịch bản AI" },
];

function titlesIn(block: string): string[] {
  const set = new Set<string>();
  const re = /\((?:\d+)\)\s*\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) set.add(m[1]);
  return [...set];
}

async function main() {
  let retrievePass = 0;
  for (let i = 0; i < CASES.length; i++) {
    const { msg, want } = CASES[i];
    const block = await retrieveForTurn({ message: msg, history: [] });
    const titles = titlesIn(block);
    const hit = titles.some((t) => t.includes(want));
    if (hit) retrievePass++;
    console.log(`\n════ [${i + 1}] 👤 ${msg}`);
    console.log(`   📚 nguồn retrieve: ${titles.length ? titles.join(" | ") : "(rỗng)"}`);
    console.log(`   ${hit ? "✅ CÓ đoạn từ file kịch bản mới" : "⚠ KHÔNG thấy file kịch bản trong nguồn"}`);
    const { reply } = await runTurn({ senderId: `smoke_kb_${i}`, message: msg });
    console.log(`🤖 ${reply}`);
  }
  console.log(`\n═══ RETRIEVE: ${retrievePass}/${CASES.length} câu kéo được file kịch bản mới ═══`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

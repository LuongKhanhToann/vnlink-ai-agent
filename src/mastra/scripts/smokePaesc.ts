/**
 * scripts/smokePaesc.ts — Reply THẬT qua runTurn để kiểm khối persona P.A.E.S.C mới có "ăn" không.
 * STORAGE_BACKEND=libsql để KHÔNG đụng prod. Mỗi câu 1 sender mới (không dính lịch sử).
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokePaesc.ts
 */
import "dotenv/config";
import { runTurn } from "../engine/brain";

const CASES = [
  "em nhịn ăn suốt mà cân nặng không giảm, giảm được tí lại tăng lại như cũ",
  "em béo mà sợ đi tập gym nặng vì hay đau khớp gối",
  "em muốn giảm cân mà bận lắm không có thời gian đi tập đều",
];

async function main() {
  const round = process.env.ROUND || "1";
  for (let i = 0; i < CASES.length; i++) {
    const sender = `smoke_paesc_${round}_${i}`;
    const msg = CASES[i];
    try {
      const { reply } = await runTurn({ senderId: sender, message: msg });
      console.log(`\n════ [${round}.${i + 1}] 👤 ${msg}`);
      console.log(`🤖 ${reply}`);
    } catch (e: any) {
      console.log(`\n════ [${round}.${i + 1}] 👤 ${msg}`);
      console.log(`✗ LỖI: ${e?.message ?? e}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

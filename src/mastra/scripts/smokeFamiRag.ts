/**
 * smokeFamiRag.ts — Chạy REPLY THẬT qua engine/brain (RAG + Gemini), đọc câu bot trả.
 * Dọn chat_history của sender test sau khi xong (không để rác).
 *   npx -y tsx src/mastra/scripts/smokeFamiRag.ts
 */
import "dotenv/config";
import { runTurn } from "../engine/brain";
import { retrieveDocs } from "../rag/retrieve";
import { clearHistory } from "../lib/history";

const SENDER = "smoke-fami-rag";

const CONVO = [
  "chào shop, mình bị thừa cân mấy năm nay muốn giảm cân mà sợ tập nặng",
  "gói tập gym giá bao nhiêu vậy shop",
  "mình hay đau mỏi vai gáy do ngồi văn phòng nhiều",
  "trung tâm ở đâu, mở cửa mấy giờ",
];

async function main() {
  // 1) Kiểm RAG có bám giá thật không (giá lấy từ tài liệu, không bịa).
  const priceBlock = await retrieveDocs("giá gói gym 12 tháng bao nhiêu tiền");
  console.log("─── RAG retrieve cho câu hỏi giá gym ───");
  console.log(priceBlock ? priceBlock.slice(0, 500) + "…" : "(RỖNG — không retrieve được!)");
  console.log("");

  // 2) Hội thoại thật, tuần tự (test cả lịch sử).
  await clearHistory(SENDER);
  for (const msg of CONVO) {
    const { reply } = await runTurn({ senderId: SENDER, message: msg });
    console.log("👤 " + msg);
    console.log("🤖 " + reply);
    console.log("");
  }
  await clearHistory(SENDER);
  console.log("(đã dọn chat_history của sender test)");
  process.exit(0);
}
main().catch((e) => {
  console.error("SMOKE FAIL:", e);
  process.exit(1);
});

/**
 * scripts/smokeNoTimeStamp.ts — Xác nhận bot KHÔNG còn chèn dấu giờ "(HH:MM)" ở ĐẦU câu trả lời.
 * Tái hiện đúng kịch bản ảnh khách gửi: hỏi giá bơi → hỏi cam kết giảm cân (nhiều lượt → có history
 * mang dấu giờ, đúng điều kiện khiến model bắt chước). Đọc REPLY THẬT qua pipeline (runTurn), chạy
 * vài lần vì reply ngẫu nhiên.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeNoTimeStamp.ts
 */
import "dotenv/config";
import { runTurn } from "../engine/brain";
import { stripLeadingStamp } from "../lib/timeContext";

const FLOW = [
  "chào em, bên mình có bơi cho người lớn không?",
  "giá gói bơi thế nào em?",
  "Khá hấp dẫn. Vậy sau 1 tháng bơi, liệu anh giảm được bao nhiêu kg, có cam kết không?",
];

/** true nếu chuỗi mở đầu bằng "(...)" đúng dạng dấu giờ — tức bot vẫn lỡ chèn. */
function startsWithStamp(reply: string): boolean {
  return stripLeadingStamp(reply) !== reply.trimStart();
}

async function main() {
  const RUNS = 3;
  let pass = 0;
  for (let r = 0; r < RUNS; r++) {
    const senderId = `smoke_ts_${r}`;
    console.log(`\n╔══ RUN ${r + 1}/${RUNS} (sender ${senderId}) ══`);
    let bad = false;
    for (let i = 0; i < FLOW.length; i++) {
      const { reply } = await runTurn({ senderId, message: FLOW[i] });
      const leaked = startsWithStamp(reply);
      if (leaked) bad = true;
      console.log(`\n👤 ${FLOW[i]}`);
      console.log(`🤖 ${reply}`);
      console.log(`   ${leaked ? "❌ VẪN có dấu giờ ở đầu!" : "✅ sạch"}`);
    }
    if (!bad) pass++;
  }
  console.log(`\n════════════════`);
  console.log(pass === RUNS ? `✅ ALL PASS (${pass}/${RUNS} run sạch)` : `❌ FAIL (${pass}/${RUNS} run sạch)`);
  process.exit(pass === RUNS ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke lỗi:", e);
  process.exit(1);
});

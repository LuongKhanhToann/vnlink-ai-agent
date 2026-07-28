/**
 * smokeFollowupGemma.ts — kiểm TIN NHẮC CHỦ ĐỘNG do CHÍNH gemma viết (không phải agent 5.4).
 *
 * Dựng 2 lượt hội thoại thật (để có state + lịch sử trong store gemma) rồi gọi runGemmaFollowup
 * với ĐÚNG chuỗi chỉ thị mà facebook.ts dựng, in ra tin nhắc để đọc bằng mắt.
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeFollowupGemma.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
process.env.ENGINE = "gemma";

const KNOWN_LINE = "Đã biết về khách: quan tâm boi.\n";

async function main() {
  const { mastra } = await import("../index");
  const { runGemmaTurn, runGemmaFollowup } = await import("../engine/gemmaBrain");
  const threadId = `smoke-nhac-${Date.now()}`;

  for (const msg of ["Tư vấn cho tôi khóa học bơi", "Mình chưa biết bơi"]) {
    const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
    console.log(`\nKH: ${msg}\nBOT: ${out.reply}`);
  }

  const daNhac: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const nhac = await runGemmaFollowup({ mastra, threadId, knownLine: KNOWN_LINE, attempt });
    console.log(
      `\n⏰ TIN NHẮC ${attempt + 1} (${((Date.now() - t0) / 1000).toFixed(1)}s): ${nhac ?? "(im lặng — không gửi gì)"}`,
    );
    if (!nhac) continue;
    if (/\[|đến 20h\b(?!30)/.test(nhac)) {
      console.log("   ❌ tin nhắc có chỗ trống để điền hoặc giờ bể SAI");
      process.exit(1);
    }
    if (daNhac.includes(nhac)) {
      console.log("   ❌ tin nhắc TRÙNG NGUYÊN VĂN tin trước");
      process.exit(1);
    }
    daNhac.push(nhac);
  }
  if (!daNhac.length) {
    console.log("\n❌ cả 3 lần đều im — tính năng nhắc chủ động coi như tắt");
    process.exit(1);
  }
  console.log(`\n✅ ${daNhac.length}/3 tin nhắc do gemma viết, không trùng nhau, không có chỗ trống / giờ sai`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

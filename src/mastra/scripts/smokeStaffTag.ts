/**
 * smokeStaffTag.ts — smoke REPLY THẬT xác nhận gemma thấy đúng tin nhân viên trả tay
 * (source:"staff") và không lặp/hỏi lại/lộ tiền tố đánh dấu ra khách.
 *
 * Kịch bản:
 *   1) Khách hỏi giá gym → gemma trả lời (turn thật qua runGemmaTurn).
 *   2) Mô phỏng NHÂN VIÊN trả tay lúc AI tắt (facebook.ts:recordStaffReply) — gọi thẳng
 *      appendGemmaHistory + saveState y hệt logic recordStaffReply, cho khách 1 thông tin
 *      CỤ THỂ (tên + giờ hẹn) mà gemma CHƯA từng biết.
 *   3) Khách nhắn tiếp (KHÔNG lặp lại thông tin đó) → đọc reply thật, kiểm tra:
 *        (a) không hỏi lại tên/giờ hẹn nhân viên vừa cho,
 *        (b) không lộ nguyên văn tiền tố "[Nhân viên đã nhắn thật cho khách]".
 *
 * Chạy:  STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeStaffTag.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

const STAFF_MARKER = "[Nhân viên đã nhắn thật cho khách]";

async function main() {
  const { mastra } = await import("../index");
  const { runGemmaTurn, appendGemmaHistory } = await import("../engine/gemmaBrain");
  const { loadState, saveState } = await import("../lib/stateStore");

  const threadId = `smoke-staff-${Date.now()}`;
  console.log(`▶ thread=${threadId}`);

  console.log(`\nKH: cho em hỏi giá tập gym ạ`);
  const t1 = await runGemmaTurn({
    mastra,
    message: "cho em hỏi giá tập gym ạ",
    threadId,
    resourceId: threadId,
  });
  console.log(`BOT: ${t1.reply}`);

  // ── mô phỏng nhân viên trả tay lúc AI tắt (y hệt facebook.ts:recordStaffReply) ──
  const staffText =
    "Dạ chị Hương ơi, bên em giữ chỗ chị lúc 5h chiều thứ 7 này rồi ạ, chị đến sớm 10 phút nhé.";
  console.log(`\n[NHÂN VIÊN trả tay]: ${staffText}`);
  await appendGemmaHistory(mastra, threadId, threadId, [
    { role: "assistant", content: staffText, source: "staff" },
  ]);
  const stAfterStaff = await loadState(mastra, threadId, threadId);
  await saveState(mastra, threadId, threadId, {
    ...stAfterStaff,
    lastBotReply: staffText,
    recentBotReplies: [...(stAfterStaff.recentBotReplies ?? []), staffText].slice(-4),
    lastReplySource: "staff",
  });

  // ── khách nhắn tiếp, KHÔNG lặp lại tên/giờ hẹn ──
  const followUp = "dạ vâng ạ, em xin phép đến muộn 15 phút được không ạ";
  console.log(`\nKH: ${followUp}`);
  const t2 = await runGemmaTurn({
    mastra,
    message: followUp,
    threadId,
    resourceId: threadId,
  });
  console.log(`BOT: ${t2.reply}`);

  const leaksMarker = t2.reply.includes(STAFF_MARKER);
  const asksNameAgain = /\b(tên (là )?gì|cho (em|anh|chị) xin tên)\b/i.test(t2.reply);
  const asksTimeAgain = /\b(mấy giờ|giờ nào|hẹn (lúc )?mấy)\b/i.test(t2.reply);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Lộ tiền tố đánh dấu ra khách?  ${leaksMarker ? "✗ CÓ (LỖI)" : "✓ không"}`);
  console.log(`Hỏi lại tên (đã có "Hương")?    ${asksNameAgain ? "✗ CÓ (LỖI)" : "✓ không"}`);
  console.log(`Hỏi lại giờ hẹn (đã có "5h thứ 7")? ${asksTimeAgain ? "✗ CÓ (LỖI)" : "✓ không"}`);

  const st = await loadState(mastra, threadId, threadId);
  console.log(`\n⚙ state.lastReplySource cuối cùng = ${st.lastReplySource} (kỳ vọng "bot" — turn thật ghi đè lại sau tin nhân viên)`);

  process.exit(leaksMarker || asksNameAgain || asksTimeAgain ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * smokeFollowupLoop.ts — smoke TẦNG LIVE: cap chống vòng-lặp tin nhắc.
 *
 * Bug live 13/07/2026 (thread 27646009638367967, "Tuyết Dư"): khách hỏi cho bé 7 tuổi rồi im.
 * Bot nhắc 2/10/60p; khách "Vg"/"Vg" (rỗng nghĩa) → mỗi tin reset chuỗi nhắc → bot nhắc LẶP LẠI
 * ~6 tin filler y hệt "nhắn khi rảnh em tư vấn gọn" trong 2.5h.
 *
 * Fix: state.followupCount đếm số nhắc từ lần khách TIẾN gần nhất; cap = FOLLOWUP_DELAYS_MS.length
 * (1 đợt). brain.ts reset về 0 khi khách tiến (điền slot/đổi stage). "Vg" KHÔNG tiến → cap giữ.
 *
 * Gọi ĐÚNG hàm production generateFollowupReply + runAgentTurn (KHÔNG bản sao).
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeFollowupLoop.ts
 *
 * ⚠ isBotEnabled ghi prod bot_controls → xong PHẢI xoá dòng smk-* (script tự nhắc ở cuối).
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";
// Hạ cap về 2 (2 phần tử) để chạm trần chỉ với 2 nhắc → tiết kiệm lượt LLM. Cap = độ dài mảng này.
process.env.FOLLOWUP_DELAYS_MS = "120000,600000";

const SID = "smk-fuloop-1";
const CAP = 2; // = FOLLOWUP_DELAYS_MS.length (đã set ở trên)

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { generateFollowupReply } = await import("../routes/facebook");
  const { loadState } = await import("../lib/stateStore");

  const count = async () => (await loadState(mastra, SID, SID)).followupCount ?? 0;
  const turn = async (m: string) => {
    const r = await runAgentTurn({ mastra, threadId: SID, resourceId: SID, message: m });
    console.log(`  KHÁCH: ${m}\n  BOT  : ${r.reply}   [followupCount=${await count()}]`);
    return r;
  };
  const nudge = async (attempt: number, label: string) => {
    const t = await generateFollowupReply(SID, attempt);
    const sent = !!t;
    console.log(`  ${label}: ${sent ? `✅ NHẮC "${t}"` : "⏸️  BỎ QUA (null)"}   [followupCount=${await count()}]`);
    return sent;
  };

  const fails: string[] = [];

  console.log("█ Bối cảnh: khách hỏi cho bé rồi im (giống ca lỗi) ".padEnd(76, "█"));
  await turn("cho hỏi bên mình có lớp cho bé 7 tuổi không ạ");

  console.log("\n── ĐỢT NHẮC 1 (khách im) — được nhắc tối đa " + CAP + " lần ──");
  const b1 = [await nudge(0, "đợt1·lần1"), await nudge(1, "đợt1·lần2")];
  if (b1.some((s) => !s)) fails.push(`Đợt 1 phải nhắc đủ ${CAP} lần (có lần bị null)`);
  if ((await count()) !== CAP) fails.push(`Sau đợt 1 followupCount phải = ${CAP}, đang = ${await count()}`);

  console.log('\n── Khách trả lời RỖNG NGHĨA "Vg" (KHÔNG tiến triển) ──');
  await turn("Vg");
  if ((await count()) !== CAP) fails.push(`Sau "Vg" followupCount phải GIỮ ${CAP} (không reset), đang = ${await count()}`);

  console.log("\n── ĐỢT NHẮC 2 (sau 'Vg') — PHẢI bị CAP chặn, KHÔNG nhắc lại filler ──");
  const b2 = await nudge(0, "đợt2·lần1");
  if (b2) fails.push("❗ Đợt 2 vẫn nhắc → CAP KHÔNG hoạt động (vòng lặp chưa bị chặn)");

  console.log("\n── Khách TIẾN THẬT: cho SĐT (điền slot mới, chắc chắn record) ──");
  await turn("sđt em là 0912345678 nhé");
  const afterAdvance = await count();
  if (afterAdvance !== 0) fails.push(`Sau khi khách tiến (điền slot), followupCount phải reset 0, đang = ${afterAdvance}`);

  console.log("\n" + "=".repeat(76));
  if (fails.length === 0) {
    console.log("✅ PASS — cap chặn đúng vòng lặp; 'Vg' không reset; khách tiến thì mở lại.");
  } else {
    console.log(`❌ FAIL (${fails.length}):`);
    for (const f of fails) console.log("   • " + f);
  }
  console.log(`\n⚠ NHỚ xoá bot_controls dòng '${SID}' khỏi prod PG sau smoke.`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});

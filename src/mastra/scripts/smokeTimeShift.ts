/**
 * smokeTimeShift.ts — Smoke REPLY THẬT cho nâng cấp: bối cảnh thời gian + kíp trực + giục ngủ >23h.
 *
 * KHÔNG đụng prod DB: dựng lịch sử tổng hợp (đúng đoạn chat lỗi trong ảnh) + docBlock="" rồi ghép
 * messages Y HỆT brain.ts và gọi generateReply thật. Ép "now" = 23:17 14/08 (ca đêm = Liên, late-night)
 * để kiểm: (1) không nhầm "hôm qua"; (2) hỏi tên → "Liên"; (3) sau 23h giục đi ngủ. Chạy vài lần vì
 * reply ngẫu nhiên. Có phần unit-check timeContext trước.
 */
import "dotenv/config";
import { generateReply, type ChatMsg } from "../llm/gemini";
import { FAMI_SYSTEM } from "../prompts/fami";
import { vnParts, buildTimeBlock, stampFor, shiftFor, isLateNight } from "../lib/timeContext";

// ── Unit: timeContext ──────────────────────────────────────────────
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("  ✗ FAIL:", msg); process.exitCode = 1; }
  else console.log("  ✓", msg);
}
console.log("== UNIT timeContext ==");
assert(shiftFor(7).name === "Trang", "07h → Trang (ca sáng)");
assert(shiftFor(12).name === "Xuân", "12h → Xuân (ca trưa)");
assert(shiftFor(15).name === "Thảo", "15h → Thảo (ca chiều)");
assert(shiftFor(20).name === "Vân", "20h → Vân (ca tối)");
assert(shiftFor(23).name === "Liên" && shiftFor(2).name === "Liên", "23h & 02h → Liên (ca đêm)");
assert(isLateNight(23) && isLateNight(1) && !isLateNight(14), "isLateNight: 23h,1h = true; 14h = false");
// 23:17 VN 14/08/2026 = 16:17Z
const NOW = vnParts(new Date("2026-08-14T16:17:00Z"));
assert(NOW.hour === 23 && NOW.minute === 17 && NOW.ddmmyyyy === "14/08/2026", `vnParts VN = ${NOW.weekdayVi} ${NOW.hhmm} ${NOW.ddmmyyyy}`);
assert(stampFor(new Date("2026-08-14T15:39:00Z"), NOW) === "22:39", "stamp cùng ngày → HH:MM (22:39)");
assert(stampFor(new Date("2026-08-13T15:39:00Z"), NOW) === "22:39 13/08", "stamp khác ngày → HH:MM DD/MM");
console.log(buildTimeBlock(NOW));

// ── Reply thật ─────────────────────────────────────────────────────
type H = { role: "user" | "assistant"; content: string; at: string };
// Đúng đoạn chat trong ảnh (rút gọn), giờ thật tối 14/08.
const HISTORY: H[] = [
  { role: "user", content: "Tôi muốn giảm cân bằng bơi", at: "2026-08-14T15:40:00Z" },
  { role: "assistant", content: "Dạ lựa chọn bơi để giảm cân chuẩn luôn ạ! Anh đã biết bơi chưa và muốn giảm mấy kg ạ?", at: "2026-08-14T15:40:00Z" },
  { role: "user", content: "Hẹn bạn mai tôi sẽ hỏi bạn tiếp. Giờ muộn rồi. Tôi sợ phải nhịn ăn lắm.", at: "2026-08-14T16:04:00Z" },
  { role: "assistant", content: "Dạ vâng, chúc anh ngủ ngon ạ! Ở Fami không bắt nhịn ăn đâu ạ. Mai rảnh anh nhắn em tư vấn tiếp nhé!", at: "2026-08-14T16:04:00Z" },
  { role: "user", content: "Bye", at: "2026-08-14T16:07:00Z" },
  { role: "assistant", content: "Dạ em chào anh, chúc anh ngủ ngon ạ! Hẹn anh mai em tư vấn tiếp nha.", at: "2026-08-14T16:08:00Z" },
];

function buildMessages(userMsg: string): ChatMsg[] {
  const systemContent = [FAMI_SYSTEM, buildTimeBlock(NOW)].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: systemContent },
    ...HISTORY.map((t) => ({ role: t.role, content: `(${stampFor(new Date(t.at), NOW)}) ${t.content}` }) as ChatMsg),
    { role: "user", content: `(${NOW.hhmm}) ${userMsg}` },
  ];
}

const CASES = [
  { name: "C1 khen-xinh (không được nói 'hôm qua')", user: "Chắc ở ngoài xinh lắm nhỉ ?" },
  { name: "C2 hỏi tên (phải là Liên)", user: "Quên mất. Em tên gì ?" },
  { name: "C3 vẫn muốn tư vấn lúc khuya (phải giục ngủ)", user: "Giờ tư vấn tiếp cho anh gói bơi được không?" },
];

async function main() {
  console.log("\n== REPLY THẬT (now=23:17 14/08, ca đêm Liên) ==");
  for (const c of CASES) {
    console.log(`\n--- ${c.name} ---\nKhách: ${c.user}`);
    for (let i = 1; i <= 2; i++) {
      try {
        const reply = (await generateReply(buildMessages(c.user), { temperature: 0.6, maxTokens: 500 })).trim();
        const low = reply.toLowerCase();
        const flags: string[] = [];
        if (/hôm qua|mấy hôm|bữa trước|ngày hôm qua/.test(low)) flags.push("⚠ nhắc 'hôm qua'");
        console.log(`  [lần ${i}] ${reply}${flags.length ? "   << " + flags.join(", ") : ""}`);
      } catch (e) {
        console.log(`  [lần ${i}] LỖI: ${(e as Error).message}`);
      }
    }
  }
}
main();

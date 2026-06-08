/**
 * Unit test cleanReply — verify fix:
 *   - splitSentences không break "1.2 triệu"
 *   - list-aware strip (giữ nguyên list hoặc strip cả block, không nhảy số)
 *   - typographic "1. 2 triệu" → "1.2 triệu" normalize
 */
import { cleanReply } from "../lib/cleanReply";

console.log("\n═══ Test 1: KH hỏi lại cùng pricing — anti-loop strip cụt? ═══");
const prev1 = "Học bơi 1-1 12 buổi là 3 triệu, hoặc nhóm 1.2 triệu 1 tháng bể.";
const cur1 = "Dạ bơi bên em bể 4 mùa duy nhất Vĩnh Yên. Học bơi 1-1 12 buổi là 3 triệu, hoặc nhóm 1.2 triệu 1 tháng bể. Anh/chị có lịch nào phù hợp ạ";
console.log("PREV :", prev1);
console.log("CUR  :", cur1);
const r1 = cleanReply(cur1, false, prev1);
console.log("CLEAN:", r1);
console.log(`     ${r1.length >= 30 && !/^[\d]\s/.test(r1) ? "✅" : "❌"} không cụt`);

console.log("\n═══ Test 2: bot output '1. 2 triệu' (typo) ═══");
const t2 = "Lớp nhóm 1. 2 triệu, 1 tháng bể.";
console.log("IN   :", t2);
console.log("CLEAN:", cleanReply(t2, false, ""));

console.log("\n═══ Test 3: Numbered list (1)(2)(3) không nhảy số ═══");
const prev3 = "Bên em có PT 20 buổi 6 triệu và Gym 4.5 triệu.";
const cur3 = "(1) PT 20 buổi 6 triệu — kèm sát. (2) Full 12 tháng 7 triệu — 1 thẻ 4 dịch vụ. (3) Gym 4.5 triệu — tự tập. Anh/chị chọn gói nào ạ";
console.log("PREV :", prev3);
console.log("CUR  :", cur3);
const r3 = cleanReply(cur3, false, prev3);
console.log("CLEAN:", r3);
// Mong đợi: hoặc giữ NGUYÊN list (vì có ≥2 list item), hoặc strip cả list. KHÔNG có "(1) ... (3)..." nhảy số.
const hasItem1 = r3.includes("(1)");
const hasItem3 = r3.includes("(3)");
const hasItem2 = r3.includes("(2)");
const jumpedNumbering = (hasItem1 && hasItem3 && !hasItem2) || (!hasItem1 && hasItem3);
console.log(`     ${!jumpedNumbering ? "✅" : "❌"} không nhảy số list`);

console.log("\n═══ Test 4: splitSentences với '1.2 triệu' ═══");
const t4 = "Học bơi 1-1 12 buổi 3 triệu. Lớp nhóm 1.2 triệu. Anh/chị chọn gói nào ạ";
console.log("IN   :", t4);
// Sentence count phải là 3 (không split "1.2" thành 2 câu)
const sentences = t4.split(/(?<=[.!?])(?!\d)\s+(?=\S)/);
console.log("SPLIT:", sentences);
console.log(`     ${sentences.length === 3 ? "✅" : "❌"} đúng 3 câu (không split '1.2')`);

console.log("\n═══ Test 5: NỚI Nhánh D — giữ ĐÚNG 1 dấu '?' ở câu hỏi cuối ═══");
const t5a = cleanReply("Dạ vâng anh, anh tiện tập buổi sáng hay chiều ạ?", false, "");
console.log("Q cuối   :", t5a, ` ${/ạ\?$/.test(t5a) && (t5a.match(/\?/g) || []).length === 1 ? "✅" : "❌"} giữ 1 '?'`);
const t5b = cleanReply("Anh đã tập gym chưa? Anh tiện sáng hay chiều ạ?", false, "");
console.log("2 Q      :", t5b, ` ${(t5b.match(/\?/g) || []).length === 1 ? "✅" : "❌"} còn 1 '?'`);
const t5c = cleanReply("Dạ vâng anh, em giữ slot 7h tối cho mình rồi nha.", false, "");
console.log("statement:", t5c, ` ${!/\?/.test(t5c) ? "✅" : "❌"} không thêm '?'`);
const t5d = cleanReply("Xem tại facebook.com/page?id=123 nhé anh", false, "");
console.log("URL ?id= :", t5d, ` ${/\?id=123/.test(t5d) ? "✅" : "❌"} giữ URL query`);

console.log("\n═══ Test 6: KH hỏi LẠI giá — KHÔNG bị anti-loop nuốt câu báo giá ═══");
const prev6 =
  "Bên em có lớp học bơi 1-1 12 buổi 3 triệu, kèm 3 tháng bể; nếu nhẹ hơn thì có lớp nhóm 1,2 triệu ạ. Anh/chị tiện khung giờ nào ạ?";
const raw6 =
  "Dạ 1 khóa học bơi 1-1 12 buổi là 3 triệu ạ. Nếu chị muốn em chốt luôn lịch thử cho bé thì chị tiện khung giờ nào ạ?";
const t6ask = cleanReply(raw6, false, prev6, "1 khóa hết bao nhiêu");
const t6noask = cleanReply(raw6, false, prev6, "ừ chị nghe");
console.log("KH hỏi giá   :", t6ask, ` ${/3 triệu/.test(t6ask) ? "✅" : "❌"} giữ câu báo giá`);
console.log("KH KHÔNG hỏi :", t6noask, ` ${!/3 triệu/.test(t6noask) ? "✅" : "❌"} vẫn dedup (no-regress)`);

process.exit(0);

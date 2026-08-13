/**
 * smokeClassifierKnobs.ts — kiểm phần "bóc knob nghiệp vụ cho admin" KHÔNG đổi hành vi mặc định.
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeClassifierKnobs.ts
 *
 * Trọng tâm AN TOÀN: với override RỖNG, prompt classifier + tin nhắc phải Y HỆT bản cũ (byte).
 * Không cần DB/LLM — chỉ kiểm logic ghép prompt + cổng validate.
 */
import {
  CLS_SYSTEM,
  buildClsSystem,
  buildClassifierMessages,
  validateClsKnob,
  CLS_KNOB_FLOW,
  CLS_KNOB_DOI_TUONG,
  CLS_KNOB_AN_TOAN,
  CLS_KNOB_MEDIA,
  CLS_KNOBS,
} from "../engine/gemma/classifier";
import { PROMPT_BLOCKS, FU_GOC_1, FU_GOC_2, FU_GOC_3 } from "../engine/gemma/prompt";
import { newState } from "../engine/gemma/state";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

console.log("── An toàn: default byte-identical ──");
// 1. Không override → prompt classifier y hệt CLS_SYSTEM (hành vi bot mặc định KHÔNG đổi).
ok("buildClsSystem({}) === CLS_SYSTEM", buildClsSystem({}) === CLS_SYSTEM);
ok("buildClsSystem(undefined) === CLS_SYSTEM", buildClsSystem() === CLS_SYSTEM);
// 2. Override rỗng/space cũng rơi về default.
ok("override rỗng → default", buildClsSystem({ cls_flow: "   " }) === CLS_SYSTEM);

console.log("── Knob default là LÁT CẮT thật của CLS_SYSTEM (không lệch) ──");
ok("CLS_SYSTEM chứa CLS_KNOB_FLOW", CLS_SYSTEM.includes(CLS_KNOB_FLOW) && CLS_KNOB_FLOW.startsWith("- flow:"));
ok("CLS_SYSTEM chứa CLS_KNOB_DOI_TUONG", CLS_SYSTEM.includes(CLS_KNOB_DOI_TUONG) && CLS_KNOB_DOI_TUONG.startsWith("- doi_tuong:"));
ok("CLS_SYSTEM chứa CLS_KNOB_AN_TOAN", CLS_SYSTEM.includes(CLS_KNOB_AN_TOAN) && CLS_KNOB_AN_TOAN.startsWith("- an_toan:"));
ok("CLS_SYSTEM chứa CLS_KNOB_MEDIA", CLS_SYSTEM.includes(CLS_KNOB_MEDIA) && CLS_KNOB_MEDIA.startsWith("- media:"));

console.log("── Override áp đúng chỗ, không đụng phần khác ──");
const SENTINEL = "- flow: ĐÂY_LÀ_QUY_TẮC_TÙY_CHỈNH fitness giai-co chua-ro";
const sysOv = buildClsSystem({ cls_flow: SENTINEL });
ok("override cls_flow xuất hiện trong prompt", sysOv.includes("ĐÂY_LÀ_QUY_TẮC_TÙY_CHỈNH"));
ok("đoạn flow default đã bị thay", !sysOv.includes(CLS_KNOB_FLOW));
ok("phần media (không sửa) vẫn nguyên", sysOv.includes(CLS_KNOB_MEDIA));
ok("chỉ đổi đúng 1 chỗ (độ dài lệch = lệch nội dung flow)", sysOv.length === CLS_SYSTEM.length - CLS_KNOB_FLOW.length + SENTINEL.length);

console.log("── buildClassifierMessages truyền override xuống system ──");
const s = newState();
const msgsDefault = buildClassifierMessages(s, "", "alo em ơi");
ok("messages mặc định dùng CLS_SYSTEM", msgsDefault[0].content === CLS_SYSTEM);
const msgsOv = buildClassifierMessages(s, "", "alo em ơi", { cls_flow: SENTINEL });
ok("messages có override dùng prompt đã ghép", msgsOv[0].content.includes("ĐÂY_LÀ_QUY_TẮC_TÙY_CHỈNH"));

console.log("── Cổng validate: chặn xoá mã hệ thống ──");
ok("thiếu 'giai-co' → báo lỗi", validateClsKnob("cls_flow", "chỉ nói fitness và chua-ro") !== null);
ok("đủ 3 mã flow → hợp lệ", validateClsKnob("cls_flow", "fitness / giai-co / chua-ro tuỳ ý viết lại") === null);
ok("cls_media thiếu 'none' → lỗi", validateClsKnob("cls_media", "fitness-gym mr-general") !== null);
ok("key thường (voice) không bị kiểm knob", validateClsKnob("voice", "gì cũng được") === null);
ok("cls_an_toan giữ đủ 5 mã → hợp lệ", validateClsKnob("cls_an_toan", "khong bau sau-sinh benh-nen cap-tinh") === null);

console.log("── Registry admin có đủ knob mới, default khớp ──");
const byKey = (k: string) => PROMPT_BLOCKS.find((b) => b.key === k);
for (const { key, def } of CLS_KNOBS) {
  const blk = byKey(key);
  ok(`PROMPT_BLOCKS có ${key} + default khớp lát cắt`, !!blk && blk.default === def && blk.group.includes("Phân loại"));
}
for (const [key, def] of [["fu_goc_1", FU_GOC_1], ["fu_goc_2", FU_GOC_2], ["fu_goc_3", FU_GOC_3]] as const) {
  const blk = byKey(key);
  ok(`PROMPT_BLOCKS có ${key} + default khớp`, !!blk && blk.default === def && blk.group.includes("nhắc"));
}
ok("mọi knob mới có desc (gợi ý admin)", ["cls_flow", "cls_doi_tuong", "cls_an_toan", "cls_media", "fu_goc_1"].every((k) => !!byKey(k)?.desc));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

/**
 * smokeKnowledge.ts — kiểm tra tầng kiến thức động (Pha 1), KHÔNG gọi LLM, KHÔNG cần DB.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeKnowledge.ts
 *
 * Cố tình XÓA env PG_* để buộc loadKnowledge đi nhánh fail-open (offline) — không đụng Supabase.
 */
for (const k of Object.keys(process.env)) if (k.startsWith("PG_DATABASE")) delete process.env[k];

import { buildSystemPrompt, PROMPT_BLOCKS } from "../engine/gemma/prompt";
import { buildDateBlock } from "../engine/gemma/dates";
import { buildPriceDirective, DEFAULT_PRICE_DATA, type PriceData } from "../engine/gemma/pricing";
import { loadKnowledge } from "../lib/knowledgeStore";
import type { ConvState } from "../engine/gemma/state";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

const date = buildDateBlock();

// ── 1. Default = bản live (mọi cục default có mặt trong prompt) ──
console.log("1. Prompt mặc định (không override):");
const sysDefault = buildSystemPrompt(date, "fitness", {});
for (const b of PROMPT_BLOCKS.filter((x) => x.key === "voice" || x.key === "ranh_gioi" || x.key === "closing")) {
  ok(`chứa cục ${b.key}`, sysDefault.includes(b.default));
}
ok("nhánh fitness ghép đủ 7 field fitness", ["f_thongtin", "f_nhucau", "f_giaiphap", "f_quytrinh", "f_tinhhuong", "f_hoidap", "f_tuchoi"].every((k) => sysDefault.includes(PROMPT_BLOCKS.find((b) => b.key === k)!.default)));
ok("nhánh fitness KHÔNG lẫn field giải cơ", !sysDefault.includes(PROMPT_BLOCKS.find((b) => b.key === "g_thongtin")!.default));
const sysGiaiCo = buildSystemPrompt(date, "giai-co", {});
ok("nhánh giải cơ ghép đủ 7 field giải cơ", ["g_thongtin", "g_nhucau", "g_giaiphap", "g_quytrinh", "g_tinhhuong", "g_hoidap", "g_tuchoi"].every((k) => sysGiaiCo.includes(PROMPT_BLOCKS.find((b) => b.key === k)!.default)));
ok("nhánh giải cơ KHÔNG lẫn field fitness", !sysGiaiCo.includes(PROMPT_BLOCKS.find((b) => b.key === "f_thongtin")!.default));

// ── 2. Override thay ĐÚNG cục, KHÔNG đụng cục khác ──
console.log("2. Override 1 cục:");
const sysOv = buildSystemPrompt(date, "fitness", { voice: "VĂN PHONG TÙY CHỈNH XYZ" });
ok("prompt chứa nội dung override", sysOv.includes("VĂN PHONG TÙY CHỈNH XYZ"));
ok("cục khác (ranh giới) vẫn nguyên", sysOv.includes(PROMPT_BLOCKS.find((b) => b.key === "ranh_gioi")!.default));
const sysEmpty = buildSystemPrompt(date, "fitness", { voice: "   " });
ok("override rỗng/space → rơi về default", sysEmpty.includes(PROMPT_BLOCKS.find((b) => b.key === "voice")!.default));

// ── 3. Giá mặc định có số thật; override đổi đúng số ──
console.log("3. Bảng giá:");
const conv = { flow: "fitness", boMon: "gym", doiTuong: "", hoiGiaTurn: true } as unknown as ConvState;
const dirDefault = buildPriceDirective(conv, "the-tap");
ok("giá gym mặc định 4.5 triệu (12 tháng)", dirDefault.includes("4.5 triệu"));
ok("giá gym mặc định 1 tháng 500 nghìn", dirDefault.includes("500 nghìn"));

const custom: PriceData = JSON.parse(JSON.stringify(DEFAULT_PRICE_DATA));
custom.cards.GYM.moc = [["1 tháng", "555 nghìn"], ["3 tháng", "1.5 triệu"], ["6 tháng", "2.5 triệu"], ["12 tháng", "4.9 triệu"]];
const dirCustom = buildPriceDirective(conv, "the-tap", custom);
ok("override đổi giá gym → 4.9 triệu", dirCustom.includes("4.9 triệu"));
ok("override đổi giá gym → 555 nghìn", dirCustom.includes("555 nghìn"));
ok("giá cũ 4.5 triệu KHÔNG còn khi override", !dirCustom.includes("4.5 triệu"));

// ── 4. loadKnowledge fail-open (không DB) → default ──
console.log("4. loadKnowledge offline (fail-open):");
const k = await loadKnowledge();
ok("blocks rỗng khi chưa cấu hình", Object.keys(k.blocks).length === 0);
ok("prices = default (gym 12 tháng)", k.prices.cards.GYM.moc[3][1] === DEFAULT_PRICE_DATA.cards.GYM.moc[3][1]);
ok("đủ 9 card mặc định", Object.keys(k.prices.cards).length === 9);
ok("promos rỗng khi chưa cấu hình (prompt không đổi)", k.promos === "");

// ── 5. Khối ưu đãi chỉ chèn khi CÓ đợt (rỗng = prompt y hệt bản cũ) ──
console.log("5. Chèn khối khuyến mãi:");
const sysNoPromo = buildSystemPrompt(date, "fitness", {}, "");
ok("promoBlock rỗng → prompt = bản không ưu đãi", sysNoPromo === sysDefault);
const promoTxt = "═══ CHƯƠNG TRÌNH ƯU ĐÃI ĐANG ÁP DỤNG ═══\n- Khai xuân: tặng 1 tháng";
const sysPromo = buildSystemPrompt(date, "fitness", {}, promoTxt);
ok("promoBlock có nội dung → prompt chứa ưu đãi", sysPromo.includes("Khai xuân: tặng 1 tháng"));
ok("khối ưu đãi nằm trước phần ranh giới", sysPromo.indexOf("Khai xuân") < sysPromo.indexOf(PROMPT_BLOCKS.find((b) => b.key === "ranh_gioi")!.default));

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

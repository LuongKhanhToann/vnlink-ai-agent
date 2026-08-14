/**
 * scripts/smokeRagAudit.ts — AUDIT TOÀN DIỆN pipeline RAG ở quy mô hiện tại.
 * Phủ mọi loại truy vấn/luồng, assert theo ground-truth từ tài liệu Fami.
 *   npx -y tsx src/mastra/scripts/smokeRagAudit.ts
 * Thoát mã ≠0 nếu có case FAIL.
 *
 * LEVEL A — Retrieval: retrieveForTurn phải LẤY ĐÚNG ĐỦ đoạn (assert số/keyword có trong khối).
 * LEVEL B — Reply thật: runTurn phải TRẢ ĐÚNG giá + không bịa (đọc câu chữ bot).
 */
import "dotenv/config";
import { retrieveForTurn } from "../rag/retrieve";
import { runTurn } from "../engine/brain";
import { clearHistory } from "../lib/history";

type Turn = { role: "user" | "assistant"; content: string };
let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name} ${detail}`); }
};

// Thử lại 1 lần cho case kỳ vọng CÓ nội dung (lọc nhiễu transient Gemini free-tier).
async function retrieveRetry(message: string, history?: Turn[], expectEmpty = false): Promise<string> {
  let b = await retrieveForTurn({ message, history });
  if (!expectEmpty && !b) b = await retrieveForTurn({ message, history });
  return b;
}

// ── LEVEL A: các case retrieval (assert theo ground-truth) ──
interface ACase {
  name: string;
  msg: string;
  history?: Turn[];
  all?: string[];   // block phải chứa TẤT CẢ
  any?: string[];   // block phải chứa ÍT NHẤT 1
  empty?: boolean;  // block phải rỗng (bỏ tra cứu)
}
const A: ACase[] = [
  { name: "Giá GYM", msg: "gói gym 12 tháng bao nhiêu tiền", all: ["4500"], any: ["GYM"] },
  { name: "Giá YOGA", msg: "tập yoga 1 năm giá thế nào", all: ["5800"], any: ["YOGA"] },
  { name: "Giá BƠI người lớn", msg: "gói bơi cho người lớn giá bao nhiêu", any: ["BƠI NL", "700", "2500"] },
  { name: "Giá BƠI trẻ em", msg: "cho bé đi bơi thì bao nhiêu tiền một tháng", any: ["3600", "600", "BƠI TE"] },
  { name: "Giá gói FULL", msg: "gói tập tất cả dịch vụ giá bao nhiêu", any: ["7200", "FULL"] },
  { name: "Gói giảm cân", msg: "có gói nào cam kết giảm cân không", any: ["Giảm cân", "3900", "cam kết"] },
  { name: "Dạy học bơi 1-1", msg: "học bơi kèm riêng 1 kèm 1 giá sao", any: ["3000", "HỌC BƠI", "1-1"] },
  { name: "Khuyến mại gói năm", msg: "đăng ký gói 12 tháng có tặng gì không", any: ["Tặng", "giải cơ", "tư vấn"] },
  { name: "Địa chỉ + giờ mở cửa", msg: "trung tâm ở đâu mở cửa mấy giờ", any: ["5h00", "20h00", "Vĩnh"] },
  { name: "Pilates", msg: "bên mình có tập pilates không", any: ["Pilates", "Reformer", "1:7", "1:1"] },
  { name: "Yoga giáo viên", msg: "lớp yoga ai dạy vậy", any: ["Ấn Độ"] },
  { name: "Xông hơi (tiện ích)", msg: "có phòng xông hơi không shop", any: ["xông hơi", "Xông hơi"] },
  {
    name: "Nối tiếp (bơi bé → còn cái kia)",
    msg: "còn cái kia thì bao nhiêu?",
    history: [
      { role: "user", content: "cho hỏi gói bơi cho bé" },
      { role: "assistant", content: "Dạ bên em có lớp bơi cho bé ạ." },
    ],
    any: ["3600", "600", "BƠI TE", "bơi"],
  },
  { name: "No-accent (khách gõ không dấu)", msg: "gia goi gym 12 thang bao nhieu", all: ["4500"], any: ["GYM"] },
  { name: "Câu ngắn mơ hồ có ngữ cảnh", msg: "bao nhiêu tiền", history: [
      { role: "user", content: "mình muốn tập gym" },
      { role: "assistant", content: "Dạ Fami có phòng gym rộng 800m2 ạ." },
    ], any: ["GYM", "4500", "500"] },
  { name: "Chào hỏi → bỏ tra cứu", msg: "alo shop ơi", empty: true },
  { name: "Cảm ơn → bỏ tra cứu", msg: "ok cảm ơn shop nhiều nha", empty: true },
];

async function levelA() {
  console.log("\n════════ LEVEL A — RETRIEVAL (lấy đúng đủ tài liệu) ════════");
  for (const c of A) {
    const block = await retrieveRetry(c.msg, c.history, c.empty);
    if (c.empty) { ok(c.name, block === "", `(len=${block.length})`); continue; }
    let cond = true;
    let why = "";
    if (c.all) for (const s of c.all) if (!block.includes(s)) { cond = false; why += `thiếu "${s}" `; }
    if (c.any && !c.any.some((s) => block.includes(s))) { cond = false; why += `không có bất kỳ [${c.any.join(", ")}] `; }
    ok(c.name, cond, why ? `— ${why}(block ${block.length} ký tự)` : "");
  }
}

// ── LEVEL B: reply thật (đọc câu bot, assert giá đúng + không bịa) ──
interface BCase { name: string; msg: string; mustInclude?: string[]; mustNotFabricate?: RegExp; }
const B: BCase[] = [
  { name: "Giá gym (đúng 500/1450/2550/4500)", msg: "gói tập gym giá bao nhiêu vậy shop",
    mustInclude: ["4.500", "500"] },
  { name: "Giá bơi trẻ em (3.600 cho 12T)", msg: "cho bé nhà mình đi bơi thì gói 1 năm bao nhiêu",
    mustInclude: ["3.600"] },
  { name: "Không bịa dịch vụ ngoài KB (bán tạ tay)", msg: "shop có bán tạ tay mang về nhà tập không",
    mustNotFabricate: /\d{2,3}[.,]?\d{3}\s*(đ|k|nghìn|ngàn)/i },
  { name: "Giờ mở cửa (5h-20h)", msg: "mấy giờ trung tâm đóng cửa", mustInclude: ["20"] },
];

async function levelB() {
  console.log("\n════════ LEVEL B — REPLY THẬT (trả đúng + không bịa) ════════");
  for (const c of B) {
    const sender = `audit-${c.name.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`;
    await clearHistory(sender);
    let reply = "";
    try { reply = (await runTurn({ senderId: sender, message: c.msg })).reply; }
    catch (e) { reply = `__ERROR__ ${(e as Error).message}`; }
    console.log(`\n👤 ${c.msg}\n🤖 ${reply}`);
    if (c.mustInclude) {
      const miss = c.mustInclude.filter((s) => !reply.includes(s));
      ok(c.name, miss.length === 0, miss.length ? `— thiếu số: ${miss.join(", ")}` : "");
    }
    if (c.mustNotFabricate) {
      ok(c.name, !c.mustNotFabricate.test(reply), "— có vẻ bịa một con số giá không có trong KB");
    }
    await clearHistory(sender);
  }
}

// ── Chế độ thoát hiểm RAG_MODE=basic vẫn lấy được tài liệu ──
async function levelBasic() {
  console.log("\n════════ ESCAPE HATCH — RAG_MODE=basic ════════");
  const prev = process.env.RAG_MODE;
  process.env.RAG_MODE = "basic";
  const block = await retrieveForTurn({ message: "gói gym 12 tháng bao nhiêu tiền" });
  ok("basic mode lấy được đoạn gym", block.includes("GYM") || block.includes("4500"), `(len=${block.length})`);
  if (prev === undefined) delete process.env.RAG_MODE; else process.env.RAG_MODE = prev;
}

async function main() {
  await levelA();
  await levelBasic();
  await levelB();
  console.log(`\n═══════════════════════════════════════`);
  console.log(`TỔNG: ${pass} PASS / ${fail} FAIL`);
  if (fail) console.log(`FAIL: ${fails.join(" | ")}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("audit lỗi:", e); process.exit(2); });

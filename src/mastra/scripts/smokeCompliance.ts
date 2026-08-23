/**
 * scripts/smokeCompliance.ts — Smoke SÂU: vừa chạy TÌNH HUỐNG theo bộ môn, vừa soi bot TUÂN THỦ QUY TẮC.
 *
 * Mỗi lượt đi qua pipeline runTurn ĐÚNG 1 lần (dùng debug-return). Ngoài việc IN REPLY THẬT để đọc,
 * còn tự kiểm bất biến GIÁ (tái dùng extractMoneyTokens của L6): nếu reply nêu số tiền mà facts rỗng
 * → BỊA GIÁ (lẽ ra L6 đã chặn). Các quy tắc tinh tế (chỉ-nhắn-tin, không-tự-chặn-y-tế) được IN kèm
 * GỢI Ý lexical nhẹ (đọc kỹ để phán, KHÔNG dùng làm verdict tự động).
 *
 * Chạy:  SCENARIO_DEBUG=1 npx -y tsx src/mastra/scripts/smokeCompliance.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { runTurn } from "../engine/brain";
import { extractMoneyTokens } from "../engine/compliance";

process.env.SCENARIO_MODE = process.env.SCENARIO_MODE === "off" ? "off" : "on";
process.env.SCENARIO_DEBUG = "1";

type Check = "expect_price" | "no_price_invent" | "messaging_only" | "no_medical_block" | "none";

interface Case {
  name: string;
  turns: string[];
  check: Check;
  note?: string;
}

const CASES: Case[] = [
  // ── NHÓM A: TÌNH HUỐNG theo bộ môn (giá phải lấy từ RAG) ──
  {
    name: "A1 · Bơi trẻ em — hỏi dò giá",
    turns: ["Bên mình dạy bơi cho bé giá bao nhiêu em? có gói nào rẻ ko?"],
    check: "expect_price",
    note: "mong: giá ~1.5tr từ RAG + diễn theo văn kịch bản (bể 4 mùa, tặng tháng bơi), có FOMO mời tới.",
  },
  {
    name: "A2 · Gym — hỏi giá cộc lốc",
    turns: ["gym bao nhiêu 1 tháng em"],
    check: "expect_price",
    note: "mong: nêu đúng mốc giá gym (tháng/năm) từ RAG, đào mục tiêu ẩn, không bịa số.",
  },
  {
    name: "A3 · Bơi 4 mùa theo năm",
    turns: ["cho anh hỏi bơi cả năm ở bên em giá thế nào"],
    check: "expect_price",
  },
  {
    name: "A4 · Yoga nữ",
    turns: ["yoga bên em tập kiểu gì, học phí sao em"],
    check: "expect_price",
  },
  {
    name: "A5 · Nam bận rộn sợ mua gói năm bỏ phí (kịch bản metabolic_male-05)",
    turns: ["Gói 1 năm anh nghe cũng hợp lý, nhưng anh bận lắm, mua xong khéo tuần đi 1 buổi rồi vứt xó. Thôi để anh nghĩ thêm."],
    check: "none",
    note: "mong: đánh trúng 'thiếu kỷ luật', chào gói Gym&Bơi 12T (6,3tr từ RAG) + đồng hành HLV, FOMO trong ngày.",
  },

  // ── NHÓM B: QUY TẮC ──
  {
    name: "B1 · Hỏi giá dịch vụ KHÔNG có trong bảng giá (PT 1 kèm 1) — không được bịa số",
    turns: ["cho anh hỏi gói PT tập riêng 1 thầy 1 trò cả khoá giá chính xác bao nhiêu tiền"],
    check: "no_price_invent",
    note: "PT 1-1 trọn khoá không có mốc giá trong tài liệu → bot KHÔNG được phịa con số; phải mời tới/để lại SĐT.",
  },
  {
    name: "B2 · Chỉ nhắn tin — khách rủ gọi điện",
    turns: ["em gọi điện thoại tư vấn trực tiếp cho anh được không, anh ngại nhắn tin lắm"],
    check: "messaging_only",
    note: "mong: bot KHÔNG hứa gọi điện; khéo chuyển sang nhắn tin / mời tới trung tâm 32A Nguyễn Chí Thanh.",
  },
  {
    name: "B3 · Không tự chặn y tế + P.A.E.S.C cảm xúc (2 lượt)",
    turns: [
      "anh bị thoát vị đĩa đệm với mỡ máu hơi cao, giờ tập gym có được không hay lại hại thêm",
      "nhưng anh sợ tập nặng cái lưng lại đau hơn",
    ],
    check: "no_medical_block",
    note: "mong: tự tin dùng ẩn dụ y khoa (Archimedes/không trọng lực, ty thể...) và VẪN bán; KHÔNG từ chối kiểu 'em không phải bác sĩ, anh đi khám đi' rồi dừng.",
  },
];

// ── Gợi ý lexical NHẸ (chỉ để lưu ý khi đọc, KHÔNG phải verdict tự động) ──
function phoneHint(reply: string): string {
  const low = reply.toLowerCase();
  const promises = ["em gọi", "sẽ gọi", "gọi cho anh", "gọi cho chị", "gọi điện cho", "gọi lại cho", "xin số để gọi", "gọi tư vấn cho"];
  const hit = promises.filter((p) => low.includes(p));
  return hit.length ? `⚠ có cụm nghi HỨA GỌI: [${hit.join(", ")}] — đọc kỹ` : "· không thấy cụm hứa-gọi";
}
function medicalBlockHint(reply: string): string {
  const low = reply.toLowerCase();
  const refuse = ["em không phải bác sĩ", "không phải là bác sĩ", "em không thể tư vấn", "nên đi khám bác sĩ", "anh nên đến bệnh viện", "em không dám tư vấn"];
  const hit = refuse.filter((p) => low.includes(p));
  return hit.length ? `⚠ có cụm nghi TỰ CHẶN Y TẾ: [${hit.join(", ")}] — đọc kỹ xem có bỏ bán không` : "· không thấy cụm né-y-tế";
}
/** Chuẩn hoá số để dò lỏng token tiền trong facts (bỏ mọi ký tự không phải số). */
const digits = (s: string) => s.replace(/[^\d]/g, "");
function priceGrounding(reply: string, facts: string): string {
  const money = extractMoneyTokens(reply);
  if (!money.length) return "· reply không nêu số tiền";
  const factDigits = digits(facts);
  const rows = money.map((m) => {
    const d = digits(m);
    const grounded = d.length >= 3 && factDigits.includes(d);
    return `${m}${grounded ? "✓" : "✗?"}`;
  });
  return `số tiền trong reply: ${rows.join(", ")}  (✓=thấy trong tài liệu, ✗?=đọc kỹ xem có đúng ngữ cảnh)`;
}

async function cleanup() {
  const pool = new Pool({
    host: process.env.PG_DATABASE_HOST!,
    port: Number(process.env.PG_DATABASE_PORT!),
    user: process.env.PG_DATABASE_USER!,
    password: process.env.PG_DATABASE_PASSWORD!,
    database: process.env.PG_DATABASE_NAME!,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  for (const t of ["chat_history", "conversation_state", "scheduled_job"]) {
    await pool
      .query(`DELETE FROM ${t} WHERE sender_id LIKE '__smoke_cmp%'`)
      .catch((e) => console.warn(`dọn ${t}: ${(e as Error).message}`));
  }
  await pool.end();
}

async function main() {
  console.log(`\n===== SMOKE TUÂN-THỦ + TÌNH-HUỐNG (SCENARIO_MODE=${process.env.SCENARIO_MODE}) =====`);
  const fails: string[] = [];
  let idx = 0;
  for (const c of CASES) {
    idx++;
    const senderId = `__smoke_cmp_${idx}`;
    console.log(`\n════════════ ${c.name} ════════════`);
    if (c.note) console.log(`  · kỳ vọng: ${c.note}`);
    let turnNo = 0;
    for (const msg of c.turns) {
      turnNo++;
      const t0 = Date.now();
      const { reply, debug } = await runTurn({ senderId, message: msg });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n[Khách] ${msg}`);
      if (debug)
        console.log(
          `  ↳ route(${secs}s): service=${debug.service} seg=${debug.segment} obj=[${debug.objections}] ${debug.stageFrom}→${debug.stageTo} | kịch bản=${debug.scenarios} | facts=${debug.factsLen}c | fq=${debug.factQuery ?? "null"}`,
        );
      console.log(`[Bot] ${reply}`);

      // ── kiểm bất biến (chỉ trên lượt cuối của case cho các check phụ thuộc kết quả) ──
      const money = extractMoneyTokens(reply);
      const factsLen = debug?.factsLen ?? 0;
      // (A) Bất biến CỨNG: nêu tiền mà facts rỗng ⇒ BỊA GIÁ (L6 lẽ ra chặn).
      if (money.length && factsLen === 0) {
        const f = `${c.name} [lượt ${turnNo}]: ❌ BỊA GIÁ — reply có [${money.join(", ")}] nhưng facts rỗng`;
        console.log(`  ${f}`);
        fails.push(f);
      }
      // Ghi chú theo loại check.
      if (c.check === "expect_price") {
        if (factsLen === 0) console.log(`  ⚠ mong có giá nhưng KHÔNG tra được tài liệu (facts=0) — đọc xem bot xử lý ổn không`);
        else console.log(`  · ${priceGrounding(reply, debug?.facts ?? "")}`);
      }
      if (c.check === "no_price_invent") {
        if (money.length && factsLen > 0) console.log(`  · ${priceGrounding(reply, debug?.facts ?? "")} (kiểm: số này có PHẢI giá PT 1-1 không, hay giá gói khác bị gán nhầm?)`);
        else if (!money.length) console.log(`  ✓ không nêu số tiền cho dịch vụ không có bảng giá — đúng kỳ vọng`);
      }
      if (c.check === "messaging_only") console.log(`  · ${phoneHint(reply)}`);
      if (c.check === "no_medical_block") console.log(`  · ${medicalBlockHint(reply)}`);
    }
  }

  console.log(`\n===== KẾT QUẢ =====`);
  if (fails.length) {
    console.log(`❌ ${fails.length} bất biến CỨNG bị vi phạm:`);
    fails.forEach((f) => console.log("  - " + f));
  } else {
    console.log("✓ Không vi phạm bất biến cứng (không bịa giá). Còn lại ĐỌC reply thật ở trên để chấm quy tắc mềm.");
  }
  await cleanup();
  console.log("=== ĐÃ DỌN dữ liệu test. XONG. ===");
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

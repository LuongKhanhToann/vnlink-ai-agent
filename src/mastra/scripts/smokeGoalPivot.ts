/**
 * scripts/smokeGoalPivot.ts — Smoke chuyên đề: "KHÁCH MUA MỤC TIÊU, KHÔNG MUA GIÁ".
 *
 * Tái hiện đúng tình huống khách phản ánh (ảnh chụp thật): khách hỏi giá Gym → bot XỔ nguyên bảng
 * giá 4 mốc mà KHÔNG hỏi mục tiêu; rồi khách chê "500k đắt hơn chỗ khác 400k" → bot phải xử lý phản
 * đối bằng cách KÉO VỀ GIÁ TRỊ / MỤC TIÊU, không chỉ bảo vệ con số.
 *
 * Thiết kế (kịch bản gym-01, objection "price_hide_goal") yêu cầu: đưa GIÁ MỞ → dự báo nỗi sợ ẩn →
 * HỎI MỤC TIÊU (siết eo/giảm mỡ hay sức bền?) → nối gói theo mục tiêu → FOMO. Smoke này chạy REPLY
 * THẬT qua pipeline runTurn (dùng debug-return) và IN ra để ĐỌC + chấm bằng mắt. Các "hint" lexical
 * chỉ là gợi ý đọc, KHÔNG phải verdict tự động.
 *
 * Chạy:  SCENARIO_DEBUG=1 npx -y tsx src/mastra/scripts/smokeGoalPivot.ts
 * (chạy vài lần vì reply ngẫu nhiên — cần ỔN ĐỊNH kéo-về-mục-tiêu, không phải may rủi)
 */

import "dotenv/config";
import { runTurn } from "../engine/brain";
import { Pool } from "pg";

process.env.SCENARIO_MODE = process.env.SCENARIO_MODE === "off" ? "off" : "on";
process.env.SCENARIO_DEBUG = "1";

interface Case {
  name: string;
  turns: string[];
  watch: string; // điều cần ĐỌC KỸ ở lượt cuối
}

const CASES: Case[] = [
  {
    // ── ĐÚNG đoạn chat trong ảnh khách gửi ──
    name: "R1 · Ảnh thật: hỏi giá Gym rồi chê '500k đắt hơn chỗ khác 400k'",
    turns: [
      "Mình muốn bạn tư vấn lại cho mình về gói tập Gym. Giá cả thế nào?",
      "Giá 500k đắt hơn trung tâm khác 400k thôi",
    ],
    watch:
      "Lượt 1: KHÔNG được xổ khô 4 mốc giá rồi im — phải đưa giá mở + HỎI MỤC TIÊU (siết eo/giảm mỡ/sức bền?). " +
      "Lượt 2: chê giá → KÉO VỀ GIÁ TRỊ (khác biệt Fami: bể 4 mùa, giải cơ, HLV, kết quả) & mục tiêu, KHÔNG chỉ cãi con số / KHÔNG bỏ cuộc hạ giá.",
  },
  {
    name: "R2 · Hỏi giá cộc lốc (chưa nói mục tiêu)",
    turns: ["gym bao nhiêu 1 tháng em"],
    watch:
      "Phải trả lời MỞ + hỏi mục tiêu ẩn, KHÔNG dump toàn bộ bảng giá vô hồn (đây là lỗi trong ảnh).",
  },
  {
    name: "R3 · So sánh 'chỗ khác rẻ hơn nhiều'",
    turns: [
      "anh muốn giảm mỡ bụng, tập gym thôi",
      "nhưng chỗ khác có 300k/tháng à, bên em đắt thế",
    ],
    watch:
      "Lượt 2: phản đối giá SAU khi đã biết mục tiêu (giảm mỡ bụng) → tái khung 'anh mua kết quả giảm mỡ, không mua chỗ rẻ'; nêu vì sao gym-đơn-thuần chỗ rẻ khó đạt (thiếu bể 4 mùa/giải cơ/HLV) → về mục tiêu + mời trải nghiệm.",
  },
  {
    name: "R4 · 'Để suy nghĩ thêm' sau khi nghe giá (né giá trá hình)",
    turns: [
      "yoga bên em bao nhiêu tiền",
      "hơi cao, để chị suy nghĩ thêm đã",
    ],
    watch:
      "Lượt 2: không thả trôi — nhẹ nhàng đào lại mục tiêu/nỗi đau khiến chị quan tâm yoga, gắn giá trị, chốt mời trải nghiệm; KHÔNG chỉ 'dạ chị cứ suy nghĩ ạ'.",
  },
];

// ── hint lexical NHẸ (chỉ để lưu ý khi đọc, KHÔNG phải verdict) ──
function goalPivotHint(reply: string): string {
  const low = reply.toLowerCase();
  const goalCues = ["mục tiêu", "muốn giảm", "muốn siết", "mong muốn", "anh/chị đang", "hiện tại anh", "hiện tại chị", "anh muốn", "chị muốn", "để em tư vấn đúng", "anh/chị muốn"];
  const hit = goalCues.filter((p) => low.includes(p));
  const hasQuestion = reply.includes("?");
  return `${hit.length ? `có cụm hướng-mục-tiêu [${hit.slice(0, 4).join(", ")}]` : "⚠ KHÔNG thấy cụm hướng-mục-tiêu"} · ${hasQuestion ? "có câu hỏi dẫn dắt" : "⚠ KHÔNG có câu hỏi"}`;
}
// đếm số mốc giá lộ ra (dump bảng giá = nhiều mốc trong 1 tin)
function priceDumpHint(reply: string): string {
  const marks = (reply.match(/\d[\d.,]*\s*(k|nghìn|triệu|tr|đ|vnđ)/gi) || []).map((s) => s.trim());
  if (marks.length >= 3) return `⚠ nghi DUMP bảng giá: lộ ${marks.length} mốc giá [${marks.join(", ")}] — đọc xem có kéo mục tiêu không hay chỉ liệt kê`;
  return `· lộ ${marks.length} mốc giá (${marks.join(", ") || "không"}) — không giống dump`;
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
      .query(`DELETE FROM ${t} WHERE sender_id LIKE '__smoke_goal%'`)
      .catch((e) => console.warn(`dọn ${t}: ${(e as Error).message}`));
  }
  await pool.end();
}

async function main() {
  console.log(`\n===== SMOKE "MUA MỤC TIÊU KHÔNG MUA GIÁ" (SCENARIO_MODE=${process.env.SCENARIO_MODE}) =====`);
  let idx = 0;
  for (const c of CASES) {
    idx++;
    const senderId = `__smoke_goal_${idx}`;
    console.log(`\n════════════ ${c.name} ════════════`);
    console.log(`  · đọc kỹ: ${c.watch}`);
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
      console.log(`  · goal-pivot: ${goalPivotHint(reply)}`);
      console.log(`  · price-dump: ${priceDumpHint(reply)}`);
    }
  }
  console.log(`\n===== XONG — ĐỌC reply thật ở trên để chấm: có KÉO VỀ MỤC TIÊU không, hay chỉ bán giá? =====`);
  await cleanup();
  console.log("=== ĐÃ DỌN dữ liệu test. ===");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await cleanup().catch(() => {});
  process.exit(1);
});

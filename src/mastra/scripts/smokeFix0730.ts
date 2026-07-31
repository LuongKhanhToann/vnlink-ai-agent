/**
 * smokeFix0730.ts — smoke REPLY THẬT cho 8 lỗi đo được trên PROD ngày 30/07 (xem prodProbe).
 *
 *   A · SAUSINH   — sau sinh + "em bị đau lưng nữa" → PHẢI ở lại flow fitness; lượt hỏi chi phí
 *                   báo giá FAMI (gói tập), TUYỆT ĐỐI không lòi giá giải cơ Hoa Sen 330 nghìn /
 *                   liệu trình VIP2 3.8 triệu.
 *   B · HSSV      — sinh viên: khai "em là sinh viên" ở lượt SAU câu hỏi giá vẫn phải ra SỐ của
 *                   bảng FULL HS/SV; và CẤM câu bịa "trung tâm không tách lẻ từng bộ môn".
 *   C · GIAMCAN   — lượt 1 hỏi cao-nặng (không hỏi "muốn giảm bao nhiêu cân"); lượt cho số đo
 *                   phải NÊU MỐC cân đối đúng bảng; lượt hỏi giá neo thẻ FULL (không phải Gym).
 *   D · DEDAT     — chê đắt → reframe + MỜI trải nghiệm, không lặp lại đúng con số vừa báo.
 *   E · CUOITUAN  — "cuối tuần này" → 2 ngày phải là thứ Bảy + Chủ nhật, không phải ngày thường.
 *   F · MONGI     — "bên mình có những môn gì" → kể đủ 4 môn + Pilates.
 *   G · GIAICO    — khách đau vai gáy THUẦN → vẫn phải sang giải cơ đúng (không bị vá chặn nhầm).
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeFix0730.ts [A|B|...]
 *       ROUNDS=2 để chạy 2 vòng (reply ngẫu nhiên — soi tính ổn định).
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

interface Expect {
  /** Ít nhất MỘT chuỗi này phải có trong tin lượt đó. */
  dung?: string[];
  /** TUYỆT ĐỐI không được có chuỗi nào trong danh sách này. */
  sai?: string[];
  /** Soát tự do (trả về mô tả lỗi, "" = đạt). */
  soi?: (reply: string) => string;
}

interface Scenario {
  name: string;
  turns: { msg: string; expect?: Expect }[];
  soiCuoc?: (replies: string[]) => string;
}

/** Giá của bên GIẢI CƠ (Hoa Sen) — lọt vào mạch fitness là lẫn thương hiệu, lỗi nặng nhất. */
const GIA_GIAI_CO = ["330 nghìn", "200 nghìn", "3.8 triệu", "4.2 triệu", "giải cơ", "KTV"];

const SCENARIOS: Scenario[] = [
  {
    name: "A · SAUSINH (sau sinh + đau lưng → PHẢI ở lại Fami)",
    turns: [
      { msg: "Em mới sinh xong 4 tháng, muốn giảm mỡ bụng thì tập gì ạ", expect: { dung: ["bác sĩ", "giấy khám"] } },
      { msg: "Em bị đau lưng nữa em ạ", expect: { sai: GIA_GIAI_CO } },
      {
        msg: "Thế học phí gym với zumba thế nào em",
        expect: { sai: GIA_GIAI_CO, dung: ["800 nghìn", "500 nghìn", "2.1 triệu"] },
      },
    ],
  },
  {
    name: "B · HSSV (khai sinh viên ở lượt sau câu hỏi giá)",
    turns: [
      { msg: "Cho em hỏi giá tập gym với ạ", expect: { dung: ["500 nghìn"] } },
      {
        msg: "Em là sinh viên năm 2 ạ",
        // Phải ra SỐ ngay lượt này (trước đây chỉ nói suông "có nhiều ưu đãi").
        expect: { dung: ["500 nghìn", "1.2 triệu", "2.1 triệu", "3.6 triệu"] },
      },
      {
        msg: "Em chỉ muốn tập mỗi gym thôi có rẻ hơn không ạ",
        expect: { sai: ["không tách lẻ", "chỉ bán thẻ trọn gói", "không tách riêng"] },
      },
    ],
  },
  {
    name: "C · GIAMCAN (hỏi số đo → mốc cân đối → neo thẻ FULL)",
    turns: [
      {
        msg: "Chào shop, e muốn giảm cân",
        expect: { sai: ["bao nhiêu cân", "bao nhiêu kg"], dung: ["chiều cao", "cân nặng"] },
      },
      {
        // 1m58 nữ → nội suy giữa 155cm (46-55) và 160cm (49-59) = 48-57kg → 65kg là dư 8kg.
        msg: "Mình nữ, cao 1m58 nặng 65kg",
        expect: {
          soi: (r) =>
            r.includes("48") && r.includes("57") && r.includes("8kg") ? "" : "không nêu đúng mốc 48-57kg / dư 8kg",
        },
      },
      { msg: "Giá thế nào em", expect: { dung: ["800 nghìn", "2.1 triệu", "3.8 triệu", "7 triệu"] } },
    ],
  },
  {
    name: "D · DEDAT (chê đắt → reframe + mời trải nghiệm)",
    turns: [
      { msg: "Gym 1 tháng bao nhiêu tiền vậy em", expect: { dung: ["500 nghìn"] } },
      {
        msg: "Đắt thế, chỗ khác có 300k thôi",
        expect: {
          sai: ["500 nghìn"],
          soi: (r) => (/thử|trải nghiệm|inbody|ghé|qua trung tâm/i.test(r) ? "" : "không mời trải nghiệm"),
        },
      },
    ],
  },
  {
    name: "E · CUOITUAN (cuối tuần này → thứ Bảy/Chủ nhật)",
    turns: [
      { msg: "Mình muốn tập yoga" },
      { msg: "Mình chưa tập bao giờ ạ" },
      { msg: "Ok vậy mình qua thử 1 buổi xem sao" },
      {
        msg: "Cuối tuần này em nhé",
        expect: {
          soi: (r) => {
            const co = /thứ bảy|thứ 7|chủ nhật/i.test(r);
            const ngayThuong = /thứ hai|thứ ba|thứ tư|thứ năm|thứ sáu/i.test(r);
            if (!co) return "không đưa được ngày cuối tuần";
            return ngayThuong ? "vẫn chào ngày trong tuần cho khách hẹn cuối tuần" : "";
          },
        },
      },
    ],
  },
  {
    name: "F · MONGI (liệt kê dịch vụ phải có Pilates)",
    turns: [
      { msg: "Bên mình có những môn gì ạ", expect: { dung: ["Pilates", "pilates"] } },
    ],
  },
  {
    name: "G · GIAICO (đau vai gáy thuần → vẫn sang giải cơ đúng)",
    turns: [
      { msg: "Em ngồi văn phòng bị đau mỏi vai gáy mấy tháng nay, bên mình có làm không ạ" },
      { msg: "Đau âm ỉ, ngồi lâu là cứng cả cổ ạ" },
      { msg: "Một buổi bao nhiêu tiền em", expect: { dung: ["200 nghìn", "330 nghìn"] } },
    ],
  },
];

function chuaThat(hay: string, frag: string): boolean {
  const f = frag.toLowerCase();
  let i = hay.indexOf(f);
  while (i >= 0) {
    const truoc = i > 0 ? hay[i - 1] : " ";
    if (!/[\d.,]/.test(truoc)) return true;
    i = hay.indexOf(f, i + 1);
  }
  return false;
}

function judge(reply: string, e?: Expect): string[] {
  if (!e) return [];
  const low = reply.toLowerCase();
  const loi: string[] = [];
  const hitSai = (e.sai ?? []).filter((x) => chuaThat(low, x.toLowerCase()));
  if (hitSai.length) loi.push(`có chuỗi CẤM: ${hitSai.map((x) => `"${x}"`).join(", ")}`);
  if (e.dung?.length && !e.dung.some((x) => low.includes(x.toLowerCase()))) {
    loi.push(`thiếu ý bắt buộc (một trong: ${e.dung.map((x) => `"${x}"`).join(", ")})`);
  }
  const soi = e.soi?.(reply) ?? "";
  if (soi) loi.push(soi);
  return loi;
}

async function main() {
  const only = process.argv[2]?.toUpperCase();
  const rounds = Number(process.env.ROUNDS ?? "1");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");

  let fail = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const scn of SCENARIOS) {
      if (only && !scn.name.startsWith(only)) continue;
      const threadId = `smoke-0730-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      console.log(`\n${"═".repeat(76)}\n▶ [vòng ${round}] ${scn.name}\n${"═".repeat(76)}`);
      const replies: string[] = [];
      for (const [i, turn] of scn.turns.entries()) {
        console.log(`\nKH: ${turn.msg}`);
        const t0 = Date.now();
        let reply = "";
        try {
          const out = await runGemmaTurn({ mastra, message: turn.msg, threadId, resourceId: threadId });
          reply = out.reply ?? "";
        } catch (e) {
          console.error(`  ✗ LỖI LƯỢT:`, (e as Error)?.message);
          fail++;
          continue;
        }
        console.log(`BOT (${((Date.now() - t0) / 1000).toFixed(1)}s): ${reply}`);
        replies.push(reply);
        const loi = judge(reply, turn.expect);
        if (turn.expect) {
          if (loi.length) {
            fail++;
            console.log(`  ❌ lượt ${i + 1} TRƯỢT — ${loi.join(" · ")}`);
          } else {
            console.log(`  ✅ lượt ${i + 1} đạt`);
          }
        }
      }
      const loiCuoc = scn.soiCuoc?.(replies) ?? "";
      if (loiCuoc) {
        fail++;
        console.log(`  ❌ cả cuộc TRƯỢT — ${loiCuoc}`);
      }
    }
  }
  console.log(`\n${fail === 0 ? "✅ TẤT CẢ ĐẠT" : `❌ ${fail} lượt TRƯỢT`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

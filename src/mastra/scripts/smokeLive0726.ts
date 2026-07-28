/**
 * smokeLive0726.ts — smoke REPLY THẬT cho 4 lỗi bắt được trên log LIVE ngày 26/07.
 *
 * Nguồn: pm2 log box val-dev + DB hội thoại (convo 38412582635006991 và 27851452844465770).
 *   A · SDT      — khách xin số điện thoại của bên em → bot từng gửi thẳng "[Số điện thoại của
 *                  bạn]" (2 lần). ĐÚNG = không có ngoặc vuông, không đọc ra dãy số, quay sang
 *                  xin số của KHÁCH.
 *   B · BA70     — bà 70 tuổi + cháu lớp 2 muốn cùng học bơi. ĐÚNG = lượt đầu dặn an toàn 1 lần
 *                  NHƯNG vẫn trả lời câu khách hỏi; lượt sau KHÔNG lặp lại lời dặn; không tự gán
 *                  "mình đã có kinh nghiệm bơi lội"; hỏi giá 2 người → lớp nhóm 1.5 triệu/người
 *                  = 3 triệu (bot từng báo nhầm gói 1 kèm 1 5 triệu).
 *   C · BAOLAU   — "học bao lâu thì biết bơi" → phải theo số buổi thật của khoá (12 buổi); bot
 *                  từng bịa "khoảng 10 đến 15 buổi".
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeLive0726.ts [A|B|C]
 * Ép đường fallback 5.4: thêm FORCE_FALLBACK=1.
 */

import "dotenv/config";
// contact.ts chỉ chứa hằng số, không đụng env → import tĩnh an toàn (các module khác vẫn phải
// import động SAU khi set STORAGE_BACKEND ở dưới).
import { HOTLINE } from "../engine/contact";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
if (process.env.FORCE_FALLBACK === "1") {
  process.env.GEMMA_API_KEY = "sk-gemma-CO-Y-SAI-KEY-de-ep-401";
}

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
  /** Soát CẢ CUỘC (classifier ngẫu nhiên nên có luật chỉ đúng ở mức cuộc, không mức lượt). */
  soiCuoc?: (replies: string[]) => string;
}

/**
 * Từ 27/07 trung tâm ĐÃ có hotline thật → bot phải đưa ĐÚNG số đó, và không được đọc ra bất kỳ
 * dãy số nào khác (12B rất hay "làm tròn" dãy số hoặc bịa thêm số zalo thứ hai).
 */
const dungSoHotline = (reply: string): string => {
  const soChuan = HOTLINE.replace(/\D/g, "");
  const cacSo = [...reply.matchAll(/0\d[\d .]{7,}/g)].map((m) => m[0].trim());
  if (!cacSo.length) return `bot KHÔNG đưa số nào (phải đưa hotline ${HOTLINE})`;
  const sai = cacSo.filter((s) => s.replace(/\D/g, "") !== soChuan);
  if (sai.length) return `bot đọc ra số SAI: ${sai.join(" / ")} (đúng phải là ${HOTLINE})`;
  if (cacSo.length > 1) return `bot đưa ${cacSo.length} dãy số trong 1 tin — chỉ được đưa 1 số`;
  // Chưa xác nhận số này có Zalo → bot khẳng định "kết bạn Zalo qua số này" là bịa tiện ích.
  if (/zalo|viber/i.test(reply)) return `bot khẳng định có Zalo/Viber trên số này (chưa xác nhận)`;
  return "";
};

/**
 * Bot TỰ KẾT LUẬN khách/bé "đã biết bơi" — lỗi live 26/07: bà kể đi biển, tắm bể Thanh Thuỷ →
 * bot chốt luôn "vì mình đã có kinh nghiệm bơi lội" rồi tư vấn sai hướng.
 *
 * ⚠ HỎI LẠI thì hoàn toàn đúng nhịp ("hai bà cháu đã biết bơi hay chưa ạ") — bản cấm-theo-chuỗi
 * cũ bắt nhầm chính câu hỏi này (trượt 1/2 lần chạy), nên chỉ soi câu KHẲNG ĐỊNH.
 */
const khongTuGanBietBoi = (reply: string): string => {
  const cum = ["đã biết bơi", "kinh nghiệm bơi lội", "đã có nền tảng bơi", "biết bơi cơ bản rồi"];
  for (const cau of reply.split(/(?<=[.!?\n])\s*/)) {
    const s = cau.toLowerCase();
    const laCauHoi = s.includes("hay") || s.includes("chưa ạ") || s.includes("không ạ") || cau.trim().endsWith("?");
    if (!laCauHoi && cum.some((c) => s.includes(c))) return `bot tự gán khách đã biết bơi: "${cau.trim()}"`;
  }
  return "";
};

const SCENARIOS: Scenario[] = [
  {
    name: "A · SDT (khách xin số điện thoại của bên em)",
    turns: [
      { msg: "Tư vấn cho tôi khóa học bơi" },
      { msg: "Mình chưa biết bơi" },
      {
        msg: "Mình muốn ghé qua tham quan tìm hiểu trước\nCho mình sdt của bạn",
        expect: {
          sai: ["[", "]", "không có số"],
          dung: [HOTLINE],
          soi: dungSoHotline,
        },
      },
      // Khách hỏi lại lần 2 (đúng như convo thật) — số phải KHÔNG ĐỔI, không được lòi ra số khác.
      {
        msg: "Sdt nào ạ",
        expect: { sai: ["[", "]"], dung: [HOTLINE], soi: dungSoHotline },
      },
    ],
  },
  {
    name: "B · BA70 (bà 70 tuổi + cháu lớp 2 cùng học bơi)",
    turns: [
      { msg: "Tôi muốn biết phí học bơi là bao nhiêu ?", expect: { dung: ["1.5 triệu", "1,5 triệu", "3 triệu"] } },
      {
        msg: "Tôi 70tuổi, cháu trai tôi sinh tháng 8/2019 , hai bà cháu tôi muốn cùng đi học bơi",
        // "chưa đủ 6 tuổi": bé sinh 8/2019 đã gần 7 tuổi — 12B tự tính tuổi từ năm sinh là sai,
        // chối nhầm khách đủ điều kiện (bắt được ở vòng smoke 26/07).
        expect: { sai: ["chưa đủ 6 tuổi", "chưa đủ tuổi"] },
      },
      {
        msg: "Tôi vẫn tham gia dưỡng sinh thường xuyên, đi biển, đi tắm ở bể bơi Thanh Thuỷ mãi rồi",
        expect: {
          sai: ["chưa đủ 6 tuổi", "chưa đủ tuổi"],
          soi: khongTuGanBietBoi,
        },
      },
      {
        msg: "Nếu 2 bà cháu cùng đăng ký học bơi thì tổng chi phí là bao nhiêu, ngoài ra khi vào học có phải nộp thêm loại phí nào không ?",
        expect: { dung: ["3 triệu"], sai: ["5 triệu", "12 triệu", "14 triệu"] },
      },
    ],
    // Lời dặn an toàn: classifier bật "benh-nen" ở lượt nào là ngẫu nhiên, nên chỉ soát được ở
    // mức CUỘC — phải dặn ĐÚNG 1 LẦN: thiếu hẳn = bỏ cảnh báo cho người 70 tuổi; từ 2 lần trở
    // lên = đúng lỗi live 26/07 (4 lượt liền lặp lời dặn, nuốt mất câu trả lời của khách).
    soiCuoc: (replies) => {
      const n = replies.filter((r) => r.includes("bác sĩ") || r.includes("giấy khám")).length;
      if (n === 0) return "cả cuộc KHÔNG có lời dặn an toàn nào cho khách 70 tuổi";
      if (n > 1) return `lặp lời dặn an toàn ${n} lượt (chỉ được 1)`;
      return "";
    },
  },
  {
    name: "C · BAOLAU (học bao lâu thì biết bơi)",
    turns: [
      { msg: "Tư vấn cho tôi khóa học bơi" },
      { msg: "Mình chưa biết bơi" },
      {
        msg: "Học bao lâu thì biết bơi ạ",
        expect: { dung: ["12 buổi", "20 ngày"], sai: ["10 đến 15", "10-15", "15 buổi", "10 buổi"] },
      },
    ],
  },
];

/**
 * Có chứa `frag` KHÔNG PHẢI dưới dạng đuôi của một con số khác hay không.
 * ⚠ Cần vì "1.5 triệu" chứa nguyên chuỗi "5 triệu" → luật cấm "5 triệu" bắt nhầm câu trả lời ĐÚNG.
 */
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
  const hitSai = (e.sai ?? []).filter((x) => chuaThat(low, x));
  if (hitSai.length) loi.push(`có chuỗi CẤM: ${hitSai.map((x) => `"${x}"`).join(", ")}`);
  if (e.dung?.length && !e.dung.some((x) => low.includes(x.toLowerCase()))) {
    loi.push(`thiếu hẳn ý bắt buộc (một trong: ${e.dung.map((x) => `"${x}"`).join(", ")})`);
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

  console.log(
    `\n### đường chạy: ${process.env.FORCE_FALLBACK === "1" ? "FALLBACK 5.4 (gemma bị ép 401)" : "GEMMA thật"} · ${rounds} vòng`,
  );
  let fail = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const scn of SCENARIOS) {
      if (only && !scn.name.startsWith(only)) continue;
      const threadId = `smoke-0726-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      console.log(`\n${"═".repeat(76)}\n▶ [vòng ${round}] ${scn.name}\n${"═".repeat(76)}`);
      const replies: string[] = [];
      for (const [i, turn] of scn.turns.entries()) {
        console.log(`\nKH: ${turn.msg.replace(/\n/g, " ⏎ ")}`);
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
      } else if (scn.soiCuoc) {
        console.log(`  ✅ cả cuộc đạt`);
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

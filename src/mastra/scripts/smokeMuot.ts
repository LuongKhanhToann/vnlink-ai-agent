/**
 * smokeMuot.ts — smoke REPLY THẬT (gemma) cho các FUNNEL dễ vỡ CHƯA phủ ở smokeLive0726:
 * neo giá gym, không bịa chi nhánh HN, vé bơi lẻ, bơi+yoga (không ECO), an toàn bà bầu,
 * liệt kê dịch vụ, câu ngoài phạm vi, PT 1-1. Mục tiêu: chắc bot "mượt" ở diện rộng.
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeMuot.ts [tên] [ROUNDS=n]
 */

import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

interface Expect {
  dung?: string[]; // ít nhất 1 chuỗi phải có
  sai?: string[]; // tuyệt đối không có
  soi?: (reply: string) => string; // "" = đạt
}
interface Scenario {
  name: string;
  turns: { msg: string; expect?: Expect }[];
}

/** "1.5 triệu" chứa "5 triệu" → chỉ tính khi frag KHÔNG là đuôi của số khác. */
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

/** Đếm bao nhiêu bộ môn được kể tên trong reply. */
const keDichVu = (reply: string): number => {
  const low = reply.toLowerCase();
  return ["gym", "bơi", "yoga", "zumba"].filter((m) => low.includes(m)).length;
};

/** Bịa chi nhánh Hà Nội: có câu KHẲNG ĐỊNH gắn cơ sở với "hà nội" mà không phủ định. */
const khongBiaChiNhanh = (reply: string): string => {
  for (const cau of reply.split(/(?<=[.!?\n])\s*/)) {
    const s = cau.toLowerCase();
    if (!s.includes("hà nội")) continue;
    const phuDinh = /(không|chưa|chỉ|duy nhất)/.test(s);
    const khang = /(có|tại|ở|chi nhánh|cơ sở)/.test(s);
    if (khang && !phuDinh) return `nghi bịa chi nhánh HN: "${cau.trim()}"`;
  }
  return "";
};

const SCENARIOS: Scenario[] = [
  {
    // Giá gym hỏi CHUNG (không nêu thời hạn) → neo mốc 1 tháng (500 nghìn), CẤM nhảy lên mốc
    // đắt nhất (4.5 triệu / 7 triệu) khi khách chưa nói tập bao lâu.
    name: "GIAGYM (gym hỏi giá chung → neo 1 tháng, không nhảy mốc đắt)",
    turns: [
      {
        msg: "tập gym bên mình giá bao nhiêu ạ",
        expect: { dung: ["500 nghìn", "500 ngàn"], sai: ["4.5 triệu", "7 triệu"] },
      },
    ],
  },
  {
    // Khách nêu địa phương của họ → KHÔNG được bịa chi nhánh; nói rõ chỉ có ở Vĩnh Yên/Vĩnh Phúc.
    name: "HANOI (khách ở HN hỏi chi nhánh → không bịa)",
    turns: [
      {
        msg: "bên mình có chi nhánh nào ở Hà Nội không ạ, em ở Hà Nội",
        expect: { dung: ["Vĩnh"], soi: khongBiaChiNhanh },
      },
    ],
  },
  {
    // Vé bơi lẻ theo chiều cao: 20 / 30 / 40 nghìn mỗi lượt.
    name: "VELE (bơi lẻ theo lượt)",
    turns: [
      {
        msg: "em không mua gói tháng, bơi lẻ mỗi lượt tính nhiêu ạ",
        expect: { dung: ["20", "30", "40"], sai: ["miễn phí"] },
      },
    ],
  },
  {
    // Bơi + Yoga: ECO KHÔNG gồm Yoga → CẤM đề xuất ECO; báo FULL hoặc tách môn.
    name: "YOGABOI (bơi + yoga → không ECO)",
    turns: [
      {
        msg: "em muốn tập cả bơi với yoga thì có gói ghép nào rẻ hơn không ạ",
        expect: { sai: ["ECO", "eco"] },
      },
    ],
  },
  {
    // Bà bầu → BẮT BUỘC có vế khuyên hỏi bác sĩ; KHÔNG giục chốt lịch, KHÔNG hứa chữa.
    name: "BABAU (bầu 4 tháng tập gym → dặn an toàn)",
    turns: [
      {
        msg: "em đang bầu 4 tháng thì tập gym có sao không ạ",
        expect: { dung: ["bác sĩ", "giấy khám"] },
      },
    ],
  },
  {
    // "Có dịch vụ gì" → phải KỂ RA môn (>=2), không hỏi trống "quan tâm bộ môn nào".
    name: "DICHVU (hỏi có dịch vụ gì → kể ra môn)",
    turns: [
      {
        msg: "bên bạn có những dịch vụ gì ạ",
        expect: {
          soi: (r) => (keDichVu(r) >= 2 ? "" : `chỉ kể ${keDichVu(r)} môn (cần >=2)`),
        },
      },
    ],
  },
  {
    // Câu NGOÀI phạm vi (bán thực phẩm chức năng) → không bịa, KHÔNG nhét lời dặn an toàn lạc đề.
    name: "NGOAIPHAM (hỏi bán TPCN giảm cân)",
    turns: [
      {
        msg: "bên mình có bán thực phẩm chức năng giảm cân không ạ",
        expect: { sai: ["giấy khám sức khỏe trước khi tập"] },
      },
    ],
  },
  {
    // PT gym 1 kèm 1 → mốc PT thật (10 buổi 3 triệu / 15 buổi 4 triệu / 20 buổi 6 triệu).
    name: "PT11 (gym có HLV kèm riêng 1-1 → giá PT)",
    turns: [
      {
        msg: "em muốn có huấn luyện viên kèm riêng 1 kèm 1 khi tập gym thì giá thế nào ạ",
        expect: { dung: ["3 triệu", "4 triệu", "6 triệu"] },
      },
    ],
  },
];

function judge(reply: string, e?: Expect): string[] {
  if (!e) return [];
  const low = reply.toLowerCase();
  const loi: string[] = [];
  const hitSai = (e.sai ?? []).filter((x) => chuaThat(low, x));
  if (hitSai.length) loi.push(`có chuỗi CẤM: ${hitSai.map((x) => `"${x}"`).join(", ")}`);
  if (e.dung?.length && !e.dung.some((x) => low.includes(x.toLowerCase()))) {
    loi.push(`thiếu ý bắt buộc (một trong: ${e.dung.map((x) => `"${x}"`).join(", ")})`);
  }
  const soi = e.soi?.(reply) ?? "";
  if (soi) loi.push(soi);
  return loi;
}

async function main() {
  const only = process.argv[2] && !/^\d/.test(process.argv[2]) ? process.argv[2].toUpperCase() : "";
  const rounds = Number(process.env.ROUNDS ?? "1");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");

  let fail = 0;
  for (let round = 1; round <= rounds; round++) {
    for (const scn of SCENARIOS) {
      if (only && !scn.name.startsWith(only)) continue;
      const threadId = `smoke-muot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      console.log(`\n${"═".repeat(76)}\n▶ [vòng ${round}] ${scn.name}\n${"═".repeat(76)}`);
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
    }
  }
  console.log(`\n${fail === 0 ? "✅ TẤT CẢ ĐẠT" : `❌ ${fail} lượt TRƯỢT`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * smokeFlowRouter.ts — smoke NHÁNH BUSINESS: khách nào được ở lại Fami, khách nào sang Hoa Sen.
 *
 * Bug đã bắt (13/07/2026, live): khách mở đầu "thư giãn nha e" trên page Fami → router chọn
 * flow=giai-co ngay tin đầu → bot nói giọng spa Hoa Sen ("vùng đang khó chịu nhất") cho người
 * chỉ muốn TẬP cho thư giãn. Nguyên nhân: prompt router liệt kê "thư giãn cơ" là dấu hiệu giai-co.
 * Đẩy khách sang doanh nghiệp KHÁC khi họ không đau = sai nghiêm trọng → smoke này canh cửa vào.
 *
 * Canh 2 chiều (fix bên này không được hỏng bên kia):
 *   ① khách KHÔNG đau (thư giãn / giảm cân / mơ hồ) → PHẢI ở fitness.
 *   ② khách ĐAU thật hoặc hỏi thẳng trị liệu → PHẢI sang giai-co (kể cả pivot giữa cuộc).
 *
 * Chạy: STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeFlowRouter.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

type Flow = "fitness" | "giai-co";
interface Turn {
  msg: string;
  want: Flow;
}
interface Case {
  sid: string;
  title: string;
  turns: Turn[];
}

const CASES: Case[] = [
  {
    sid: "smk-router-thugian",
    title: "① BUG THẬT: tin đầu 'thư giãn nha e' trên page fitness → PHẢI ở fitness",
    turns: [{ msg: "thư giãn nha e", want: "fitness" }],
  },
  {
    sid: "smk-router-dau",
    title: "② Khách ĐAU thật ngay tin đầu → PHẢI sang giai-co (không được hỏng)",
    turns: [{ msg: "em bị đau mỏi cổ vai gáy mấy tháng nay, bên mình có trị liệu không ạ", want: "giai-co" }],
  },
  {
    sid: "smk-router-yoga-thugian",
    title: "③ Đang tư vấn yoga, khách đáp 'chủ yếu để thư giãn' → GIỮ fitness",
    turns: [
      { msg: "mình muốn tập yoga", want: "fitness" },
      { msg: "chủ yếu để thư giãn thôi em", want: "fitness" },
    ],
  },
  {
    sid: "smk-router-pivot",
    title: "④ Đang fitness rồi than đau mãn muốn trị liệu → PIVOT sang giai-co (giữ nguyên hành vi cũ)",
    turns: [
      { msg: "cho hỏi gói tập gym bao nhiêu tiền", want: "fitness" },
      { msg: "thật ra lưng em đau âm ỉ cả năm nay rồi, em muốn làm cho hết đau chứ tập chắc không nổi", want: "giai-co" },
    ],
  },
];

/** Bắt quyết định router từ log của brain.ts (nguồn sự thật duy nhất, không dựng lại logic). */
let lastFlow: Flow | null = null;
const realLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
  const i = line.indexOf("[brain] router: flow=");
  if (i >= 0) {
    const rest = line.slice(i + "[brain] router: flow=".length);
    lastFlow = rest.startsWith("giai-co") ? "giai-co" : "fitness";
  }
  realLog(...args);
};

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");

  const fails: string[] = [];

  for (const c of CASES) {
    realLog("\n" + "█".repeat(76));
    realLog(c.title);
    for (const t of c.turns) {
      lastFlow = null;
      const r = await runAgentTurn({ mastra, threadId: c.sid, resourceId: c.sid, message: t.msg });
      const got = lastFlow;
      const ok = got === t.want;
      if (!ok) fails.push(`${c.sid} · "${t.msg}" → flow=${got} (cần ${t.want})`);
      realLog(`\n  KHÁCH: ${t.msg}`);
      realLog(`  FLOW : ${got} ${ok ? "✅" : `❌ CẦN ${t.want}`}`);
      realLog(`  BOT  : ${r.reply}`);
    }
  }

  realLog("\n" + "=".repeat(76));
  if (fails.length === 0) {
    realLog("✅ PASS — mọi lượt vào đúng nhánh. ĐỌC LẠI câu bot ở trên: có tự nhiên, đúng nghiệp vụ không?");
  } else {
    realLog(`❌ FAIL — ${fails.length} lượt sai nhánh:`);
    for (const f of fails) realLog(`   • ${f}`);
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});

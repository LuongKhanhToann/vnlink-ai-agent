/**
 * smokeFamiDocs.ts — QUIZ bot qua pipeline thật về nội dung 3 tài liệu Fami (Vinalink gửi).
 * Nhắm: fact cơ sở (file1), tác dụng bộ môn (file2), GIÁ + khuyến mãi + gói giảm cân (file3).
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeFamiDocs.ts
 *   ROUNDS=2 ... để chạy 2 vòng (reply ngẫu nhiên).
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

/** true nếu `hay` chứa `frag` không phải là đuôi của số khác (vd "5 triệu" không bắt "1.5 triệu"). */
function has(hay: string, frag: string): boolean {
  const f = frag.toLowerCase();
  let i = hay.indexOf(f);
  while (i >= 0) {
    const before = i > 0 ? hay[i - 1] : " ";
    if (!/[\d.,]/.test(before)) return true;
    i = hay.indexOf(f, i + 1);
  }
  return false;
}

interface Q { name: string; msg: string; dung?: string[]; sai?: string[]; }

// Mỗi câu 1 thread riêng (fresh) trừ khi có tiền tố cùng nhóm — ở đây tách hết cho sạch.
const QUIZ: Q[] = [
  // ── File 1: cơ sở ──
  { name: "F1 địa chỉ", msg: "trung tâm mình ở đâu ạ", dung: ["nguyễn chí thanh", "vĩnh yên"] },
  { name: "F1 giờ mở", msg: "trung tâm mở cửa mấy giờ ạ", dung: ["5", "20"], sai: ["20h30", "20:30", "24"] },
  { name: "F1 xông hơi", msg: "có phòng xông hơi không ạ", dung: ["xông hơi"], sai: ["không có phòng xông hơi", "bên em không có xông hơi"] },
  { name: "F1 bể 4 mùa", msg: "bể bơi có phải nước ấm quanh năm không", dung: ["4 mùa", "bốn mùa", "ấm"] },
  { name: "F1 tư vấn dinh dưỡng", msg: "bên mình có tư vấn dinh dưỡng không", dung: ["dinh dưỡng"], sai: ["không có"] },
  // ── File 2: tác dụng bộ môn ──
  { name: "F2 bơi thừa cân", msg: "em nặng 95kg đau khớp gối, bơi có hợp không", dung: ["xương khớp", "giảm tải", "khớp"] },
  { name: "F2 yoga tác dụng", msg: "hay mất ngủ căng thẳng thì tập yoga được không", dung: ["yoga"], sai: ["không phù hợp"] },
  { name: "F2 pilates", msg: "pilates giúp gì cho dáng ạ", dung: ["tư thế", "cơ lõi", "dáng"] },
  // ── File 3: GIÁ (số mới theo bảng giá Vinalink) ──
  { name: "F3 gym 3 tháng = 1.45tr", msg: "gói gym 3 tháng bao nhiêu tiền ạ", dung: ["1.45 triệu"], sai: ["1.5 triệu"] },
  { name: "F3 gym 6 tháng = 2.55tr", msg: "gym 6 tháng giá sao ạ", dung: ["2.55 triệu"], sai: ["2.5 triệu"] },
  { name: "F3 full 12 tháng = 7.2tr", msg: "thẻ full 4 môn 12 tháng bao nhiêu", dung: ["7.2 triệu"], sai: ["7 triệu", "7000"] },
  { name: "F3 full 3 tháng = 2.28tr", msg: "gói full 3 tháng giá bao nhiêu ạ", dung: ["2.28 triệu"], sai: ["2.1 triệu"] },
  { name: "F3 yoga 3 tháng = 1.85tr", msg: "yoga 3 tháng nhiêu tiền", dung: ["1.85 triệu"], sai: ["1.8 triệu"] },
  // ── File 3: gói 2 dịch vụ CÓ yoga (thay đổi rule) ──
  { name: "F3 gym+yoga = gói 2 dịch vụ 700k", msg: "em muốn tập cả gym với yoga, 1 tháng bao nhiêu ạ", dung: ["700 nghìn"], sai: ["2.28 triệu", "800 nghìn"] },
  { name: "F3 yoga+bơi 12 tháng = 6.3tr", msg: "gói yoga và bơi 12 tháng giá bao nhiêu", dung: ["6.3 triệu"] },
  // ── File 3: khuyến mãi + học bơi + giảm cân ──
  { name: "F3 học bơi tặng 2 tháng", msg: "học bơi xong được tặng gì không ạ", dung: ["2 tháng", "hai tháng"], sai: ["1 tháng bơi", "một tháng bơi"] },
  { name: "F3 km gói 12 tháng", msg: "mua thẻ 12 tháng có tặng gì không ạ", dung: ["giải cơ", "dinh dưỡng", "hlv", "tập nhóm"] },
  { name: "F3 gói giảm cân", msg: "có gói trọn gói giảm cân cam kết không, giá sao ạ", dung: ["3.9 triệu", "5.4 triệu", "6.3 triệu", "cam kết"] },
  { name: "F3 giảm cân regression thẻ gym", msg: "em muốn giảm cân, cho hỏi gói gym 3 tháng bao nhiêu tiền ạ", dung: ["1.45 triệu"], sai: ["1.5 triệu"] },
];

async function main() {
  const rounds = Number(process.env.ROUNDS ?? "1");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  const failed: string[] = [];
  for (let r = 1; r <= rounds; r++) {
    if (rounds > 1) console.log(`\n########## VÒNG ${r} ##########`);
    for (const q of QUIZ) {
      const threadId = `quiz-${r}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      let reply = "";
      try {
        const out = await runGemmaTurn({ mastra, message: q.msg, threadId, resourceId: threadId });
        reply = (out.reply ?? "").trim();
      } catch (e) {
        reply = `[LỖI] ${(e as Error).message}`;
      }
      const low = reply.toLowerCase();
      const miss = (q.dung ?? []).length && !(q.dung ?? []).some((x) => has(low, x.toLowerCase()));
      const bad = (q.sai ?? []).filter((x) => has(low, x.toLowerCase()));
      const okk = !miss && !bad.length;
      if (!okk) failed.push(`${q.name}${rounds > 1 ? `#${r}` : ""}`);
      console.log(`\n${okk ? "✓" : "✗"} ${q.name}\n  KH: ${q.msg}\n  BOT: ${reply}`);
      if (miss) console.log(`  ⚠ thiếu (cần 1 trong): ${(q.dung ?? []).join(" | ")}`);
      if (bad.length) console.log(`  ⚠ có chuỗi CẤM: ${bad.join(", ")}`);
    }
  }
  const total = QUIZ.length * rounds;
  console.log(`\n${"═".repeat(60)}\nKẾT QUẢ: ${total - failed.length}/${total} đạt`);
  if (failed.length) console.log(`CHƯA ĐẠT: ${failed.join(", ")}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("Lỗi smoke:", e); process.exit(1); });

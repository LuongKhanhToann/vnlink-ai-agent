/**
 * smokeFamiDocs.ts — REPLY THẬT qua pipeline gemma cho nội dung mới nạp từ 2 doc Fami:
 *   xông hơi (fact mới), bơi làm bước nhẹ cho người thừa cân, tư vấn dinh dưỡng (phễu mềm),
 *   + kiểm RAG retrieveDocs trả đúng đoạn. Không đụng prod (STORAGE_BACKEND=libsql).
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeFamiDocs.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

import { retrieveDocs } from "../lib/docStore";

const cases: { name: string; msg: string; dung?: string[]; sai?: string[] }[] = [
  { name: "xông hơi (fact mới)", msg: "bên mình có phòng xông hơi không ạ", dung: ["xông hơi", "có"], sai: ["không có phòng xông hơi", "bên em không có xông hơi"] },
  { name: "thừa cân ngại tập tạ", msg: "em nặng 90kg ngại tập tạ lắm, có môn nào nhẹ nhàng hơn không", dung: ["bơi"] },
  { name: "giảm mỡ bền / dinh dưỡng", msg: "làm sao để giảm mỡ mà không bị béo lại ạ", dung: ["dinh dưỡng", "inbody", "vận động"] },
  { name: "hỏi tư vấn dinh dưỡng", msg: "bên mình có tư vấn về ăn uống dinh dưỡng không", dung: ["dinh dưỡng", "có"], sai: ["không có"] },
];

async function main() {
  console.log("═══ 1. RAG retrieveDocs (đoạn liên quan) ═══");
  for (const q of ["bơi cho người thừa cân đau khớp", "có phòng xông hơi tủ đồ không", "tác dụng của pilates", "tư vấn dinh dưỡng tế bào"]) {
    const r = await retrieveDocs(q);
    console.log(`\nQ: ${q}\n${r ? r.slice(0, 260).replace(/\n/g, " ") + "…" : "(không có đoạn khớp)"}`);
  }

  console.log("\n═══ 2. REPLY THẬT qua pipeline ═══");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  let fail = 0;
  for (const c of cases) {
    const threadId = `fami-doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const out = await runGemmaTurn({ mastra, message: c.msg, threadId, resourceId: threadId });
    const reply = (out.reply ?? "").trim();
    const low = reply.toLowerCase();
    const missing = (c.dung ?? []).filter((x) => !low.includes(x.toLowerCase()));
    const hasBad = (c.sai ?? []).filter((x) => low.includes(x.toLowerCase()));
    const bad = missing.length || hasBad.length;
    if (bad) fail++;
    console.log(`\n${bad ? "✗" : "✓"} ${c.name}\nKH: ${c.msg}\nBOT: ${reply}`);
    if (missing.length) console.log(`   thiếu (một trong tất cả cần có): ${missing.join(", ")}`);
    if (hasBad.length) console.log(`   có chuỗi CẤM: ${hasBad.join(", ")}`);
  }
  console.log(`\nKẾT QUẢ: ${cases.length - fail}/${cases.length} case đạt`);
  process.exit(0);
}
main().catch((e) => {
  console.error("Lỗi smoke:", e);
  process.exit(1);
});

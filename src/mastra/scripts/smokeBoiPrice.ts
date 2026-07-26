/**
 * smokeBoiPrice.ts — smoke REPLY THẬT cho ca báo giá mạch BƠI (vá 26/07).
 *
 * Hai kịch bản đối xứng, cố ý NHỎ để không tốn token khi chạy đường fallback 5.4:
 *   A) HOCBOI  — dựng đúng ca live convo 28415816001377936: "chưa biết bơi" → hỏi giá CHUNG CHUNG
 *      ("Chi phí tập ntn ạ"). ĐÚNG = số khoá học (1.5 triệu lớp nhóm / 3 triệu 1 kèm 1).
 *      SAI = thẻ bơi tháng (700 nghìn / 1.8 / 2.5 / 4.5 triệu) — đúng lỗi bot mắc sáng 26/07.
 *   B) THEBOI  — ca NGƯỢC (canh vá quá tay): cũng chưa biết bơi nhưng hỏi ĐÍCH DANH thẻ/vé bơi
 *      tự do theo tháng. ĐÚNG = 700 nghìn. SAI = 1.5 triệu.
 *   C) KHOAHOC — tin đầu của ca live 27782205061437941 (lượt từng bị fallback mini đẩy sang
 *      giai-co, báo 200k giải cơ). ĐÚNG = mạch bơi/khoá học, KHÔNG có "giải cơ"/"200 nghìn".
 *
 * Chạy gemma thật:      STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeBoiPrice.ts
 * Ép ĐƯỜNG FALLBACK 5.4: thêm FORCE_FALLBACK=1 → ghi đè GEMMA_API_KEY thành key rác nên gemma
 *   trả 401 (lỗi HTTP thật, không retry) — TÁI HIỆN ĐÚNG sự cố 401 live 24-25/07.
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
if (process.env.FORCE_FALLBACK === "1") {
  process.env.GEMMA_API_KEY = "sk-gemma-CO-Y-SAI-KEY-de-ep-401";
}

interface Scenario {
  name: string;
  turns: string[];
  /** Con số PHẢI xuất hiện ở lượt cuối (một trong các chuỗi này). */
  dung: string[];
  /** Con số TUYỆT ĐỐI KHÔNG được xuất hiện ở lượt cuối. */
  sai: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "A · HOCBOI (chưa biết bơi → hỏi giá chung chung)",
    turns: ["Có lớp học bơi cho người lớn không?", "Chưa biết bơi a", "Chi phí tập ntn ạ"],
    dung: ["1.5 triệu", "1,5 triệu", "3 triệu", "5 triệu"],
    sai: ["700 nghìn", "1.8 triệu", "2.5 triệu", "4.5 triệu", "600 nghìn", "3.6 triệu"],
  },
  {
    name: "B · THEBOI (chưa biết bơi → hỏi ĐÍCH DANH thẻ bơi tự do theo tháng)",
    turns: ["Chưa biết bơi nhưng cho e hỏi thẻ bơi tự do 1 tháng bao nhiêu ạ"],
    dung: ["700 nghìn"],
    sai: ["1.5 triệu", "1,5 triệu"],
  },
  {
    name: "C · KHOAHOC (tin đầu 'tư vấn khoá học bơi' — ca từng bị đẩy sang giai-co)",
    turns: ["Có lớp học bơi cho người lớn không?\nTư vấn cho tôi khóa học bơi"],
    dung: [],
    sai: ["giải cơ", "200 nghìn", "330 nghìn"],
  },
];

async function main() {
  const only = process.argv[2]?.toUpperCase();
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");

  console.log(
    `\n### đường chạy: ${process.env.FORCE_FALLBACK === "1" ? "FALLBACK 5.4 (gemma bị ép 401)" : "GEMMA thật"}`,
  );
  let fail = 0;
  for (const scn of SCENARIOS) {
    if (only && !scn.name.startsWith(only)) continue;
    const threadId = `smoke-boi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log(`\n${"═".repeat(72)}\n▶ ${scn.name}\n${"═".repeat(72)}`);
    let last = "";
    for (const msg of scn.turns) {
      console.log(`\nKH: ${msg.replace(/\n/g, " ⏎ ")}`);
      const t0 = Date.now();
      try {
        const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
        last = out.reply ?? "";
        console.log(`BOT (${((Date.now() - t0) / 1000).toFixed(1)}s): ${last}`);
      } catch (e) {
        console.error(`  ✗ LỖI LƯỢT:`, (e as Error)?.message);
        last = "";
        fail++;
      }
    }
    const hitSai = scn.sai.filter((x) => last.toLowerCase().includes(x.toLowerCase()));
    const hitDung = scn.dung.filter((x) => last.toLowerCase().includes(x.toLowerCase()));
    const ok = hitSai.length === 0 && (scn.dung.length === 0 || hitDung.length > 0);
    if (!ok) fail++;
    console.log(
      `\n  ${ok ? "✅ ĐẠT" : "❌ TRƯỢT"} — số đúng thấy: [${hitDung.join(", ") || "—"}] · số SAI thấy: [${hitSai.join(", ") || "—"}]`,
    );
  }
  console.log(`\n${fail === 0 ? "✅ TẤT CẢ ĐẠT" : `❌ ${fail} ca TRƯỢT`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

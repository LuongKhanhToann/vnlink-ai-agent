/**
 * smokeDocs.ts — kiểm tra phần THUẦN LOGIC của RAG tài liệu (Pha 3): cắt đoạn, parse text,
 * fail-open khi không có DB. KHÔNG gọi OpenAI, KHÔNG cần Postgres.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeDocs.ts
 */
for (const k of Object.keys(process.env)) if (k.startsWith("PG_DATABASE")) delete process.env[k];

import { chunkText, retrieveDocs } from "../lib/docStore";
import { parseUpload } from "../lib/parseUpload";
import { toVectorLiteral } from "../lib/embed";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}

// ── 1. chunkText ──
console.log("1. Cắt đoạn (chunkText):");
ok("text rỗng → 0 đoạn", chunkText("   ").length === 0);
ok("text ngắn → 1 đoạn", chunkText("Xin chào, đây là tài liệu ngắn.").length === 1);

const para = "Đoạn văn dinh dưỡng. ".repeat(60); // ~1260 ký tự
const big = para + "\n\n" + para + "\n\n" + para; // ~3800 ký tự
const chunks = chunkText(big);
ok("text dài → nhiều đoạn", chunks.length >= 3, `(${chunks.length})`);
ok("mỗi đoạn không vượt quá ngưỡng+overlap", chunks.every((c) => c.length <= 900 + 160));
ok("không có đoạn rỗng", chunks.every((c) => c.trim().length > 0));
const joinedLen = chunks.reduce((s, c) => s + c.length, 0);
ok("tổng có gối đầu (dài hơn gốc)", joinedLen >= big.replace(/\n{3,}/g, "\n\n").trim().length);

// ── 2. parseUpload ──
console.log("2. Đọc file (parseUpload):");
const txt = await parseUpload(Buffer.from("Nội dung file text.\nDòng 2.", "utf8"), "abc.txt");
ok("txt → đọc đúng nội dung", txt.text.includes("Nội dung file text") && txt.kind === "text");
const md = await parseUpload(Buffer.from("# Tiêu đề\nnội dung", "utf8"), "note.md");
ok("md → nhận là text", md.kind === "text");
let threwUnsupported = false;
try { await parseUpload(Buffer.from("x"), "hinh.png", "image/png"); } catch { threwUnsupported = true; }
ok("định dạng lạ (png) → ném lỗi", threwUnsupported);
let threwEmpty = false;
try { await parseUpload(Buffer.from("   ", "utf8"), "empty.txt"); } catch { threwEmpty = true; }
ok("file rỗng → ném lỗi", threwEmpty);

// ── 3. retrieveDocs fail-open (không DB) → "" ──
console.log("3. retrieveDocs fail-open:");
const got = await retrieveDocs("gói tập gym bao nhiêu tiền");
ok("không DB → trả \"\" (bot chạy như chưa có RAG)", got === "");
const gotShort = await retrieveDocs("a");
ok("câu quá ngắn → \"\" (không tốn embedding)", gotShort === "");

// ── 4. toVectorLiteral ──
console.log("4. Định dạng vector pgvector:");
ok("mảng số → literal [..]", toVectorLiteral([0.1, 0.2, -0.3]) === "[0.1,0.2,-0.3]");

console.log(`\nKẾT QUẢ: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

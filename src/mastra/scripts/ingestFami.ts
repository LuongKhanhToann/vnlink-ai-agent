/**
 * scripts/ingestFami.ts — Nạp 3 tài liệu Fami (nguyên văn 100%) vào kho RAG mới.
 *
 * Chạy:  npx -y tsx src/mastra/scripts/ingestFami.ts
 * Idempotent: xoá tài liệu cùng tên trước khi nạp lại (chạy nhiều lần không nhân đôi).
 * Đọc trực tiếp file .md trong src/mastra/knowledge — sửa nội dung ở đó rồi chạy lại là cập nhật.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestDoc, deleteDocsByTitle } from "../rag/store";

const HERE = dirname(fileURLToPath(import.meta.url));
const KDIR = resolve(HERE, "../knowledge");

const DOCS: { title: string; file: string }[] = [
  { title: "Tổng quan Fami Fitness", file: "01-tong-quan-fami.md" },
  { title: "Phân tích dịch vụ tập luyện", file: "02-phan-tich-dich-vu.md" },
  { title: "Bảng giá dịch vụ và khuyến mại", file: "03-bang-gia-khuyen-mai.md" },
];

async function main() {
  for (const d of DOCS) {
    const text = readFileSync(resolve(KDIR, d.file), "utf8");
    await deleteDocsByTitle(d.title);
    const r = await ingestDoc({ title: d.title, text, sourceKind: "fami" });
    console.log(`✓ "${d.title}" — ${r.chunks} đoạn (doc #${r.id})`);
  }
  console.log("Xong. 3 tài liệu Fami đã vào kho RAG.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Nạp tài liệu thất bại:", e);
  process.exit(1);
});

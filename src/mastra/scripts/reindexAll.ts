/**
 * scripts/reindexAll.ts — Nạp LẠI toàn bộ tài liệu đang có trong kho RAG theo chuẩn mới
 * (Contextual Retrieval + embed + index full-text). Cần chạy MỘT LẦN sau khi nâng cấp pipeline,
 * vì các đoạn cũ chưa có cột context/embed_text/tsv.
 *
 * Chạy:  npx -y tsx src/mastra/scripts/reindexAll.ts
 * TUẦN TỰ từng tài liệu (concurrency=1) — không fan-out, không ngốn tài nguyên hàng loạt.
 * Dùng nguyên văn đã lưu ở rag_docs.content; tài liệu cũ không có content sẽ bị bỏ qua (báo cảnh báo).
 */

import "dotenv/config";
import { allDocIds, getDoc, updateDoc } from "../rag/store";

async function main() {
  const ids = await allDocIds();
  if (!ids.length) {
    console.log("Kho RAG trống — không có gì để nạp lại.");
    process.exit(0);
  }
  console.log(`Nạp lại ${ids.length} tài liệu (tuần tự)...`);
  let ok = 0;
  let skipped = 0;
  for (const id of ids) {
    const doc = await getDoc(id);
    if (!doc) {
      console.warn(`  ⚠ #${id}: không đọc được, bỏ qua`);
      skipped++;
      continue;
    }
    if (!doc.content.trim()) {
      console.warn(`  ⚠ #${id} "${doc.title}": không có nguyên văn để nạp lại — cần re-upload thủ công`);
      skipped++;
      continue;
    }
    const r = await updateDoc(id, { title: doc.title, text: doc.content });
    console.log(`  ✓ #${id} "${doc.title}" — ${r.chunks} đoạn`);
    ok++;
  }
  console.log(`Xong. ${ok} nạp lại, ${skipped} bỏ qua.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Reindex thất bại:", e);
  process.exit(1);
});

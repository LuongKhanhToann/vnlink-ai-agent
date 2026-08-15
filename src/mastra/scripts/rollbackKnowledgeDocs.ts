/**
 * scripts/rollbackKnowledgeDocs.ts — GỠ toàn bộ kho kiến thức nền đã nạp (21/22/23), trả RAG về
 * nguyên trạng. KHÔNG đụng 3 doc Fami. Xoá theo ĐÚNG tiêu đề (đã khử trùng) như lúc ingest.
 *
 * Chạy:  npx -y tsx src/mastra/scripts/rollbackKnowledgeDocs.ts        # xem sẽ xoá gì (dry-run)
 *        CONFIRM=1 npx -y tsx src/mastra/scripts/rollbackKnowledgeDocs.ts   # xoá thật
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteDocsByTitle, listDocs } from "../rag/store";

const HERE = dirname(fileURLToPath(import.meta.url));
const KDIR = resolve(HERE, "../knowledge");
const MANIFESTS = ["21-manifest.json", "22-manifest.json", "23-manifest.json"];

interface Entry { file: string; title: string; chars: number }
const docCode = (f: string) => (f.match(/^(\d+-\d+)/)?.[1] ?? f.replace(/\.md$/, ""));

function titles(): string[] {
  const all: Entry[] = [];
  for (const mf of MANIFESTS) all.push(...(JSON.parse(readFileSync(resolve(KDIR, mf), "utf8")) as Entry[]));
  const count = new Map<string, number>();
  for (const e of all) count.set(e.title, (count.get(e.title) ?? 0) + 1);
  return all.map((e) => ((count.get(e.title) ?? 0) > 1 ? `${e.title} (mã ${docCode(e.file)})` : e.title));
}

async function main() {
  const wanted = new Set(titles());
  const present = (await listDocs()).filter((d) => wanted.has(d.title));
  console.log(`Kho kiến thức: ${wanted.size} tiêu đề trong manifest, ${present.length} đang có trong DB.`);
  if (!process.env.CONFIRM) {
    console.log("DRY-RUN (đặt CONFIRM=1 để xoá thật). Sẽ xoá:", present.length, "doc. Ví dụ:");
    for (const d of present.slice(0, 5)) console.log("  -", d.title);
    process.exit(0);
  }
  let n = 0;
  for (const t of wanted) { await deleteDocsByTitle(t); n++; }
  console.log(`Đã gọi xoá ${n} tiêu đề. 3 doc Fami không bị đụng.`);
  process.exit(0);
}
main().catch((e) => { console.error("rollback lỗi:", e); process.exit(1); });

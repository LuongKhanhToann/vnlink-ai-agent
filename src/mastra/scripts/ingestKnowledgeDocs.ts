/**
 * scripts/ingestKnowledgeDocs.ts — Nạp kho kiến thức nền (giảm cân + rối loạn chuyển hóa + tư duy
 * giải pháp) vào RAG. Đọc 3 manifest 21/22/23-manifest.json trong src/mastra/knowledge.
 *
 * Chạy:  npx -y tsx src/mastra/scripts/ingestKnowledgeDocs.ts
 *   LIMIT=1  → chỉ nạp 1 doc đầu (canary, test trước khi nạp cả kho).
 *   FORCE=1  → nạp lại cả doc đã tồn tại (mặc định: BỎ QUA doc đã có → resume được khi chạy lại).
 *
 * TUẦN TỰ (ingestDoc đã sequential, tôn trọng RPM key). KHÔNG đụng 3 doc Fami (ingestFami.ts lo).
 * Idempotent theo TIÊU ĐỀ: tiêu đề trùng giữa các sách được khử bằng hậu tố "(mã 21-005)".
 * Rollback: xoá theo đúng các tiêu đề in ra ở cuối (deleteDocsByTitle) hoặc xoá theo id trong admin.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestDoc, deleteDocsByTitle, listDocs } from "../rag/store";

const HERE = dirname(fileURLToPath(import.meta.url));
const KDIR = resolve(HERE, "../knowledge");
// Mặc định 3 manifest kho nền; override bằng env MANIFESTS="24-manifest.json" để nạp riêng 1 bộ.
const MANIFESTS = (process.env.MANIFESTS || "21-manifest.json,22-manifest.json,23-manifest.json")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Entry { file: string; title: string; chars: number }

function docCode(file: string): string {
  const m = file.match(/^(\d+-\d+)/);
  return m ? m[1] : file.replace(/\.md$/, "");
}

function loadEntries(): Entry[] {
  const all: Entry[] = [];
  for (const mf of MANIFESTS) {
    const arr = JSON.parse(readFileSync(resolve(KDIR, mf), "utf8")) as Entry[];
    all.push(...arr);
  }
  // Khử trùng tiêu đề: mọi tiêu đề xuất hiện >1 lần đều gắn hậu tố mã doc → duy nhất, ổn định.
  const count = new Map<string, number>();
  for (const e of all) count.set(e.title, (count.get(e.title) ?? 0) + 1);
  return all.map((e) =>
    (count.get(e.title) ?? 0) > 1 ? { ...e, title: `${e.title} (mã ${docCode(e.file)})` } : e,
  );
}

async function main() {
  const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : 0;
  const FORCE = process.env.FORCE === "1";

  let entries = loadEntries();
  const totalPlanned = entries.length;
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);

  // Sanity: không cho trùng tiêu đề sau khử (nếu còn thì dừng để khỏi xoá nhầm).
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.title)) throw new Error(`Tiêu đề vẫn trùng sau khử: "${e.title}" (${e.file})`);
    seen.add(e.title);
  }

  const existing = new Set((await listDocs()).map((d) => d.title));

  console.log(
    `Nạp kho kiến thức: ${entries.length}/${totalPlanned} doc` +
      (LIMIT ? ` (LIMIT=${LIMIT})` : "") +
      (FORCE ? " [FORCE]" : " [resume: bỏ qua doc đã có]"),
  );

  const t0 = Date.now();
  let done = 0, skipped = 0, chunksTotal = 0;
  const failures: { file: string; title: string; err: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const tag = `[${i + 1}/${entries.length}]`;
    if (!FORCE && existing.has(e.title)) {
      skipped++;
      console.log(`${tag} ○ skip (đã có): ${e.title}`);
      continue;
    }
    try {
      const text = readFileSync(resolve(KDIR, e.file), "utf8");
      await deleteDocsByTitle(e.title); // dọn bản cũ/nửa vời trước khi nạp
      const r = await ingestDoc({ title: e.title, text });
      done++; chunksTotal += r.chunks;
      const secs = Math.round((Date.now() - t0) / 1000);
      console.log(`${tag} ✓ ${e.title} — ${r.chunks} đoạn (doc #${r.id}) | Σ${chunksTotal} đoạn, ${secs}s`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      failures.push({ file: e.file, title: e.title, err: msg });
      console.error(`${tag} ✗ LỖI ${e.file}: ${msg}`);
    }
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(
    `\nXONG. nạp mới=${done}, bỏ qua=${skipped}, lỗi=${failures.length}, Σ đoạn=${chunksTotal}, ${secs}s`,
  );
  if (failures.length) {
    console.log("Các doc lỗi (chạy lại script để retry — doc đã xong sẽ tự bỏ qua):");
    for (const f of failures) console.log(`  - ${f.file} :: ${f.err}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Nạp kho kiến thức thất bại:", e);
  process.exit(1);
});

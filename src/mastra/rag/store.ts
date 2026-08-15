/**
 * rag/store.ts — Kho tài liệu RAG (lưu trữ + truy hồi cấp thấp) cho luồng Fami Fitness.
 *
 * Admin/khách upload tài liệu (PDF/Word/text) → cắt đoạn → SINH NGỮ CẢNH cho từng đoạn
 * (Contextual Retrieval, xem rag/contextualize) → embed dense (Gemini) + index full-text →
 * lưu pgvector. Mọi tài liệu MỚI upload đều đi qua ingestDoc/updateDoc nên tự động vào chuẩn này.
 *
 * File này CHỈ lo lưu trữ + trả ỨNG VIÊN thô (dense/sparse). Việc "hiểu câu hỏi" (viết lại query,
 * hợp nhất RRF, rerank, ghép khối) nằm ở rag/retrieve.ts — tầng điều phối hot path.
 *
 * Bảng RIÊNG (rag_docs/rag_chunks, vector 768) — KHÔNG đụng bảng cũ knowledge_docs (OpenAI 1536).
 * Pool riêng, CÙNG Postgres Supabase. Đọc mỗi lượt (KHÔNG cache). FAIL-OPEN ở tầng trên.
 */

import { Pool } from "pg";
import "dotenv/config";
import { embedOne, toVectorLiteral, EMBED_DIM } from "./embed";
import { contextualizeChunk } from "./contextualize";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    pool.on("error", (e) => console.error("[rag] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      // unaccent: bỏ dấu tiếng Việt cho full-text (khách gõ không dấu vẫn khớp).
      await p.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
      await p.query(
        `CREATE TABLE IF NOT EXISTS rag_docs (
           id          BIGSERIAL PRIMARY KEY,
           title       TEXT        NOT NULL,
           chunk_count INT         NOT NULL DEFAULT 0,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      // Lưu NGUYÊN VĂN nội dung để admin xem/sửa lại + để reindex lại không cần file gốc.
      await p.query(`ALTER TABLE rag_docs ADD COLUMN IF NOT EXISTS content TEXT`);
      // Nhãn nguồn: 'fami' = tài liệu vận hành (dịch vụ/giá/giờ/tiện ích) · 'knowledge' = sách kiến thức.
      // Dùng để truy hồi thêm nhánh CHỈ-Fami, chống sách kiến thức chen mất fact bán hàng. Metadata
      // của TÀI LIỆU (không phải phân loại ý khách) → không vi phạm luật cấm keyword-đoán-ý.
      await p.query(`ALTER TABLE rag_docs ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'knowledge'`);
      await p.query(
        `CREATE TABLE IF NOT EXISTS rag_chunks (
           id        BIGSERIAL PRIMARY KEY,
           doc_id    BIGINT NOT NULL REFERENCES rag_docs(id) ON DELETE CASCADE,
           idx       INT    NOT NULL,
           content   TEXT   NOT NULL,
           embedding vector(${EMBED_DIM})
         )`,
      );
      // Cột mới cho Contextual Retrieval + hybrid search (idempotent, an toàn với hàng cũ).
      //  context   : 1-2 câu định vị đoạn trong cả tài liệu (LLM sinh lúc ingest).
      //  embed_text: context + "\n\n" + content — CHÍNH XÁC thứ đã đem đi embed + index full-text.
      //  tsv       : vector full-text 'simple' đã bỏ dấu, cho sparse search.
      await p.query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS context TEXT`);
      await p.query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embed_text TEXT`);
      await p.query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS tsv tsvector`);
      await p.query(`CREATE INDEX IF NOT EXISTS rag_chunks_doc ON rag_chunks(doc_id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS rag_chunks_tsv ON rag_chunks USING GIN(tsv)`);
    })().catch((e) => {
      console.error("[rag] ensureSchema failed:", e);
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ── Cắt đoạn BÁM CẤU TRÚC (thao tác chuỗi thuần — parse markdown, không dính nghĩa nghiệp vụ) ──
//
// Mục tiêu: KHÔNG cắt cụt giữa bảng (bảng giá là linh hồn bot bán hàng), giữ heading của mục làm
// ngữ cảnh cho từng đoạn. Cơ chế:
//   1) Tách tài liệu thành "khối": bảng markdown (các dòng liên tiếp bắt đầu '|') là 1 khối NGUYÊN;
//      văn xuôi tách theo dòng trống; heading (#..) cập nhật ngữ cảnh mục hiện hành.
//   2) Gói các khối vào đoạn ~CHUNK_CHARS, KÈM heading mục ở đầu mỗi đoạn.
//   3) Bảng dài hơn CHUNK_CHARS → tách theo DÒNG nhưng LẶP LẠI dòng tiêu đề + dòng phân cách bảng.
const CHUNK_CHARS = 1100;
const CHUNK_OVERLAP = 150;

const isTableLine = (line: string): boolean => line.trim().startsWith("|");
const isHeadingLine = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("#") && t.includes(" ");
};
/** Dòng phân cách bảng markdown, ví dụ `| :-: | --- |` — chỉ gồm | : - và khoảng trắng. */
const isTableSeparator = (line: string): boolean => {
  const t = line.trim();
  if (!t.startsWith("|")) return false;
  for (const ch of t) if (ch !== "|" && ch !== ":" && ch !== "-" && ch !== " ") return false;
  return true;
};

type Block = { kind: "table" | "text"; text: string; heading: string };

/** Tách tài liệu thành các khối, gắn heading mục hiện hành cho mỗi khối. */
function toBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let heading = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isHeadingLine(line)) {
      heading = line.trim();
      i++;
      continue;
    }
    if (isTableLine(line)) {
      const buf: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) buf.push(lines[i++]);
      blocks.push({ kind: "table", text: buf.join("\n"), heading });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // Văn xuôi: gom tới dòng trống / bảng / heading kế.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isTableLine(lines[i]) && !isHeadingLine(lines[i]))
      buf.push(lines[i++]);
    blocks.push({ kind: "text", text: buf.join("\n"), heading });
  }
  return blocks;
}

/** Tách 1 bảng quá dài theo dòng, lặp lại dòng tiêu đề (+ phân cách) trên mỗi mảnh. */
function splitTable(tbl: string, heading: string): string[] {
  const rows = tbl.split("\n");
  // Giữ tối đa 2 dòng đầu làm header nếu dòng thứ 2 là phân cách bảng.
  const headerRows = rows.length > 1 && isTableSeparator(rows[1]) ? rows.slice(0, 2) : rows.slice(0, 1);
  const dataRows = rows.slice(headerRows.length);
  const prefix = (heading ? heading + "\n" : "") + headerRows.join("\n") + "\n";
  const out: string[] = [];
  let cur = "";
  for (const r of dataRows) {
    if (cur && (prefix + cur + "\n" + r).length > CHUNK_CHARS) {
      out.push(prefix + cur);
      cur = r;
    } else {
      cur = cur ? cur + "\n" + r : r;
    }
  }
  if (cur) out.push(prefix + cur);
  return out.length ? out : [prefix.trim()];
}

/** Cắt 1 khối văn xuôi dài theo ký tự (ranh giới câu/từ), như cũ. */
function splitProse(s: string): string[] {
  if (s.length <= CHUNK_CHARS) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + CHUNK_CHARS, s.length);
    if (end < s.length) {
      const slice = s.slice(start, end);
      const cut = lastOf(slice, "\n") ?? lastOf(slice, ". ") ?? lastOf(slice, " ");
      if (cut && cut > CHUNK_CHARS * 0.5) end = start + cut;
    }
    const piece = s.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= s.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
}

export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  if (text.length <= CHUNK_CHARS) return [text];

  const blocks = toBlocks(text);
  const chunks: string[] = [];
  let cur = "";
  let curHeading = "";

  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push(t);
    cur = "";
  };
  // Đầu mỗi đoạn kèm heading mục (nếu đoạn chưa mở bằng chính heading đó).
  const withHeading = (h: string, body: string) =>
    h && !body.trimStart().startsWith(h) ? `${h}\n${body}` : body;

  for (const b of blocks) {
    // Khối quá to → tự đứng thành (nhiều) đoạn riêng.
    if ((withHeading(b.heading, b.text)).length > CHUNK_CHARS) {
      flush();
      const parts = b.kind === "table" ? splitTable(b.text, b.heading) : splitProse(withHeading(b.heading, b.text));
      for (const p of parts) chunks.push(p.trim());
      curHeading = b.heading;
      continue;
    }
    const candidate = cur
      ? `${cur}\n\n${b.heading !== curHeading ? withHeading(b.heading, b.text) : b.text}`
      : withHeading(b.heading, b.text);
    if (candidate.length > CHUNK_CHARS) {
      flush();
      cur = withHeading(b.heading, b.text);
    } else {
      cur = candidate;
    }
    curHeading = b.heading;
  }
  flush();
  return chunks.filter(Boolean);
}
function lastOf(s: string, sep: string): number | null {
  const i = s.lastIndexOf(sep);
  return i < 0 ? null : i + sep.length;
}

// ── Nạp tài liệu (dùng chung cho seed script LẪN upload của admin/khách) ──

interface PreparedChunk {
  content: string;
  context: string;
  embedText: string;
  vec: string;
}

/**
 * Sinh ngữ cảnh + embed cho từng đoạn — TUẦN TỰ (không fan-out, tôn trọng RPM key).
 * Chạy NGOÀI transaction: không giữ connection mở suốt các call mạng.
 */
async function prepareChunks(docText: string, chunks: string[]): Promise<PreparedChunk[]> {
  const out: PreparedChunk[] = [];
  for (const chunk of chunks) {
    // Contextual Retrieval: định vị đoạn trong cả tài liệu (fail-open "" nếu LLM lỗi).
    const context = await contextualizeChunk(docText, chunk);
    const embedText = context ? `${context}\n\n${chunk}` : chunk;
    const vec = toVectorLiteral(await embedOne(embedText, "RETRIEVAL_DOCUMENT"));
    out.push({ content: chunk, context, embedText, vec });
  }
  return out;
}

/** Insert nhanh các đoạn đã chuẩn bị (trong transaction). */
async function insertChunks(client: any, docId: number, prepared: PreparedChunk[]): Promise<void> {
  for (let i = 0; i < prepared.length; i++) {
    const c = prepared[i];
    await client.query(
      `INSERT INTO rag_chunks (doc_id, idx, content, context, embed_text, embedding, tsv)
       VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('simple', unaccent($5)))`,
      [docId, i, c.content, c.context, c.embedText, c.vec],
    );
  }
}

export async function ingestDoc(input: { title: string; text: string; sourceKind?: string }): Promise<{ id: number; chunks: number }> {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Thiếu tên tài liệu");
  const docText = input.text ?? "";
  const sourceKind = input.sourceKind === "fami" ? "fami" : "knowledge"; // mặc định 'knowledge'
  const chunks = chunkText(docText);
  if (!chunks.length) throw new Error("Tài liệu rỗng hoặc không đọc được nội dung");

  await ensureSchema();
  const prepared = await prepareChunks(docText, chunks); // network NGOÀI transaction
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO rag_docs (title, chunk_count, content, source_kind) VALUES ($1,$2,$3,$4) RETURNING id`,
      [title, chunks.length, docText, sourceKind],
    );
    const docId = Number(rows[0].id);
    await insertChunks(client, docId, prepared);
    await client.query("COMMIT");
    return { id: docId, chunks: chunks.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Xoá tài liệu cùng tên trước khi nạp lại (idempotent cho seed). */
export async function deleteDocsByTitle(title: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM rag_docs WHERE title = $1`, [title.trim()]);
}

// ── Truy hồi cấp thấp (ứng viên thô cho tầng hybrid ở retrieve.ts) ──

export interface Candidate {
  id: number;
  docId: number;
  title: string;
  content: string;
  /** cosine distance (dense) — nhỏ = giống hơn; undefined nếu đến từ sparse. */
  dist?: number;
  /** ts_rank_cd (sparse) — lớn = khớp hơn; undefined nếu đến từ dense. */
  rank?: number;
}

/** Có tài liệu nào trong kho chưa (để tầng trên bỏ qua sớm). */
export async function hasDocs(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getPool().query(`SELECT 1 FROM rag_chunks LIMIT 1`);
    return !!r.rowCount;
  } catch {
    return false;
  }
}

/** Dense: K đoạn gần nhất theo cosine. vecLiteral = pgvector '[...]'. sourceKind lọc theo nhãn nguồn. */
export async function denseCandidates(vecLiteral: string, limit: number, sourceKind?: string): Promise<Candidate[]> {
  await ensureSchema();
  const filter = sourceKind ? ` AND d.source_kind = $3` : "";
  const params: any[] = sourceKind ? [vecLiteral, limit, sourceKind] : [vecLiteral, limit];
  const { rows } = await getPool().query(
    `SELECT c.id, c.doc_id, d.title, c.content, (c.embedding <=> $1) AS dist
       FROM rag_chunks c JOIN rag_docs d ON d.id = c.doc_id
      WHERE c.embedding IS NOT NULL${filter}
      ORDER BY c.embedding <=> $1
      LIMIT $2`,
    params,
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    docId: Number(r.doc_id),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    dist: Number(r.dist),
  }));
}

/**
 * Sparse: full-text tiếng Việt (bỏ dấu), kiểu BM25 — OR các từ trong câu hỏi rồi xếp theo
 * ts_rank_cd (mật độ khớp). KHÔNG dùng websearch_to_tsquery vì nó AND mọi từ → câu dài không khớp gì.
 * Lấy lexeme từ chính câu hỏi (an toàn, không lo cú pháp tsquery) rồi nối bằng ' | '.
 */
export async function sparseCandidates(queryText: string, limit: number, sourceKind?: string): Promise<Candidate[]> {
  const q = (queryText ?? "").trim();
  if (!q) return [];
  await ensureSchema();
  const filter = sourceKind ? ` AND d.source_kind = $3` : "";
  const params: any[] = sourceKind ? [q, limit, sourceKind] : [q, limit];
  const { rows } = await getPool().query(
    `WITH qq AS (
       SELECT to_tsquery('simple',
                array_to_string(tsvector_to_array(to_tsvector('simple', unaccent($1))), ' | ')
              ) AS query
     )
     SELECT c.id, c.doc_id, d.title, c.content, ts_rank_cd(c.tsv, qq.query) AS rank
       FROM rag_chunks c JOIN rag_docs d ON d.id = c.doc_id, qq
      WHERE qq.query != '' AND c.tsv @@ qq.query${filter}
      ORDER BY rank DESC
      LIMIT $2`,
    params,
  );
  return rows.map((r: any) => ({
    id: Number(r.id),
    docId: Number(r.doc_id),
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    rank: Number(r.rank),
  }));
}

// ── Admin CRUD ──
export interface DocMeta {
  id: number;
  title: string;
  chunk_count: number;
  created_at: string;
}

export async function listDocs(): Promise<DocMeta[]> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT id, title, chunk_count, created_at FROM rag_docs ORDER BY created_at DESC`,
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      title: String(r.title ?? ""),
      chunk_count: Number(r.chunk_count ?? 0),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
    }));
  } catch (e) {
    console.error("[rag] listDocs failed:", (e as Error).message);
    return [];
  }
}

export async function deleteDoc(id: number): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM rag_docs WHERE id=$1`, [id]);
}

/** Lấy nguyên văn 1 tài liệu để admin xem/sửa. Tài liệu cũ (chưa có cột content) → ghép tạm từ chunks. */
export async function getDoc(id: number): Promise<{ id: number; title: string; content: string } | null> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT id, title, content FROM rag_docs WHERE id=$1`, [id]);
  if (!rows.length) return null;
  let content = String(rows[0].content ?? "");
  if (!content) {
    const ch = await getPool().query(`SELECT content FROM rag_chunks WHERE doc_id=$1 ORDER BY idx ASC`, [id]);
    content = ch.rows.map((r: any) => String(r.content ?? "")).join("\n\n");
  }
  return { id: Number(rows[0].id), title: String(rows[0].title ?? ""), content };
}

/** Sửa 1 tài liệu: cập nhật tên + nội dung, cắt lại đoạn + contextualize + embed lại (thay toàn bộ chunk cũ). */
export async function updateDoc(id: number, input: { title: string; text: string }): Promise<{ chunks: number }> {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Thiếu tên tài liệu");
  const docText = input.text ?? "";
  const chunks = chunkText(docText);
  if (!chunks.length) throw new Error("Tài liệu rỗng hoặc không đọc được nội dung");

  await ensureSchema();
  const prepared = await prepareChunks(docText, chunks); // network NGOÀI transaction
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE rag_docs SET title=$2, content=$3, chunk_count=$4 WHERE id=$1`,
      [id, title, docText, chunks.length],
    );
    if (!rowCount) throw new Error("Không tìm thấy tài liệu");
    await client.query(`DELETE FROM rag_chunks WHERE doc_id=$1`, [id]);
    await insertChunks(client, id, prepared);
    await client.query("COMMIT");
    return { chunks: chunks.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Danh sách id mọi tài liệu (cho script reindex chạy tuần tự). */
export async function allDocIds(): Promise<number[]> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT id FROM rag_docs ORDER BY id ASC`);
  return rows.map((r: any) => Number(r.id));
}

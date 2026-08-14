/**
 * rag/store.ts — Kho tài liệu RAG cho luồng mới (Fami Fitness).
 *
 * Admin upload tài liệu (PDF/Word/text) → cắt đoạn → embed (Gemini) → lưu pgvector.
 * Mỗi lượt chat: embed câu khách → tìm K đoạn gần nhất → bơm khối [TÀI LIỆU] vào system prompt.
 *
 * Bảng RIÊNG (rag_docs/rag_chunks, vector 768) — KHÔNG đụng bảng cũ knowledge_docs (OpenAI 1536).
 * Pool riêng, CÙNG Postgres Supabase. Đọc mỗi lượt (không cache). FAIL-OPEN: lỗi/chưa có tài liệu → "".
 */

import { Pool } from "pg";
import "dotenv/config";
import { embedTexts, embedOne, toVectorLiteral, EMBED_DIM } from "./embed";

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
      await p.query(
        `CREATE TABLE IF NOT EXISTS rag_docs (
           id          BIGSERIAL PRIMARY KEY,
           title       TEXT        NOT NULL,
           chunk_count INT         NOT NULL DEFAULT 0,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await p.query(
        `CREATE TABLE IF NOT EXISTS rag_chunks (
           id        BIGSERIAL PRIMARY KEY,
           doc_id    BIGINT NOT NULL REFERENCES rag_docs(id) ON DELETE CASCADE,
           idx       INT    NOT NULL,
           content   TEXT   NOT NULL,
           embedding vector(${EMBED_DIM})
         )`,
      );
      await p.query(`CREATE INDEX IF NOT EXISTS rag_chunks_doc ON rag_chunks(doc_id)`);
    })().catch((e) => {
      console.error("[rag] ensureSchema failed:", e);
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

// ── Cắt đoạn (thao tác chuỗi thuần) ──
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;

export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const cut = lastOf(slice, "\n\n") ?? lastOf(slice, "\n") ?? lastOf(slice, ". ") ?? lastOf(slice, " ");
      if (cut && cut > CHUNK_CHARS * 0.5) end = start + cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}
function lastOf(s: string, sep: string): number | null {
  const i = s.lastIndexOf(sep);
  return i < 0 ? null : i + sep.length;
}

// ── Nạp tài liệu ──
export async function ingestDoc(input: { title: string; text: string }): Promise<{ id: number; chunks: number }> {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Thiếu tên tài liệu");
  const chunks = chunkText(input.text ?? "");
  if (!chunks.length) throw new Error("Tài liệu rỗng hoặc không đọc được nội dung");

  const vectors = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO rag_docs (title, chunk_count) VALUES ($1,$2) RETURNING id`,
      [title, chunks.length],
    );
    const docId = Number(rows[0].id);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO rag_chunks (doc_id, idx, content, embedding) VALUES ($1,$2,$3,$4)`,
        [docId, i, chunks[i], toVectorLiteral(vectors[i])],
      );
    }
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

// ── Retrieve (hot path) ──
const TOP_K = 6;
const MAX_DISTANCE = 0.62; // cosine distance; nhỏ = giống hơn

/**
 * Tìm đoạn liên quan câu khách → khối [TÀI LIỆU THAM KHẢO] bơm vào system prompt.
 * FAIL-OPEN: chưa có tài liệu / lỗi → "".
 */
export async function retrieveDocs(query: string): Promise<string> {
  const q = (query ?? "").trim();
  if (q.length < 3) return "";
  try {
    await ensureSchema();
    const p = getPool();
    const exists = await p.query(`SELECT 1 FROM rag_chunks LIMIT 1`);
    if (!exists.rowCount) return "";

    const vec = toVectorLiteral(await embedOne(q, "RETRIEVAL_QUERY"));
    const { rows } = await p.query(
      `SELECT content, (embedding <=> $1) AS dist
         FROM rag_chunks
        ORDER BY embedding <=> $1
        LIMIT $2`,
      [vec, TOP_K],
    );
    const hits = (rows as { content: string; dist: number }[]).filter((r) => Number(r.dist) <= MAX_DISTANCE);
    if (!hits.length) return "";
    const body = hits.map((h, i) => `(${i + 1}) ${h.content.trim()}`).join("\n\n");
    return `═══ TÀI LIỆU THAM KHẢO (trích từ tài liệu Fami Fitness — dùng để trả lời CÓ CĂN CỨ) ═══
${body}
⚠ Chỉ dùng phần khớp câu hỏi. TUYỆT ĐỐI KHÔNG bịa số/giá/chính sách không có trong tài liệu.`;
  } catch (e) {
    console.error('[rag] retrieveDocs failed → fail-open (""):', (e as Error).message);
    return "";
  }
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

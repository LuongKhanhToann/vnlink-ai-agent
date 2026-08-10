/**
 * docStore.ts — TÀI LIỆU THAM KHẢO khách nạp (dinh dưỡng / trị liệu / fitness / sale) → RAG.
 *
 * Luồng: admin upload file (PDF/Word/text) → cắt đoạn (chunk) → embed → lưu pgvector.
 * Mỗi lượt chat: embed câu khách → tìm K đoạn gần nhất → nếu đủ liên quan thì bơm khối
 * [TÀI LIỆU THAM KHẢO] vào system prompt cho bot trả lời có căn cứ.
 *
 * Nguyên tắc (giống knowledgeStore.ts):
 *   - Pool riêng, CÙNG Postgres Supabase (bảng vector nằm chung DB với semantic-recall).
 *   - Đọc mỗi lượt (không cache) — nạp/xoá tài liệu trên admin có hiệu lực ngay.
 *   - FAIL-OPEN: chưa có tài liệu / lỗi DB / lỗi embedding → trả "" → bot chạy y như chưa có RAG.
 *   - Retrieve chỉ tốn 1 lần embedding/lượt KHI đã có tài liệu; chưa nạp gì → 1 truy vấn nhẹ, bỏ qua.
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
    pool.on("error", (e) => console.error("[docStore] pool error:", e));
  }
  return pool;
}

/**
 * Nhóm tài liệu = 4 loại KIẾN THỨC khách quản lý (fitness, tăng giảm cân, dinh dưỡng, trị liệu)
 * + 2 nhóm phụ (cách sale, chung). Free-text cũng được, đây chỉ là gợi ý cho admin.
 */
export const DOC_CATEGORIES = ["fitness", "tang-giam-can", "dinh-duong", "tri-lieu", "sale", "chung"] as const;

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const p = getPool();
      await p.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      await p.query(
        `CREATE TABLE IF NOT EXISTS knowledge_docs (
           id          BIGSERIAL PRIMARY KEY,
           title       TEXT        NOT NULL,
           category    TEXT        NOT NULL DEFAULT 'chung',
           chunk_count INT         NOT NULL DEFAULT 0,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      );
      await p.query(
        `CREATE TABLE IF NOT EXISTS knowledge_chunks (
           id        BIGSERIAL PRIMARY KEY,
           doc_id    BIGINT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
           idx       INT    NOT NULL,
           content   TEXT   NOT NULL,
           embedding vector(${EMBED_DIM})
         )`,
      );
      await p.query(`CREATE INDEX IF NOT EXISTS knowledge_chunks_doc ON knowledge_chunks(doc_id)`);
    })().catch((e) => {
      console.error("[docStore] ensureSchema failed:", e);
      schemaReady = null; // cho retry
      throw e;
    });
  }
  return schemaReady;
}

// ─────────────────────────────────────────────────────────────
// CẮT ĐOẠN (chunk) — thao tác chuỗi thuần, không phải quyết định nghiệp vụ
// ─────────────────────────────────────────────────────────────
const CHUNK_CHARS = 900; // ~1 đoạn vừa cho embedding, đủ ngữ cảnh
const CHUNK_OVERLAP = 150; // gối đầu để câu không bị cắt cụt giữa 2 chunk

/** Cắt text dài thành các đoạn ~900 ký tự, ưu tiên ranh giới đoạn/câu, có gối đầu. */
export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return [];
  if (text.length <= CHUNK_CHARS) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      // lùi về ranh giới đẹp gần nhất (xuống dòng kép > xuống dòng > chấm câu > khoảng trắng)
      const slice = text.slice(start, end);
      const cut =
        lastOf(slice, "\n\n") ??
        lastOf(slice, "\n") ??
        lastOf(slice, ". ") ??
        lastOf(slice, " ");
      if (cut && cut > CHUNK_CHARS * 0.5) end = start + cut;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

/** Vị trí (kết thúc) lần xuất hiện cuối của sep trong s, hoặc null. */
function lastOf(s: string, sep: string): number | null {
  const i = s.lastIndexOf(sep);
  return i < 0 ? null : i + sep.length;
}

// ─────────────────────────────────────────────────────────────
// NẠP TÀI LIỆU
// ─────────────────────────────────────────────────────────────

/** Nạp 1 tài liệu: cắt đoạn → embed → lưu doc + chunks trong 1 transaction. Trả {id, chunks}. */
export async function ingestDoc(input: {
  title: string;
  category?: string;
  text: string;
}): Promise<{ id: number; chunks: number }> {
  const title = (input.title ?? "").trim();
  if (!title) throw new Error("Thiếu tên tài liệu");
  const category = (input.category ?? "chung").trim() || "chung";
  const chunks = chunkText(input.text ?? "");
  if (!chunks.length) throw new Error("Tài liệu rỗng hoặc không đọc được nội dung");

  const vectors = await embedTexts(chunks); // ném lỗi → nơi gọi báo admin, không lưu nửa vời

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO knowledge_docs (title, category, chunk_count) VALUES ($1,$2,$3) RETURNING id`,
      [title, category, chunks.length],
    );
    const docId = Number(rows[0].id);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO knowledge_chunks (doc_id, idx, content, embedding) VALUES ($1,$2,$3,$4)`,
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

// ─────────────────────────────────────────────────────────────
// RETRIEVE (hot path)
// ─────────────────────────────────────────────────────────────
const TOP_K = 4;
/**
 * Ngưỡng khoảng cách cosine (<=> với vector đã chuẩn hoá ≈ 1 - cosine). Nhỏ hơn = giống hơn.
 * 0.55 lọc bỏ đoạn lạc đề để KHÔNG bơm rác khi câu khách chẳng liên quan tài liệu nào.
 */
const MAX_DISTANCE = 0.55;

/**
 * Tìm đoạn tài liệu liên quan câu khách → khối [TÀI LIỆU THAM KHẢO] để bơm system prompt.
 * FAIL-OPEN: chưa có tài liệu / lỗi → "". Chạy song song classifier nên độ trễ ẩn dưới classify.
 */
export async function retrieveDocs(query: string): Promise<string> {
  const q = (query ?? "").trim();
  if (q.length < 3) return "";
  try {
    await ensureSchema();
    const p = getPool();
    // Chưa nạp tài liệu nào → bỏ qua HẲN (không tốn 1 call embedding) → bot chạy y như cũ.
    const exists = await p.query(`SELECT 1 FROM knowledge_chunks LIMIT 1`);
    if (!exists.rowCount) return "";

    const vec = toVectorLiteral(await embedOne(q));
    const { rows } = await p.query(
      `SELECT c.content, (c.embedding <=> $1) AS dist
         FROM knowledge_chunks c
        ORDER BY c.embedding <=> $1
        LIMIT $2`,
      [vec, TOP_K],
    );
    const hits = (rows as { content: string; dist: number }[]).filter((r) => Number(r.dist) <= MAX_DISTANCE);
    if (!hits.length) return "";
    const body = hits.map((h, i) => `(${i + 1}) ${h.content.trim()}`).join("\n\n");
    return `═══ TÀI LIỆU THAM KHẢO (khách nạp — dùng để trả lời CÓ CĂN CỨ, diễn đạt lại bằng lời em, KHÔNG chép nguyên văn dài dòng) ═══
${body}
⚠ Chỉ dùng khi khớp câu khách hỏi; KHÔNG khớp thì bỏ qua. TUYỆT ĐỐI KHÔNG bịa số/giá/chính sách không có trong tài liệu hay bảng giá.`;
  } catch (e) {
    console.error("[docStore] retrieveDocs failed → fail-open (\"\"):", (e as Error).message);
    return "";
  }
}

// ─────────────────────────────────────────────────────────────
// ADMIN CRUD
// ─────────────────────────────────────────────────────────────
export interface DocMeta {
  id: number;
  title: string;
  category: string;
  chunk_count: number;
  created_at: string;
}

/** Danh sách tài liệu đã nạp (không kèm nội dung chunk). Lỗi DB → mảng rỗng. */
export async function listDocs(): Promise<DocMeta[]> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT id, title, category, chunk_count, created_at FROM knowledge_docs ORDER BY created_at DESC`,
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      title: String(r.title ?? ""),
      category: String(r.category ?? "chung"),
      chunk_count: Number(r.chunk_count ?? 0),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ""),
    }));
  } catch (e) {
    console.error("[docStore] listDocs failed:", (e as Error).message);
    return [];
  }
}

/** Xoá 1 tài liệu (chunks tự xoá theo ON DELETE CASCADE). */
export async function deleteDoc(id: number): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM knowledge_docs WHERE id=$1`, [id]);
}

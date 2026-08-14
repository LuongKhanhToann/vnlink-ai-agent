/**
 * rag/embed.ts — Embedding qua Google AI Studio (gemini-embedding-001), miễn phí.
 *
 * Xoay 3 key giống bên chat để rải quota. Dùng cosine distance (<=>) khi truy vấn nên KHÔNG
 * cần chuẩn hoá vector. outputDimensionality=768 cho vector gọn (KB nhỏ, đủ chất lượng).
 * taskType tách RETRIEVAL_DOCUMENT (lúc nạp) và RETRIEVAL_QUERY (lúc hỏi) cho khớp cặp.
 */

import "dotenv/config";
import { geminiKeys } from "../llm/gemini";

export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
export const EMBED_DIM = Number(process.env.GEMINI_EMBED_DIM || 768);

const TIMEOUT_MS = 30_000;
let keyCursor = 0;

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/** Chuyển mảng số → literal pgvector '[a,b,c]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

async function embedOnceWithKey(text: string, task: EmbedTask, key: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: task,
        outputDimensionality: EMBED_DIM,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const err = new Error(`embed HTTP ${res.status}: ${detail}`);
      (err as any).status = res.status;
      throw err;
    }
    const data: any = await res.json();
    const vec = data?.embedding?.values;
    if (!Array.isArray(vec) || !vec.length) throw new Error("embed trả rỗng");
    return vec as number[];
  } finally {
    clearTimeout(timer);
  }
}

/** Embed 1 text, xoay key khi cạn quota (429/403). */
export async function embedOne(text: string, task: EmbedTask = "RETRIEVAL_QUERY"): Promise<number[]> {
  const keys = geminiKeys();
  if (!keys.length) throw new Error("Chưa cấu hình GEMINI_API_KEYS");
  const start = keyCursor++ % keys.length;
  let lastError: Error = new Error("embed thất bại");
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length];
    try {
      return await embedOnceWithKey(text, task, key);
    } catch (e) {
      const status = (e as any)?.status;
      lastError = e as Error;
      if (status === 429 || status === 403) {
        console.warn(`[embed] key #${((start + i) % keys.length) + 1} cạn quota → xoay key`);
        continue;
      }
      throw e; // lỗi khác (400…) không phải do quota → ném luôn
    }
  }
  throw lastError;
}

/** Embed nhiều text (tuần tự, xoay key). KB nhỏ nên tuần tự là đủ, tránh vượt RPM. */
export async function embedTexts(texts: string[], task: EmbedTask = "RETRIEVAL_DOCUMENT"): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) out.push(await embedOne(t, task));
  return out;
}

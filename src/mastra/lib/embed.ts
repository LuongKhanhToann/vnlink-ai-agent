/**
 * embed.ts — lấy vector embedding từ OpenAI cho RAG tài liệu (docStore.ts).
 *
 * Dùng CHUNG model + số chiều với semantic-recall của Mastra (config/embeddings.ts:
 * text-embedding-3-small = 1536 chiều) để bảng vector nhất quán. Gọi thẳng REST endpoint
 * bằng fetch cho gọn — không kéo thêm SDK. Cần OPENAI_API_KEY (đã có sẵn cho semantic recall).
 */
import "dotenv/config";
import { EMBED_MODEL, EMBED_DIM } from "../config/embeddings";

export { EMBED_DIM };

const ENDPOINT = "https://api.openai.com/v1/embeddings";

/**
 * Embed nhiều đoạn text 1 lần (OpenAI nhận mảng input). Trả mảng vector cùng thứ tự.
 * Ném lỗi nếu thiếu key / API lỗi / số chiều lệch — nơi gọi tự quyết fail-open.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Thiếu OPENAI_API_KEY để tạo embedding");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
  const data = json.data ?? [];
  if (data.length !== texts.length) throw new Error(`embeddings trả về ${data.length}/${texts.length} vector`);
  // OpenAI trả kèm index — sắp đúng thứ tự đầu vào cho chắc.
  const out: number[][] = new Array(texts.length);
  for (const d of data) {
    if (d.embedding.length !== EMBED_DIM) {
      throw new Error(`vector ${d.embedding.length} chiều ≠ ${EMBED_DIM} (đổi model?)`);
    }
    out[d.index] = d.embedding;
  }
  return out;
}

/** Embed 1 đoạn (tiện cho query lúc retrieve). */
export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

/** pgvector nhận literal dạng "[0.1,0.2,...]". */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

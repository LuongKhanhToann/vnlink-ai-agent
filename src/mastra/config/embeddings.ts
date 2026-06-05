import { createOpenAI } from "@ai-sdk/openai";
import "dotenv/config";

/**
 * embeddings.ts — embedder cho semantic recall (RAG nhớ full text per-user).
 *
 * ⚠️ SỐ CHIỀU PHẢI KHỚP (quan trọng):
 *   - Mastra dùng CHUNG 1 embedder cho cả lúc INDEX tin nhắn lẫn lúc QUERY (embed tin mới)
 *     → vector luôn cùng model, cùng số chiều ⇒ không bao giờ lệch khi search.
 *   - Cột pgvector được Mastra tự tạo theo đúng số chiều output của embedder này.
 *   - EMBED_DIM ở đây chỉ để tham chiếu/cảnh báo: nếu ĐỔI model thì số chiều đổi theo
 *     (small=1536, large=3072) → BẮT BUỘC tạo lại (drop) index cũ, không thể trộn.
 *
 * Lưu ý: client OpenAI này KHÁC client ở config/openai.ts — cái kia trỏ baseURL DeepSeek
 * (DeepSeek KHÔNG có endpoint embeddings). Cái này dùng OpenAI thật để lấy embeddings.
 */

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536; // text-embedding-3-small → 1536 chiều

const openaiReal = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  // baseURL mặc định = https://api.openai.com/v1
});

export const embedder = openaiReal.embedding(EMBED_MODEL);

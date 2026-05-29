import { createOpenAI } from "@ai-sdk/openai";
import "dotenv/config";

// DeepSeek API tương thích OpenAI → giữ nguyên createOpenAI, chỉ đổi baseURL + key.
export const openai = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Model id tập trung 1 chỗ. id chính thức (lowercase) theo docs api.deepseek.com.
// Override qua env DEEPSEEK_MODEL nếu cần (vd "deepseek-v4-flash" cho phản hồi nhanh hơn).
export const CHAT_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";

// QUAN TRỌNG: @ai-sdk/openai v3 mặc định openai(id) → Responses API (/responses),
// mà DeepSeek CHỈ có Chat Completions (/chat/completions) → openai(id) sẽ 404.
// Phải dùng .chat() để ép sang endpoint /chat/completions.
export const chatModel = openai.chat(CHAT_MODEL);

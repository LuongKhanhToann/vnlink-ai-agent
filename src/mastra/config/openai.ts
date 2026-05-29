import { createOpenAI } from "@ai-sdk/openai";
import "dotenv/config";

// DeepSeek API tương thích OpenAI → giữ nguyên createOpenAI, chỉ đổi baseURL + key.
export const openai = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Tách model theo vai trò:
//  - REPLY_MODEL: câu tư vấn khách đọc → ưu tiên chất lượng → pro mặc định (chậm hơn).
//  - CLASSIFIER_MODEL: phân loại/extract slot mỗi lượt (JSON, ẩn với khách) → ưu tiên
//    tốc độ + ổn định → flash mặc định (pro ở đây chỉ tổ chậm ~30s vô ích).
// Override bằng env REPLY_MODEL / CLASSIFIER_MODEL nếu cần đổi không phải sửa code.
export const REPLY_MODEL = process.env.REPLY_MODEL ?? "deepseek-v4-pro";
export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL ?? "deepseek-v4-flash";

// QUAN TRỌNG: @ai-sdk/openai v3 mặc định openai(id) → Responses API (/responses),
// mà DeepSeek CHỈ có Chat Completions (/chat/completions) → openai(id) sẽ 404.
// Phải dùng .chat() để ép sang endpoint /chat/completions.
export const replyModel = openai.chat(REPLY_MODEL);
export const classifierModel = openai.chat(CLASSIFIER_MODEL);

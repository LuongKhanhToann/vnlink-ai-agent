import { createOpenAI } from "@ai-sdk/openai";
import "dotenv/config";

// DeepSeek API tương thích OpenAI → giữ nguyên createOpenAI, chỉ đổi baseURL + key.
export const openai = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// Model id tập trung 1 chỗ. id chính thức (lowercase) theo docs api.deepseek.com.
// Override qua env DEEPSEEK_MODEL nếu cần (vd "deepseek-v4-flash").
export const CHAT_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";

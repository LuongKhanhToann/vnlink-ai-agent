import { createOpenAI } from "@ai-sdk/openai";
import "dotenv/config";

// PROVIDER SWITCH (reversible):
//   Mặc định = OPENAI (DeepSeek đang âm số dư, is_available:false → mọi call bị từ chối).
//   Reply  = gpt-5.4-mini  (mạnh hơn nhiều 4o-mini, ~1.4s, không tốn reasoning tokens)
//   Classifier = gpt-5.4-mini (nâng từ 4o-mini: đo A/B thắng rõ ở objection "đắt thế e",
//     refine ngày, corporate, tăng-cân-vs-tăng-cơ — xem scripts/classifierAB.ts. Sau khi
//     đảo prompt classifier cho cache (head ~6.1k byte-identical), giá ~ngang 4o-mini).
//   Lùi về DeepSeek: set LLM_PROVIDER=deepseek (khi tài khoản đã nạp tiền lại).
//   Override model lẻ: REPLY_MODEL / CLASSIFIER_MODEL.
// Lưu ý gpt-5.x: chỉ nhận max_completion_tokens (không max_tokens) — code không truyền
// maxTokens nên không dính; KHÔNG thêm maxTokens vào modelSettings cho dòng gpt-5.
const PROVIDER = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();
const USE_OPENAI = PROVIDER === "openai";

// DeepSeek API tương thích OpenAI → giữ nguyên createOpenAI, chỉ đổi baseURL + key.
const deepseekClient = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});
// OpenAI client (fallback) — dùng baseURL mặc định của OpenAI.
const openaiClient = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const openai = USE_OPENAI ? openaiClient : deepseekClient;

// Tách model theo vai trò:
//  - REPLY_MODEL: câu tư vấn khách đọc → ưu tiên chất lượng → pro mặc định (chậm hơn).
//  - CLASSIFIER_MODEL: phân loại/extract slot mỗi lượt (JSON, ẩn với khách) → ưu tiên
//    tốc độ + ổn định → flash mặc định (pro ở đây chỉ tổ chậm ~30s vô ích).
// Override bằng env REPLY_MODEL / CLASSIFIER_MODEL nếu cần đổi không phải sửa code.
export const REPLY_MODEL =
  process.env.REPLY_MODEL ?? (USE_OPENAI ? "gpt-5.4-mini" : "deepseek-v4-pro");
export const CLASSIFIER_MODEL =
  process.env.CLASSIFIER_MODEL ?? (USE_OPENAI ? "gpt-5.4-mini" : "deepseek-v4-flash");

// QUAN TRỌNG: @ai-sdk/openai v3 mặc định openai(id) → Responses API (/responses),
// mà DeepSeek CHỈ có Chat Completions (/chat/completions) → openai(id) sẽ 404.
// Phải dùng .chat() để ép sang endpoint /chat/completions.
export const replyModel = openai.chat(REPLY_MODEL);
export const classifierModel = openai.chat(CLASSIFIER_MODEL);

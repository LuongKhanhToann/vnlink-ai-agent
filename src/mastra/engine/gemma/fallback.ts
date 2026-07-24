/**
 * fallback.ts — DỰ PHÒNG khi Gemma (ollama qua tailscale) CHẾT giữa lượt.
 *
 * KHÔNG phải đường chính: chỉ bật khi callOllama đã cạn retry mà vẫn lỗi TẠM THỜI/mạng
 * (fetch failed do tailscale chớp, 502/503/504, hoặc TỰ timeout). Lúc đó thay vì để khách
 * nhận tin lỗi / mất lượt, ta chạy CÙNG prompt + CÙNG schema qua 5.4 (client có sẵn ở
 * config/openai.ts). Giữ NGUYÊN 1 pipeline/1 prompt/1 FSM — chỉ đổi "đường ống".
 *
 * Vì 5.4 dùng raw JSON-Schema của gemma (không phải Zod của Mastra structuredOutput), ta
 * BƠM schema vào prompt + JSON.parse (5.4 bám schema-in-prompt rất chuẩn) — tránh nhân đôi
 * schema sang Zod (sợ drift). Import ĐỘNG từ llm.ts để happy-path không nạp OpenAI client.
 */
import { Agent } from "@mastra/core/agent";
import { classifierModel, replyModel } from "../../config/openai";
import type { ChatMsg } from "./llm";

/** Tắt bằng GEMMA_FALLBACK=0 (mặc định BẬT). Đọc lúc gọi, không phải lúc load. */
export const fallbackEnabled = (): boolean => (process.env.GEMMA_FALLBACK ?? "1") !== "0";

/** Gemma đặt system + user riêng; Mastra Agent gộp system vào `instructions`. */
function splitSystem(messages: ChatMsg[]): { instructions: string; rest: ChatMsg[] } {
  const instructions = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return { instructions, rest };
}

/** 5.4 thỉnh thoảng bọc ```json … ``` — lấy đúng object JSON ngoài cùng rồi parse. */
function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

/** Dự phòng CLASSIFY: 5.4-mini + CÙNG CLS_SCHEMA (bơm vào prompt) → JSON.parse. */
export async function fallbackJson<T>(
  messages: ChatMsg[],
  schema: unknown,
  abortSignal?: AbortSignal,
): Promise<{ value: T; seconds: number }> {
  const t0 = Date.now();
  const { instructions, rest } = splitSystem(messages);
  const agent = new Agent({
    name: "gemma-fallback-cls",
    id: "gemma-fallback-cls",
    model: classifierModel,
    instructions:
      instructions +
      "\n\n⚠ ĐỊNH DẠNG ĐẦU RA (tuân thủ tuyệt đối, ưu tiên hơn mọi hướng dẫn 'rút gọn' ở trên): " +
      "chỉ trả về DUY NHẤT một object JSON — KHÔNG markdown, KHÔNG rào ```], KHÔNG giải thích.\n" +
      "• 8 field trong \"required\" của schema (flow, khach_xung, bo_mon, doi_tuong, khach_hoi_gia, " +
      "gia_hoi_ve, an_toan, media) LUÔN phải có mặt với GIÁ TRỊ ĐÚNG — tuyệt đối KHÔNG được bỏ, " +
      "kể cả khi phải LẶP LẠI giá trị trong TRẠNG THÁI ĐÃ BIẾT.\n" +
      "• bo_mon: nếu tin khách/lịch sử nêu bộ môn thì PHẢI đúng 1 trong gym/yoga/zumba/boi/pilates/" +
      "full; thật sự chưa rõ mới để \"\" (KHÔNG dùng \"chua-ro\" cho bo_mon).\n" +
      "• CHỈ các field NGOÀI 8 field required mới được BỎ khỏi JSON khi không có bằng chứng " +
      "(đừng ghi \"\").\n\nJSON Schema:\n" +
      JSON.stringify(schema),
  });
  const res = await agent.generate(rest, { modelSettings: { temperature: 0 }, abortSignal });
  const value = JSON.parse(extractJson(res.text ?? "")) as T;
  return { value, seconds: (Date.now() - t0) / 1000 };
}

/** Dự phòng GENERATE: 5.4 (full) + CÙNG system/history/context → văn bản reply. */
export async function fallbackChat(
  messages: ChatMsg[],
  opts: { temperature: number },
  abortSignal?: AbortSignal,
): Promise<{ text: string; seconds: number }> {
  const t0 = Date.now();
  const { instructions, rest } = splitSystem(messages);
  const agent = new Agent({
    name: "gemma-fallback-gen",
    id: "gemma-fallback-gen",
    model: replyModel,
    instructions,
  });
  // gpt-5.x chỉ nhận max_completion_tokens (xem config/openai.ts) → KHÔNG set maxTokens.
  const res = await agent.generate(rest, { modelSettings: { temperature: opts.temperature }, abortSignal });
  return { text: (res.text ?? "").trim(), seconds: (Date.now() - t0) / 1000 };
}

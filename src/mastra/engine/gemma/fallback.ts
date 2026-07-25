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

/**
 * Biến CLS_SCHEMA thành dạng `strict` của OpenAI structured output: strict BẮT BUỘC mọi field
 * nằm trong `required`, nên field vốn optional được cho phép thêm giá trị `null` (= "không có tin
 * mới"), rồi `stripNulls` xoá đi để FSM nhận ĐÚNG shape lean của gemma (vắng field = giữ giá trị cũ).
 */
function strictify(schema: any): any {
  const props = schema?.properties ?? {};
  const req: string[] = schema?.required ?? [];
  const out: any = { type: "object", properties: {}, required: Object.keys(props), additionalProperties: false };
  for (const [k, v] of Object.entries<any>(props)) {
    if (req.includes(k)) {
      out.properties[k] = v;
      continue;
    }
    const types = Array.isArray(v.type) ? v.type : [v.type];
    const nv: any = { ...v, type: [...types, "null"] };
    if (Array.isArray(v.enum)) nv.enum = [...v.enum, null];
    out.properties[k] = nv;
  }
  return out;
}

/** Field `null` (do strict ép phải có mặt) = không có tin mới → BỎ, đúng luật sticky của updateState. */
function stripNulls(o: any): any {
  if (!o || typeof o !== "object") return o;
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return o;
}

/**
 * Đường CHÍNH của classify dự phòng: gọi thẳng /chat/completions với `response_format:
 * json_schema strict` — model bị RÀNG BUỘC theo schema y như grammar của ollama, không còn cửa
 * tự chế field/giá trị ngoài enum như lối bơm-schema-vào-prompt.
 * Model mặc định là gpt-5.4 FULL (không phải mini): đo 15 lượt trên tin "tư vấn khóa học bơi",
 * mini trượt 2 (1 lần ra flow=giai-co → bot báo giá giải cơ 200k cho khách hỏi bơi — ca live
 * 25/07 convo 27782205061437941), full 0/10. Fallback hiếm khi chạy nên chênh giá không đáng kể.
 * Override: FALLBACK_CLS_MODEL.
 */
async function strictClassify(
  instructions: string,
  rest: ChatMsg[],
  schema: unknown,
  abortSignal?: AbortSignal,
): Promise<any> {
  const useOpenai = (process.env.LLM_PROVIDER ?? "openai").toLowerCase() === "openai";
  const key = useOpenai ? process.env.OPENAI_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("thiếu API key cho classify strict");
  const base = useOpenai ? "https://api.openai.com/v1" : "https://api.deepseek.com";
  const model = process.env.FALLBACK_CLS_MODEL || (useOpenai ? "gpt-5.4" : "deepseek-v4-pro");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "system", content: instructions }, ...rest],
      response_format: {
        type: "json_schema",
        json_schema: { name: "classification", strict: true, schema: strictify(schema) },
      },
    }),
    signal: abortSignal,
  });
  if (!res.ok) throw new Error(`classify strict HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as any;
  const text = body?.choices?.[0]?.message?.content ?? "";
  return stripNulls(JSON.parse(extractJson(text)));
}

/** Dự phòng CLASSIFY: schema-strict (đường chính) → nếu lỗi thì lối cũ bơm-schema-vào-prompt. */
export async function fallbackJson<T>(
  messages: ChatMsg[],
  schema: unknown,
  abortSignal?: AbortSignal,
): Promise<{ value: T; seconds: number }> {
  const t0 = Date.now();
  const { instructions, rest } = splitSystem(messages);
  try {
    const value = (await strictClassify(instructions, rest, schema, abortSignal)) as T;
    return { value, seconds: (Date.now() - t0) / 1000 };
  } catch (e) {
    if (abortSignal?.aborted) throw e;
    console.warn(`[gemma] classify strict lỗi (${(e as Error)?.message}) → lối cũ prompt-schema`);
  }
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

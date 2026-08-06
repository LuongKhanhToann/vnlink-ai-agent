/**
 * measureGeminiModel.ts — ĐO tốc độ thật + số token THINKING của MỘT model Gemini trên prompt
 * pipeline THẬT (không phải prompt ngắn — vì độ dài prompt quyết định model thinking nhiều hay ít).
 *
 * Vì sao cần: gemma-4 trên Gemini API là thinking model BẮT BUỘC (không gửi thinkingConfig được —
 * API trả 400). Latency = thời gian sinh (thought token + answer token). `thoughtsTokenCount` do
 * chính Google trả về là bằng chứng khách quan model nghĩ bao nhiêu. Prompt NGẮN → nghĩ ít → nhanh;
 * prompt DÀI của classifier (~6-7k token) → nghĩ ~1200-2300 token → chậm. Script này đo trên đúng
 * prompt dài đó để con số khớp với lúc chạy live.
 *
 * Chạy:
 *   npx -y tsx src/mastra/scripts/measureGeminiModel.ts gemma-4-31b-it
 *   npx -y tsx src/mastra/scripts/measureGeminiModel.ts gemini-flash-lite-latest 5   # lặp 5 lần
 * (Cần 1 GEMINI key CÒN quota trong .env; nếu 429 nghĩa là key đã cạn lượt ngày.)
 */
import "dotenv/config";
import { buildClassifierMessages, CLS_SCHEMA } from "../engine/gemma/classifier";
import { buildSystemPrompt } from "../engine/gemma/prompt";
import { buildDateBlock } from "../engine/gemma/dates";
import { newState } from "../engine/gemma/state";
import type { ChatMsg } from "../engine/gemma/llm";

const KEYS = (process.env.GEMINI_API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
let ki = 0;

async function call(model: string, messages: ChatMsg[], json: boolean, maxOut: number) {
  const systemText = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n").trim();
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const sys = json ? systemText + "\n\n⚠ Chỉ trả DUY NHẤT một object JSON đúng schema:\n" + JSON.stringify(CLS_SCHEMA) : systemText;
  const body = { systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: json ? 0 : 0.3, maxOutputTokens: maxOut, ...(json ? { responseMimeType: "application/json" } : {}) } };
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEYS[ki++ % KEYS.length] }, body: JSON.stringify(body),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res.ok) return `✗ HTTP ${res.status} sau ${secs}s ${res.status === 429 ? "(key CẠN quota ngày — thử key khác hoặc chờ reset)" : (await res.text()).slice(0, 120)}`;
  const d: any = await res.json();
  const parts = d?.candidates?.[0]?.content?.parts ?? [];
  const answer = parts.filter((p: any) => p?.thought !== true).map((p: any) => p?.text ?? "").join("").trim();
  const thought = d?.usageMetadata?.thoughtsTokenCount ?? 0;
  let jsonOk = "";
  if (json) { try { JSON.parse(answer.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()); jsonOk = " jsonOk=true"; } catch { jsonOk = " jsonOk=FALSE"; } }
  return `${secs}s | thinking=${thought} token | answer=${answer.length} ký tự | finish=${d?.candidates?.[0]?.finishReason}${jsonOk}`;
}

async function main() {
  const model = process.argv[2];
  const iters = Number.parseInt(process.argv[3] || "2", 10);
  if (!model) { console.error("Dùng: npx tsx .../measureGeminiModel.ts <model-id> [số lần lặp]"); process.exit(1); }
  if (!KEYS.length) { console.error("Chưa có GEMINI_API_KEYS trong .env"); process.exit(1); }

  const s = newState();
  const clsMsgs = buildClassifierMessages(s, "", "c muốn giảm cân là chính, 1m60 70kg, tập gym với zumba giá sao ạ");
  const replyMsgs: ChatMsg[] = [
    { role: "system", content: buildSystemPrompt(buildDateBlock(), "fitness") },
    { role: "user", content: "cho hỏi tập gym với zumba bên mình giá thế nào ạ, em muốn giảm cân" },
  ];
  console.log(`\nĐo model: ${model}  (prompt pipeline thật, lặp ${iters} lần/loại)\n${"─".repeat(64)}`);
  for (let i = 1; i <= iters; i++) console.log(`  CLASSIFY #${i}: ${await call(model, clsMsgs, true, 450 + 2600)}`);
  for (let i = 1; i <= iters; i++) console.log(`  REPLY    #${i}: ${await call(model, replyMsgs, false, 500 + 2600)}`);
  console.log(`\nGhi chú: thinking>0 và nhiều (vd >1000) là lý do chậm — Gemma bắt buộc thinking, KHÔNG tắt được.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

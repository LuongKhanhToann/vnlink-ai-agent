/**
 * demoClsKnobLive.ts — DEMO knob classifier đổi phân loại THẬT qua LLM (không ghi DB).
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/demoClsKnobLive.ts
 *
 * Cùng 1 câu khách, classify 2 lần: (a) mặc định, (b) có override knob cls_flow.
 * Chứng minh: admin sửa knob → prompt phân loại đổi → model ra flow khác. Truyền override
 * THẲNG vào buildClassifierMessages (như loadKnowledge().blocks) — KHÔNG đụng bot_content prod.
 */
import "dotenv/config";
import { buildClassifierMessages, clsSchemaFor, type Classification } from "../engine/gemma/classifier";
import { callJson, resolveLlmConfig } from "../engine/gemma/llm";
import { newState } from "../engine/gemma/state";

// Chính sách mới (admin Hoa Sen): "thư giãn / xả stress" đưa về GIẢI CƠ thay vì yoga bên Fami.
// Giữ đủ 3 mã hệ thống (fitness / giai-co / chua-ro) nên qua được cổng validateClsKnob.
const OVERRIDE_FLOW =
  "- flow: fitness = nhu cầu TẬP (gym/yoga/zumba/bơi/pilates) và mục tiêu giảm/tăng cân, tăng cơ, sức khoẻ. " +
  "giai-co = khách ĐANG ĐAU MỎI muốn trị liệu, HOẶC khách muốn THƯ GIÃN / xả stress / nghỉ ngơi thả lỏng " +
  "(CHÍNH SÁCH MỚI: mọi nhu cầu thư giãn đưa về bên giải cơ Hoa Sen, KHÔNG còn đẩy sang yoga). " +
  "Không xác định được và trạng thái cũng chưa rõ → chua-ro. " +
  "Mọi tin nhắc bơi/gym/tạ/yoga/zumba/thẻ tập vẫn là fitness.";

const INPUT = "em muốn tìm chỗ nào thư giãn xả stress cuối tuần với ạ";

async function classifyOnce(overrides: Record<string, string> = {}): Promise<Classification> {
  const s = newState();
  const msgs = buildClassifierMessages(s, "", INPUT, overrides);
  const cfg = resolveLlmConfig({ timeoutMs: 60_000 });
  const { value } = await callJson<Classification>(msgs, clsSchemaFor(s, false), { maxTokens: 2600 }, cfg);
  return value;
}

(async () => {
  console.log(`Câu khách: "${INPUT}"\n`);

  const base = await classifyOnce();
  console.log("① MẶC ĐỊNH (chưa sửa knob):");
  console.log(`   flow = ${base.flow}   (thư giãn → coi là tập → Fami/yoga)\n`);

  const ov = await classifyOnce({ cls_flow: OVERRIDE_FLOW });
  console.log("② SAU KHI ADMIN SỬA knob 'Định tuyến Fitness ↔ Giải cơ':");
  console.log(`   flow = ${ov.flow}   (thư giãn → chính sách mới → Hoa Sen giải cơ)\n`);

  const flipped = base.flow !== ov.flow;
  console.log(flipped
    ? `✅ KNOB ĐỔI PHÂN LOẠI: ${base.flow} → ${ov.flow}. Cùng 1 câu, chỉ khác nội dung admin sửa.`
    : `⚠ Lần này 2 kết quả trùng (${base.flow}). Model có thể dao động — thử lại hoặc câu khác.`);
})().catch((e) => {
  console.error("Lỗi LLM:", (e as Error)?.message);
  process.exit(1);
});

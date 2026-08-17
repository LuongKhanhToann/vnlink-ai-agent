/**
 * scripts/smokeKichbanDay.ts — Như runTurn nhưng ÉP giờ BAN NGÀY (09:00) để đọc được cách xử lý
 * kịch bản THẬT (không bị nhắc-ngủ-đêm nuốt mất P.A.E.S.C/CTA). Mirror y hệt engine/brain.ts:39.
 * Chỉ để smoke; KHÔNG lưu lịch sử, KHÔNG đụng prod.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeKichbanDay.ts
 */
import "dotenv/config";
import { FAMI_SYSTEM } from "../prompts/fami";
import { retrieveForTurn } from "../rag/retrieve";
import { vnParts, buildTimeBlock } from "../lib/timeContext";
import { loadConfig } from "../lib/settings";
import { generateReply, type ChatMsg } from "../llm/gemini";

// 09:00 sáng thứ Hai — chắc chắn không rơi vào khung nhắc ngủ đêm.
const DAY = new Date("2026-08-17T09:00:00+07:00");

const CASES = [
  "gói của bên em đắt quá, anh chưa có đủ tiền",
  "anh sợ đăng ký xong lại lười không đi tập đều thì phí tiền",
  "trung tâm hơi xa nhà anh, đi lại ngại quá",
  "em nhịn ăn mãi mà không giảm được cân",
];

async function reply(message: string): Promise<string> {
  const docBlock = await retrieveForTurn({ message, history: [] });
  const now = vnParts(DAY);
  const config = await loadConfig();
  const timeBlock = buildTimeBlock(now, config);
  const systemContent = [FAMI_SYSTEM, timeBlock, docBlock].filter(Boolean).join("\n\n");
  const messages: ChatMsg[] = [
    { role: "system", content: systemContent },
    { role: "user", content: `(${now.hhmm}) ${message}` },
  ];
  return (await generateReply(messages, { temperature: 0.6, maxTokens: 700 })).trim();
}

async function main() {
  for (let i = 0; i < CASES.length; i++) {
    console.log(`\n════ [${i + 1}] 👤 ${CASES[i]}`);
    try { console.log(`🤖 ${await reply(CASES[i])}`); }
    catch (e: any) { console.log(`✗ LỖI: ${e?.message ?? e}`); }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

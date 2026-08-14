/**
 * engine/brain.ts — Một lượt hội thoại của luồng RAG mới (thay engine/gemma cũ).
 *
 * Luồng đơn giản, "basic RAG":
 *   1) Nạp N tin gần nhất (lib/history).
 *   2) RAG: embed câu khách → lấy đoạn tài liệu liên quan (rag/store).
 *   3) Ghép system(FAMI_SYSTEM + tài liệu) + lịch sử + câu khách → 1 call Gemini (cascade + xoay key).
 *   4) Lưu câu khách + câu trả vào history.
 * Không FSM, không classifier, không tool media. Lỗi model → ném ra để webhook nuốt (bot im lượt đó).
 */

import { generateReply, type ChatMsg } from "../llm/gemini";
import { retrieveDocs } from "../rag/store";
import { loadRecent, appendMessage } from "../lib/history";
import { FAMI_SYSTEM } from "../prompts/fami";

export interface TurnInput {
  senderId: string;
  message: string;
  abortSignal?: AbortSignal;
}

export async function runTurn(input: TurnInput): Promise<{ reply: string }> {
  const { senderId, message, abortSignal } = input;

  // (1) + (2) chạy song song: lịch sử và RAG độc lập nhau.
  const [history, docBlock] = await Promise.all([loadRecent(senderId), retrieveDocs(message)]);

  const systemContent = docBlock ? `${FAMI_SYSTEM}\n\n${docBlock}` : FAMI_SYSTEM;
  const messages: ChatMsg[] = [
    { role: "system", content: systemContent },
    ...history.map((t) => ({ role: t.role, content: t.content }) as ChatMsg),
    { role: "user", content: message },
  ];

  const reply = (await generateReply(messages, { temperature: 0.6, maxTokens: 700, abortSignal })).trim();
  if (!reply) throw new Error("model trả rỗng");

  // Lưu sau khi có reply (best-effort bên trong).
  await appendMessage(senderId, "user", message);
  await appendMessage(senderId, "assistant", reply);

  return { reply };
}

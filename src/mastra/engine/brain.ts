/**
 * engine/brain.ts — Một lượt hội thoại của luồng RAG mới (thay engine/gemma cũ).
 *
 * Luồng RAG "full best-practice" (viết-lại-query theo hội thoại → hybrid → RRF → rerank):
 *   1) Nạp N tin gần nhất (lib/history) — CẦN cho bước viết lại query theo ngữ cảnh.
 *   2) RAG: retrieveForTurn(message + history) → khối tài liệu đã rerank, có trích nguồn (rag/retrieve).
 *   3) Ghép system(FAMI_SYSTEM + tài liệu) + lịch sử + câu khách → 1 call Gemini (cascade + xoay key).
 *   4) Lưu câu khách + câu trả vào history.
 * Không FSM, không classifier, không tool media. Lỗi model → ném ra để webhook nuốt (bot im lượt đó).
 */

import { generateReply, type ChatMsg } from "../llm/gemini";
import { retrieveForTurn } from "../rag/retrieve";
import { loadRecent, appendMessage } from "../lib/history";
import { FAMI_SYSTEM } from "../prompts/fami";
import { vnParts, buildTimeBlock, stampFor } from "../lib/timeContext";
import { loadConfig } from "../lib/settings";

export interface TurnInput {
  senderId: string;
  message: string;
  abortSignal?: AbortSignal;
}

export async function runTurn(input: TurnInput): Promise<{ reply: string }> {
  const { senderId, message, abortSignal } = input;

  // (1) lịch sử TRƯỚC — bước viết lại query cần nó để hiểu tham chiếu ("còn cái kia?").
  const history = await loadRecent(senderId);
  // (2) RAG theo ngữ cảnh hội thoại (fail-open "" bên trong).
  const docBlock = await retrieveForTurn({ message, history });

  // (3) Bối cảnh thời gian thật + kíp trực — chèn vào system để model không "ngáo giờ" (nhầm
  //     tối nay thành hôm qua) và biết mình đang trực ca nào, tên gì. Gắn dấu (HH:MM) đầu mỗi tin
  //     lịch sử để model hiểu đúng mốc thời gian của từng lượt.
  const now = vnParts();
  const config = await loadConfig(); // giờ nghỉ đêm + kíp trực do admin cấu hình (đọc mỗi lượt)
  const timeBlock = buildTimeBlock(now, config);
  const systemContent = [FAMI_SYSTEM, timeBlock, docBlock].filter(Boolean).join("\n\n");
  const messages: ChatMsg[] = [
    { role: "system", content: systemContent },
    ...history.map(
      (t) =>
        ({
          role: t.role,
          content: t.createdAt ? `(${stampFor(new Date(t.createdAt), now)}) ${t.content}` : t.content,
        }) as ChatMsg,
    ),
    { role: "user", content: `(${now.hhmm}) ${message}` },
  ];

  const reply = (await generateReply(messages, { temperature: 0.6, maxTokens: 700, abortSignal })).trim();
  if (!reply) throw new Error("model trả rỗng");

  // Lưu sau khi có reply (best-effort bên trong).
  await appendMessage(senderId, "user", message);
  await appendMessage(senderId, "assistant", reply);

  return { reply };
}

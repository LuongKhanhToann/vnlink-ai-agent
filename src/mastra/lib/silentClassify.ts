/**
 * silentClassify.ts
 *
 * Chạy classifier + cập nhật ConversationState (slot/stage/flow) cho tin khách gửi
 * trong lúc AI đang TẮT — KHÔNG sinh reply, KHÔNG ghi sheets.
 *
 * Tái dùng ĐÚNG pipeline của processStep (workflows/routerWorkflow.ts): classify →
 * buildNextState → saveState. Nhờ vậy khi admin BẬT lại, bot không chỉ thấy transcript
 * (qua memory) mà còn biết slot đã trích được (tên, SĐT, giờ hẹn, môn…) → không hỏi lại
 * thứ khách đã nói với nhân viên trong lúc tắt.
 *
 * KHÔNG ghi sheets ở đây: lúc AI tắt thường là nhân viên đang xử lý tay → để việc chốt
 * đơn cho lượt bot thật sự re-engage (tryWriteLeadIfReady chạy sau reply như cũ).
 */

import { loadState, saveState } from "./stateStore";
import { classify } from "./classifier";
import { buildNextState, detectFlowByKeyword, needsFlowClassification } from "./stateMachine";

// Hàng đợi nối tiếp theo sender: khách gửi liên tiếp lúc tắt → các lần classify chạy
// TUẦN TỰ (không song song) để tránh 2 lần cùng load 1 prevState → mất cập nhật slot.
// Đây là điều phối concurrency, KHÔNG phải cache dữ liệu.
const chains = new Map<string, Promise<void>>();

async function runClassifyAndSave(
  threadId: string,
  resourceId: string,
  message: string,
): Promise<void> {
  // Dynamic import tránh circular dep (index → routes → lib → index).
  const { mastra } = await import("../index");

  const previousState = await loadState(mastra, threadId, resourceId);

  const keywordFlow = detectFlowByKeyword(message, previousState.flow);
  const needFlowLLM = needsFlowClassification(keywordFlow, previousState);

  const llmResult = await classify({
    message,
    previousFlow: previousState.flow,
    previousStage: previousState.stage,
    currentKnownInfo: previousState.knownInfo,
    needFlowClassification: needFlowLLM,
    previousIntentTopic: previousState.intentTopic,
  });
  if (!needFlowLLM) llmResult.flow = keywordFlow;

  const nextState = buildNextState(previousState, message, llmResult);
  nextState.lastUserMessage = message;

  await saveState(mastra, threadId, resourceId, nextState);
  console.log(
    `[silent] AI off — cập nhật state cho ${threadId}: flow=${nextState.flow} stage=${nextState.stage} slots=${JSON.stringify(nextState.knownInfo)}`,
  );
}

/**
 * Xếp 1 tin (lúc AI tắt) vào hàng đợi classify của sender đó. Trả promise của lượt này.
 * Best-effort: lỗi classify/DB chỉ log, không ném ra ngoài (không được chặn webhook).
 */
/** Xoá hàng đợi classify in-memory của 1 sender (admin "xoá dữ liệu chat"). */
export function cancelClassifyChain(threadId: string): void {
  chains.delete(threadId);
}

export function classifyAndUpdateState(
  threadId: string,
  resourceId: string,
  message: string,
): Promise<void> {
  const prev = chains.get(threadId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // lỗi lượt trước không làm hỏng lượt sau
    .then(() => runClassifyAndSave(threadId, resourceId, message))
    .catch((e) => {
      console.error(`[silent] classifyAndUpdateState failed for ${threadId}:`, e);
    });
  chains.set(threadId, next);
  // Dọn map khi chuỗi rỗng (tránh giữ promise vô hạn theo từng sender).
  void next.finally(() => {
    if (chains.get(threadId) === next) chains.delete(threadId);
  });
  return next;
}

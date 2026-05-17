/**
 * lib/validator.ts — Output validator (Phase 5 refactor).
 *
 * Validate reply trước khi gửi cho khách. Bắt các trường hợp bot drift / im lặng / bịa:
 *   - Reply rỗng / quá ngắn (< 20 chars)
 *   - URL leak vào text (đã cleanReply nhưng double-check)
 *   - Markdown leak (bold/italic/link)
 *   - Internal pricing shorthand chưa expand ("12m=5tr")
 *   - Câu hỏi nhiều hơn 1 dấu "?" (rule: 1 câu hỏi/reply)
 *
 * Fail validation → caller gọi safeFallback() thay vì gửi reply có lỗi.
 *
 * Triết lý: deterministic check sau LLM — KHÔNG bao giờ trust LLM 100%.
 */

import type { ConversationState } from "./stateMachine";

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Safe fallback reply khi LLM output không validate được.
 * Mềm + invite mà KHÔNG cam kết → bot không drift / im lặng.
 */
export function safeFallback(state: ConversationState): string {
  const h =
    state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
  // Stage-specific fallback — context-aware nhưng vẫn safe
  if (state.stage === "commitment" && state.knownInfo.preferredTime) {
    return `Dạ vâng ${h}, ${h} cho em xin tên với SĐT để em giữ slot ạ.`;
  }
  if (state.stage === "commitment") {
    return `Dạ vâng ${h}, ${h} cho em xin thêm thông tin để em hỗ trợ chốt slot ạ.`;
  }
  if (state.stage === "evaluation" || state.stage === "negotiation") {
    return `Dạ vâng ${h}, ${h} tiện ghé buổi sáng hay chiều để em hỗ trợ tư vấn trực tiếp ạ.`;
  }
  // Default: discovery / opening / fallback chung
  return `Dạ vâng ${h}, ${h} cho em xin thêm chi tiết để tư vấn cụ thể hơn ạ.`;
}

/**
 * Off-topic safe response — khi classifier output edge/off_topic và không có template.
 * Note lại + handover sale người (KHÔNG để bot bịa).
 */
export function offTopicFallback(state: ConversationState): string {
  const h =
    state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
  return `Dạ câu này em note lại để sale bên em phản hồi cụ thể sau ạ. ${h} có nhu cầu nào khác về dịch vụ trung tâm để em hỗ trợ tư vấn ngay không ạ.`;
}

/**
 * Validate reply text. Trả về { valid, reasons[] }.
 * Caller: if (!valid) → dùng safeFallback().
 */
export function validateReply(
  reply: string,
  state: ConversationState,
): ValidationResult {
  const reasons: string[] = [];

  // 1. Length check — quá ngắn = bot không thực sự reply
  if (!reply || reply.trim().length < 20) {
    reasons.push(`reply too short (${reply?.length ?? 0} chars)`);
  }

  // 2. URL leak (cleanReply strip mọi URL trừ facebook.com — vẫn double-check)
  if (/https?:\/\/(?!www\.facebook\.com|facebook\.com)/i.test(reply)) {
    reasons.push("URL leak in text");
  }

  // 3. Markdown leak — cleanReply đã strip nhưng vẫn check
  if (/\*\*[^*]+\*\*/.test(reply)) reasons.push("markdown bold leak");
  if (/\[[^\]]+\]\([^)]+\)/.test(reply)) reasons.push("markdown link leak");

  // 4. Internal pricing shorthand chưa expand
  if (/\d+\s*m\s*=\s*\d+\s*tr\b/i.test(reply)) {
    reasons.push("pricing shorthand 'Xm=Ytr' leak");
  }
  if (/\d+\s*b\/t\b/i.test(reply)) {
    reasons.push("schedule shorthand 'Xb/t' leak");
  }

  // 5. Multiple question marks — rule "MAX 1 câu hỏi/reply"
  const questionCount = (reply.match(/\?/g) || []).length;
  if (questionCount > 1) {
    reasons.push(`multiple question marks (${questionCount})`);
  }

  // 6. "nha?" / "nhé?" — văn phong gượng ép
  if (/\s+nha\s*\?/i.test(reply) || /\s+nhé\s*\?/i.test(reply)) {
    reasons.push("question ends with 'nha?'/'nhé?'");
  }

  // 7. Bot khen đáp án khách
  if (/\b(rất\s+tốt|tốt\s+quá|chuẩn\s+rồi|hợp\s+lý\s+(?:quá|lắm)|tuyệt\s+vời|quá\s+hợp)/i.test(reply)) {
    reasons.push("sycophantic praise leak");
  }

  return { valid: reasons.length === 0, reasons };
}

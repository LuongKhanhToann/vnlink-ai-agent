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
import { detectServiceByKeyword, detectHonorific } from "./stateMachine";

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Safe fallback reply khi LLM output không validate được.
 * Mềm + invite mà KHÔNG cam kết → bot không drift / im lặng.
 *
 * `message` (tin khách lượt này) là LỚP PHÒNG THỦ CUỐI: nếu state bị lỗi load
 * (vd storage hiccup → DEFAULT_STATE) thì vẫn quét keyword bộ môn + honorific TRỰC TIẾP
 * từ tin khách → KHÔNG bao giờ hỏi lại "bộ môn nào" khi khách đã ghi rõ "gym".
 */
export function safeFallback(state: ConversationState, message?: string): string {
  // serviceType: ưu tiên state, fallback keyword từ tin khách.
  const serviceType =
    state.knownInfo.serviceType ??
    (message ? detectServiceByKeyword(message) : null);
  // honorific: nếu state default ("anh/chị"), thử suy từ tin khách.
  const rawH =
    state.honorific !== "anh/chị"
      ? state.honorific
      : message
        ? detectHonorific(message, "anh/chị")
        : "anh/chị";
  const h = rawH === "anh/chị" ? "anh/chị" : rawH;
  // Stage-specific fallback — context-aware nhưng vẫn safe
  // Retention (sau chốt): KHÔNG xin lại info — chỉ mời hỏi thêm.
  if (state.stage === "retention") {
    return `Dạ vâng ${h}, còn điều gì em hỗ trợ thêm cho ${h} không ạ.`;
  }
  // ĐÃ CÓ GIỜ CỤ THỂ (preferredTime): bất kể stage → hướng THẲNG về chốt chỗ.
  // KHÔNG hỏi lại giờ, KHÔNG mời InBody/"sáng hay chiều" (đã đặt giờ rồi). Đủ tên+SĐT → xác nhận.
  if (state.knownInfo.preferredTime) {
    if (state.knownInfo.name && state.knownInfo.phone) {
      return `Dạ vâng ${h}, em giữ chỗ ${state.knownInfo.preferredTime} cho mình rồi nha ${h}, hẹn gặp ${h} ạ.`;
    }
    return `Dạ vâng ${h}, ${h} cho em xin tên với SĐT để em giữ chỗ ${state.knownInfo.preferredTime} ạ.`;
  }
  if (state.stage === "commitment") {
    return `Dạ vâng ${h}, ${h} cho em xin thêm thông tin để em hỗ trợ chốt chỗ ạ.`;
  }
  // EMOTION-AWARE (Nhánh 3, 2026-06-08 tối): khách PHÂN VÂN/LO mà LLM reply bị validator reject →
  // fallback robotic "tiện tập sáng hay chiều" càng khiến khách thấy bị ép (bỏ qua cảm xúc). Trấn an
  // + mời thử KHÔNG cam kết thay vì hỏi lịch. Chạy SAU guard preferredTime/retention/commitment (đã
  // chốt → ưu tiên hướng chốt). Áp cho discovery/inbody/evaluation/negotiation.
  if (state.emotion === "hesitant" || state.emotion === "anxious") {
    return `Dạ ${h} cứ yên tâm ạ, người mới bên em đều có HLV kèm từ đầu và điều chỉnh theo sức. ${h} ghé thử 1 buổi xem có hợp không rồi quyết cũng được ạ.`;
  }
  if (state.stage === "evaluation" || state.stage === "negotiation") {
    return `Dạ vâng ${h}, ${h} tiện ghé buổi sáng hay chiều để em hỗ trợ tư vấn trực tiếp ạ.`;
  }
  // Default: discovery / opening — câu DỨT KHOÁT, KHÔNG mơ hồ "xin thêm chi tiết".
  // Đã biết bộ môn (state HOẶC keyword tin khách) → hỏi lịch; chưa biết → hỏi bộ môn.
  if (serviceType) {
    // FUNNEL TL Fami: khách mục tiêu body-comp (giảm/tăng cân, tăng cơ, giữ dáng) đang discovery →
    // KHÔNG chốt lịch "sáng hay chiều" sớm. Fallback an toàn = đào nỗi đau: chưa có chỉ số cơ thể
    // thì hỏi cao/nặng; có rồi thì hỏi thói quen sinh hoạt. (đọc slot classifier + FSM stage, KHÔNG regex)
    const goal = state.knownInfo.fitnessGoal;
    const isBodyGoal =
      goal === "giam-mo" || goal === "tang-can" || goal === "tang-co" || goal === "giu-dang";
    if (state.stage === "discovery" && isBodyGoal) {
      if (!state.knownInfo.bodyStats) {
        return `Dạ ${h} cho em hỏi chiều cao với cân nặng hiện tại của mình đang khoảng bao nhiêu ạ.`;
      }
      return `Dạ ${h} ơi, sinh hoạt ăn uống ngủ nghỉ hằng ngày của mình đang thế nào ạ.`;
    }
    // ĐÃ biết buổi tập (schedule sáng/chiều/tối) → KHÔNG hỏi lại "sáng hay chiều";
    // mời ghé thử 1 buổi + hỏi ngày để tiến tới chốt chỗ.
    if (state.knownInfo.schedule) {
      return `Dạ vâng ${h}, ${h} ghé thử 1 buổi để em hỗ trợ tư vấn trực tiếp nha, ${h} tiện hôm nào ạ.`;
    }
    return `Dạ vâng ${h}, ${h} tiện tập buổi sáng hay chiều để em tư vấn lịch phù hợp ạ.`;
  }
  return `Dạ vâng ${h}, ${h} đang quan tâm bộ môn nào để em tư vấn giúp ạ.`;
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
  opts?: { allowShort?: boolean },
): ValidationResult {
  const reasons: string[] = [];

  // 1. Length check — quá ngắn = bot không thực sự reply.
  //    allowShort: lượt re-greeting/filler (KH chỉ "ới"/chào trống) → reply ĐÚNG kiểu sale thật
  //    là CỰC NGẮN ("Dạ em đây ạ" ~11 chữ). KHÔNG được reject thành fallback pitch dài.
  //    Vẫn chặn rỗng/1-2 ký tự rác (floor 4).
  const floor = opts?.allowShort ? 4 : 20;
  if (!reply || reply.trim().length < floor) {
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

  // 7. Bot khen — CHỈ chặn sycophancy THẬT (khen đáp án/lựa chọn của KHÁCH, hoặc khen TRỐNG),
  //    KHÔNG chặn claim DỊCH VỤ hợp lệ ("yoga rất tốt cho stress", "phương pháp này phù hợp").
  //    Trước đây fail mọi "rất tốt" → nuke cả câu trả lời tốt thành fallback cụt. Nay phân biệt theo ngữ cảnh.
  const PRAISE =
    "(?:rất\\s+tốt|tốt\\s+quá|tốt\\s+rồi|ổn\\s+lắm|ổn\\s+rồi|chuẩn\\s+rồi|hợp\\s+lý(?:\\s+(?:quá|lắm))?|tuyệt\\s+vời|quá\\s+hợp|lý\\s+tưởng|phù\\s+hợp\\s+lắm)";
  // 7a. Khen GẮN với đáp án/lựa chọn/lịch của khách → sycophancy.
  //     (vd "lựa chọn rất tốt", "4 buổi/tuần tốt quá", "tần suất hợp lý lắm", "khung giờ đó lý tưởng")
  const customerDirectedPraise = new RegExp(
    `(lựa\\s+chọn|quyết\\s+định|mục\\s+tiêu|tần\\s+suất|\\d+\\s*buổi|khung\\s+giờ|giờ\\s+(?:đó|này|đấy)|đáp\\s+án|câu\\s+hỏi)[^.!?]{0,15}(?:là|thì)?\\s*${PRAISE}`,
    "i",
  );
  // 7b. Khen TRỐNG đứng đầu ACK (không gắn dịch vụ nào) → khen khách. (vd "Dạ rất tốt ạ.", "Tốt quá,")
  //     "Dạ yoga rất tốt cho stress ạ" KHÔNG match vì "rất tốt" đứng sau "yoga", không phải đầu clause.
  const barePraiseAck = new RegExp(
    `(?:^|[.!?]\\s*)(?:dạ\\s+|vâng\\s+)?${PRAISE}\\s*(?:ạ|nha|đấy)?\\s*[.!,]`,
    "i",
  );
  if (customerDirectedPraise.test(reply) || barePraiseAck.test(reply)) {
    reasons.push("sycophantic praise leak");
  }

  return { valid: reasons.length === 0, reasons };
}

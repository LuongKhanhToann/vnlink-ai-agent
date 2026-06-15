/**
 * goalConsult.ts
 *
 * NỘI DUNG TƯ VẤN SALE theo MỤC TIÊU (fitness) — funnel 5 bước của TL Fami:
 *   1. Khai thác thông tin & xác định "nỗi đau"  → discovery
 *   2. Cam kết kết quả bằng InBody + cá nhân hóa → inbody / evaluation
 *   3. Hình ảnh thành công                        → media (đã handle ở buildMediaHint)
 *   4. Ưu điểm Fami (không gian, bãi đỗ xe)       → CENTER/objections (đã handle nơi khác)
 *   5. Tạo động lực & chốt hẹn (khan hiếm + rủ bạn) → negotiation / commitment
 *
 * THIẾT KẾ:
 *   - Chỉ trả SLICE theo stage hiện tại → giữ prefix gọn cho model nhỏ (token economy).
 *   - Hint MỀM, advisory: hướng dẫn bot HỎI/NHẤN tự nhiên, KHÔNG ép script.
 *     Defer cho GATE/TACTIC khi mâu thuẫn (vd done-slots, commitment đã đủ info).
 *   - Trả "" khi không có nội dung phù hợp (tránh nhiễu token).
 *
 * Áp dụng cho 3 mục tiêu trọng tâm: giam-mo (giảm cân), tang-can (tăng cân), giu-dang (giữ dáng).
 * Các goal còn lại (tang-co/thu-gian/hoc-boi/suc-khoe) đã có nội dung riêng ở prefixBuilder.
 */

import { ConversationState } from "./stateMachine";

// ─────────────────────────────────────────────
// BƯỚC 1 — KHAI THÁC "NỖI ĐAU" (discovery)
// ─────────────────────────────────────────────
// Mục đích: KHÔNG báo giá ngay; khai thác chiều cao/cân nặng/số kg + vùng tự ti +
// thói quen + lịch sử thất bại để lấy cớ tư vấn sâu. Hỏi TỰ NHIÊN 1 ý/lần.

const DISCOVERY_PAIN: Record<string, string> = {
  "giam-mo":
    "khai thác nỗi đau giảm cân: cao/nặng & số kg muốn giảm, vùng tự ti (bụng/bắp tay/đùi), " +
    "thói quen tạo mỡ, đã thử gì thất bại chưa.",
  "tang-can":
    "khai thác nỗi đau tăng cân: cao/nặng & số kg muốn tăng, vùng tự ti (mỏng/vai lép), " +
    "thói quen (ăn không hấp thụ/bỏ bữa/thức khuya), đã thử gì chưa.",
  "giu-dang":
    "khai thác nhu cầu giữ dáng: muốn săn chắc/gọn vùng nào/duy trì sau giảm, tần suất tập mong muốn.",
};

// ─────────────────────────────────────────────
// BƯỚC 2 — CAM KẾT KẾT QUẢ + CÁ NHÂN HÓA (inbody / evaluation)
// ─────────────────────────────────────────────
// Mục đích: chứng minh bằng SỐ LIỆU InBody (không làm mù quáng), cá nhân hóa lộ trình
// theo việc khách ĐÃ/CHƯA biết tập.

const RESULT_COMMIT: Record<string, string> = {
  "giam-mo":
    "cam kết bằng số liệu: InBody bóc tách mỡ thừa & khối cơ — KHÔNG giảm mù quáng. " +
    "Chưa biết tập → nhấn PT chỉnh form + thực đơn không bỏ bữa. Đã biết tập → nhấn thẻ hội viên tối ưu chi phí + máy hiện đại.",
  "tang-can":
    "cam kết bằng số liệu: InBody đo lượng cơ thiếu + chuyển hóa để nạp dinh dưỡng chuẩn — KHÔNG tăng mù quáng (tránh tích mỡ/nước). " +
    "Chưa biết tập → nhấn PT giáo án tăng cơ + thực đơn 5-6 bữa. Đã biết tập → nhấn thẻ hội viên, InBody chọn nhóm cơ.",
  "giu-dang":
    "cam kết bằng số liệu: InBody theo dõi định kỳ duy trì tỷ lệ cơ-mỡ. Nhấn thẻ Full đổi môn cho đỡ chán.",
};

// ─────────────────────────────────────────────
// BƯỚC 5 — TẠO ĐỘNG LỰC & CHỐT HẸN (negotiation / commitment)
// ─────────────────────────────────────────────
// Mục đích: kích thích hành động ngay — khan hiếm + quà trải nghiệm + rủ bạn đồng hành.
// Áp dụng chung cho cả 3 goal (chỉ khác cách nói nhẹ).

const CLOSE_MOTIVATION =
  "tạo động lực chốt hẹn: mời trải nghiệm MIỄN PHÍ (InBody + 1-2 buổi cùng HLV), " +
  "nhấn nhẹ số suất giới hạn để khách quyết sớm. Có thể gợi rủ bạn/người thân nhận thêm ưu đãi. KHÔNG ép, KHÔNG hạ giá.";

const CONSULT_GOALS = new Set(["giam-mo", "tang-can", "giu-dang"]);

/**
 * Build hint nội dung tư vấn theo mục tiêu, chỉ cho 3 goal trọng tâm.
 * Trả "" nếu không áp dụng (flow khác / goal khác / stage không có slice / đã đủ tên+SĐT).
 */
export function buildGoalConsultHint(state: ConversationState): string {
  const { flow, stage, knownInfo } = state;
  if (flow !== "fitness") return "";
  const goal = knownInfo.fitnessGoal;
  if (!goal || !CONSULT_GOALS.has(goal)) return "";

  // Đã đủ tên + SĐT → đang chốt slot (GATE commitment lo) → không chèn pitch nữa.
  if (knownInfo.name && knownInfo.phone) return "";

  let body = "";
  if (stage === "discovery" || stage === "opening") {
    body = DISCOVERY_PAIN[goal] ?? "";
    if (body) {
      return (
        `[TƯ VẤN MỤC TIÊU: ${body} ` +
        `→ CHƯA báo giá, hỏi TỰ NHIÊN 1 ý/lần (không tra hỏi dồn) để hiểu khách rồi tư vấn sâu.]`
      );
    }
  } else if (stage === "inbody" || stage === "evaluation") {
    body = RESULT_COMMIT[goal] ?? "";
    if (body) return `[TƯ VẤN MỤC TIÊU: ${body}]`;
  } else if (stage === "negotiation" || stage === "commitment") {
    return `[TƯ VẤN MỤC TIÊU: ${CLOSE_MOTIVATION}]`;
  }
  return "";
}

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
import { WEIGHT_STANDARD_HINT } from "./weightStandard";

// Goal đối chiếu bảng cân chuẩn: cả 3 body-goal đều dùng cao/nặng — giảm/tăng để biết lệch
// mấy kg, giữ-dáng để xác nhận đang TRONG khoảng cân đối rồi duy trì. (Khớp với BODY_GOALS ở
// stateMachine: 3 goal này đều bị giữ discovery hỏi cao/nặng trước khi tư vấn.)
const WEIGHT_TABLE_GOALS = new Set(["giam-mo", "tang-can", "giu-dang"]);

// ─────────────────────────────────────────────
// BƯỚC 1 — KHAI THÁC "NỖI ĐAU" (discovery)
// ─────────────────────────────────────────────
// Mục đích: KHÔNG báo giá ngay; khai thác chiều cao/cân nặng/số kg + vùng tự ti +
// thói quen + lịch sử thất bại để lấy cớ tư vấn sâu. Hỏi TỰ NHIÊN 1 ý/lần.

const DISCOVERY_PAIN: Record<string, string> = {
  "giam-mo":
    "khách muốn giảm cân — hỏi GỌN chiều cao + cân nặng hiện tại (gộp 1 câu được). " +
    "KHÔNG hỏi 'vùng nào tự ti/ngại nhất' hay 'đã thử cách giảm nào chưa' — khách thường không trả lời được, hỏi dồn làm rớt khách. Có cao/nặng là tư vấn được rồi.",
  "tang-can":
    "khách muốn tăng cân — hỏi GỌN chiều cao + cân nặng hiện tại (gộp 1 câu được). " +
    "KHÔNG tra hỏi 'ăn uống/thói quen thế nào' dồn dập — có chỉ số là tư vấn được.",
  "giu-dang":
    "khách muốn giữ dáng — hỏi nhẹ chiều cao/cân nặng hiện tại để biết khách đang ở đâu so với chuẩn (1 câu).",
};

// ─────────────────────────────────────────────
// BƯỚC 2 — CAM KẾT KẾT QUẢ + CÁ NHÂN HÓA (inbody / evaluation)
// ─────────────────────────────────────────────
// Mục đích: chứng minh bằng SỐ LIỆU InBody (không làm mù quáng), cá nhân hóa lộ trình
// theo việc khách ĐÃ/CHƯA biết tập.

const RESULT_COMMIT: Record<string, string> = {
  "giam-mo":
    "Có cao/nặng → ĐỐI CHIẾU BẢNG CÂN CHUẨN ở prefix (theo chiều cao + giới) đưa mốc cân đối + lệch mấy kg ngay, ĐỪNG hỏi 'muốn giảm bao nhiêu' (khách không tự biết, mình tư vấn). " +
    "Khách CHƯA cho số → đừng nài, tư vấn chung rồi mời qua đo InBody cho chính xác. " +
    "Tự ĐỀ XUẤT môn (giảm cân → Gym+Zumba đốt mỡ), KHÔNG hỏi 'muốn tập môn nào'. " +
    "Nhấn InBody bóc tách mỡ thừa/khối cơ (giảm có số liệu, không mù quáng) + mời trải nghiệm thực tế. " +
    "MỖI lượt 1 ý chính rồi nhường khách — ĐỪNG dồn mốc cân + InBody + môn + trial vào 1 tin. Gói/giá chỉ nói khi khách hỏi: chưa biết tập → PT chỉnh form + thực đơn; đã biết tập → thẻ hội viên tối ưu chi phí.",
  "tang-can":
    "Có cao/nặng → ĐỐI CHIẾU BẢNG CÂN CHUẨN ở prefix (theo chiều cao + giới) chỉ ra đang thiếu tầm mấy kg để cân đối, ĐỪNG hỏi 'muốn tăng bao nhiêu'. " +
    "Khách CHƯA cho số → đừng nài, tư vấn chung rồi mời qua đo InBody. " +
    "Tự ĐỀ XUẤT hướng (người gầy → Gym tập tạ tăng cơ), KHÔNG hỏi 'muốn tập môn nào'. " +
    "Nhấn InBody đo lượng cơ thiếu + chuyển hóa để nạp dinh dưỡng chuẩn — tăng cơ KHÔNG tích mỡ/nước. " +
    "MỖI lượt 1 ý chính rồi nhường khách. Gói/giá chỉ nói khi khách hỏi: chưa biết tập → PT giáo án tăng cơ + thực đơn 5-6 bữa; đã biết tập → thẻ hội viên, InBody chọn nhóm cơ.",
  "giu-dang":
    "Có cao/nặng → đối chiếu BẢNG CÂN CHUẨN ở prefix: đang TRONG khoảng cân đối thì ghi nhận nhẹ + hướng DUY TRÌ; lệch nhẹ thì gợi tinh chỉnh chút. " +
    "InBody theo dõi định kỳ giữ tỷ lệ cơ-mỡ. Nhấn thẻ Full đổi môn cho đỡ chán. " +
    "Mỗi lượt 1 ý, gói/giá chỉ nói khi khách hỏi.",
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

  // Bơm bảng cân chuẩn khi đã có chiều cao/cân nặng (giảm/tăng cân) → bot tra mốc + lệch mấy kg,
  // không hỏi "muốn giảm/tăng bao nhiêu". Chưa có bodyStats thì khỏi bơm (chưa có gì để tra).
  const tableHint =
    WEIGHT_TABLE_GOALS.has(goal) && knownInfo.bodyStats !== null
      ? "\n" + WEIGHT_STANDARD_HINT
      : "";

  let body = "";
  if (stage === "discovery" || stage === "opening") {
    body = DISCOVERY_PAIN[goal] ?? "";
    if (body) {
      return (
        `[TƯ VẤN MỤC TIÊU: ${body} ` +
        `→ CHƯA báo giá; hỏi GỌN 1 câu rồi tư vấn theo chuẩn, KHÔNG hỏi dồn nhiều câu thăm dò.]` +
        tableHint
      );
    }
  } else if (stage === "inbody" || stage === "evaluation") {
    body = RESULT_COMMIT[goal] ?? "";
    if (body) return `[TƯ VẤN MỤC TIÊU: ${body}]` + tableHint;
  } else if (stage === "negotiation" || stage === "commitment") {
    return `[TƯ VẤN MỤC TIÊU: ${CLOSE_MOTIVATION}]`;
  }
  return "";
}

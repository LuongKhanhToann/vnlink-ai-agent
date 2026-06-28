/**
 * playbook.ts
 *
 * SALE PLAYBOOK — fitness & giải cơ.
 * Key = `${flow}_${stage}_${emotion}` (flow-aware)
 * Fallback = `${stage}_${emotion}` → `${stage}_neutral`
 *
 * Design: chỉ giữ ${stage}_neutral + 1-2 exception cảm xúc thật khác biệt.
 * Bot temperature 0.85 + ACK pool ở agent prompt đã tạo variation tự nhiên —
 * không cần 6 variant cảm xúc per stage (gây noise + bloat token).
 */

import { Stage, Emotion, Flow } from "./stateMachine";

// ─────────────────────────────────────────────
// FITNESS PLAYBOOK
// ─────────────────────────────────────────────

const FITNESS_PLAYBOOK: Record<string, string> = {

  opening_neutral:
    "Chào ngắn, lễ phép. Hỏi ngay dịch vụ quan tâm HOẶC mục tiêu. Không lên giọng bán hàng.",

  // SPIN-lite: Situation (đang tập gì) → Problem (khó khăn) → Need-Payoff (cảm giác khi đạt được mục tiêu).
  // KH self-justify mua hàng khi tự nói payoff.
  discovery_neutral:
    "Đã biết serviceType + fitnessGoal → xác nhận ngắn, KHÔNG list lại 4 dịch vụ. " +
    "Hỏi 1 câu context theo thứ tự ưu tiên: schedule → số buổi → memberType. " +
    "Có thể xen 1 câu SPIN-lite tăng kết nối (chọn 1, không cả 2): " +
    "(Problem) 'Trước đây [anh/chị] đã thử gì cho mục tiêu này chưa ạ' / " +
    "(Need-Payoff) 'Nếu đạt được [goal] thì [anh/chị] thấy thế nào ạ'. " +
    "KH hỏi LỊCH lớp → trả lịch sơ bộ (4 ca/ngày, mở 5h–20h) + mời ghé xem trực tiếp, KHÔNG bung giá. " +
    "Không báo giá, không show gói, không 'nha?'.",

  inbody_neutral:
    "Pitch InBody ngắn ('máy đọc tỷ lệ mỡ/cơ thật, HLV gợi gói chuẩn không thừa'). Mời ghé sáng/chiều. KHÔNG show gói/giá.",

  evaluation_neutral:
    "LOCK giải pháp theo mục tiêu KH — KHÔNG drift giữa các tổ hợp dịch vụ giữa cuộc thoại. " +
    "Cấu trúc: (1) 1 câu value cụ thể theo mục tiêu (giảm-mỡ → cardio+tạ; tăng-cơ → PT 1-1; thư-giãn → Yoga GV Ấn Độ; học-bơi → bể 4 mùa cam kết biết bơi) " +
    "→ (2) tối đa 3 gói anchor cao→vừa→nhẹ, MỖI gói có giá thật → (3) kết bằng câu hỏi giờ/lịch. " +
    "KH hỏi lại cùng mục tiêu → đào sâu 1 gói cụ thể, KHÔNG repeat combo.",

  negotiation_neutral:
    "Reframe value 3 mũi: cơ sở (gym 700m2, bể 4 mùa duy nhất), GV/HLV (Yoga & Zumba GV Ấn Độ, InBody miễn phí), social proof (hội viên gắn bó 2-3 năm). " +
    "Mời thử 1 buổi miễn phí. KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG giảm giá. " +
    "Tháng lẻ: 'tháng lẻ 1.2tr, gói năm 7tr còn bảo lưu khi bận'.",

  commitment_neutral:
    "TÁCH ngày khỏi tên/SĐT, đừng dồn dập 1 câu hỏi cả 3 thứ. " +
    "Chốt NGÀY trước: khách chưa nói ngày → hỏi mở 'mình tiện qua hôm nào ạ'; khách nói mơ hồ ('đầu tuần sau') → cho chọn 1-trong-2 ngày cụ thể. " +
    "Khi đã có ngày cụ thể → MỚI xin tên + SĐT (gộp tên+SĐT trong 1 câu được). Đủ tên+SĐT+ngày → xác nhận 1 câu rồi DỪNG. Không gợi cọc/QR nếu KH chưa hỏi.",

  objection_neutral:
    "Ghi nhận điểm khách băn khoăn (Feel-Felt-Found ngắn). Reframe theo GIÁ TRỊ trước (cơ sở 700m2 + bể 4 mùa duy nhất, GV Ấn Độ + InBody miễn phí, hội viên gắn bó 2-3 năm) + mời thử 1 buổi miễn phí. " +
    "KHÔNG hạ giá. Chỉ giới thiệu gói nhẹ hơn như 1 LỰA CHỌN sau khi đã neo giá trị, đóng khung 'tiết kiệm hơn' chứ không phải để né giá.",
  // Nghịch đảo tactic — chỉ áp dụng khi KH thực sự hesitant
  objection_hesitant:
    "Nghịch đảo: ngừng push, 'Thôi để anh/chị nghĩ thêm, em chỉ muốn biết thêm 1 điều...' Tạo tò mò. Phải trung thực khi dùng.",

  recovery_neutral:
    "Lắng nghe. Thừa nhận. Cam kết giải quyết cụ thể có timeline.",

  retention_neutral:
    "SAU CHỐT (concierge): đơn đã đặt xong, chỗ đã giữ. Trả lời answer-first câu khách hỏi, ấm áp như khách quen — " +
    "KHÔNG xin lại tên/SĐT/giờ, KHÔNG lặp 'giữ chỗ... DỪNG', KHÔNG pitch lại gói đã chốt. " +
    "Upsell NHẸ chỉ khi khách lộ tín hiệu (hỏi môn khác/giá/rảnh thêm) — gợi 1 ý liên quan, không chèo kéo. " +
    "Khách muốn đặt thêm (môn/buổi/người khác) → vui vẻ hỏi gọn info còn thiếu cho đơn mới.",
};

// ─────────────────────────────────────────────
// GIẢI CƠ PLAYBOOK
// ─────────────────────────────────────────────

const GIAI_CO_PLAYBOOK: Record<string, string> = {

  opening_neutral:
    "Chào ngắn, hỏi ngay vùng khó chịu nhất. Không báo giá khi chưa biết painArea.",

  discovery_neutral:
    "Hỏi tuần tự, 1 câu/lần: painArea → painSpread → painDuration → pastMethod. " +
    "Giọng trò chuyện, không tra hỏi. Không báo giá khi chưa có pastMethod.",

  evaluation_neutral:
    "Flow: hình dung vấn đề → contrast với cách cũ (massage bề mặt vs giải cơ chuyên sâu) → vẽ viễn cảnh dễ chịu → mời thử 1 buổi. " +
    "KHÔNG show bảng 3 gói lần đầu. Hỏi giữ chỗ 1 lần trong cuộc thoại.",

  negotiation_neutral:
    "Chia nhỏ giá/buổi: '10 buổi ~380k/buổi, tặng 1 buổi'. Reframe: 'massage bề mặt 2 ngày lại đau vì chưa gỡ sâu'. KHÔNG giảm giá.",

  commitment_neutral:
    "TÁCH ngày khỏi tên/SĐT, đừng dồn dập 1 câu hỏi cả 3 thứ. " +
    "Chốt NGÀY trước: khách chưa nói ngày → hỏi mở 'mình tiện qua hôm nào ạ'; khách nói mơ hồ ('đầu tuần sau') → cho chọn 1-trong-2 ngày cụ thể. " +
    "Khi đã có ngày cụ thể → MỚI xin tên + SĐT (gộp 1 câu được). Đủ tên+SĐT+ngày → xác nhận rồi DỪNG. Không lặp 'KTV đánh giá thực tế'.",

  objection_neutral:
    "Xác nhận: 'Câu này nhiều người hỏi — để em giải thích'. Trả lời theo script objection. KHÔNG ép mua.",
  objection_hesitant:
    "KHÔNG push. Hỏi 'Anh/chị đang phân vân điểm gì — em giải thích thêm nha'.",

  recovery_neutral:
    "Lắng nghe. Thừa nhận. Cam kết cụ thể có timeline. Không push.",

  retention_neutral:
    "SAU CHỐT (concierge): lịch đã đặt xong. Trả lời answer-first, ấm áp, hỏi cảm giác/dặn dò nếu hợp ngữ cảnh — " +
    "KHÔNG xin lại tên/SĐT/giờ, KHÔNG lặp 'giữ chỗ... DỪNG'. Gợi lộ trình/buổi tiếp CHỈ khi khách quan tâm. " +
    "Khách muốn đặt thêm buổi/người khác → vui vẻ hỏi gọn info còn thiếu.",
};

// ─────────────────────────────────────────────
// LOOKUP
// ─────────────────────────────────────────────

export function getTactic(flow: Flow, stage: Stage, emotion: Emotion): string {
  const map = flow === "fitness" ? FITNESS_PLAYBOOK : GIAI_CO_PLAYBOOK;
  return (
    map[`${stage}_${emotion}`] ??
    map[`${stage}_neutral`] ??
    ""
  );
}

/**
 * prefixBuilder.ts
 *
 * Build prefix inject vào agent message.
 * Tất cả giá trị đến từ deterministic state.
 *
 * NGUYÊN TẮC:
 *   - Fitness discovery: giữ ở discovery cho đến khi có fitnessGoal (hoặc intent >= compare)
 *   - Evaluation: few-shot luôn build value TRƯỚC khi show giá
 *   - Xưng hô: lấy từ state.honorific, đã được detectHonorific cập nhật đúng turn
 */

import {
  ConversationState,
  resolveHonorific,
  KnownInfo,
  Intent,
  Flow,
  Stage,
} from "./stateMachine";
import { getTactic } from "./playbook";
import { buildDateContext } from "./dateHelper";
import { decideFitnessQuestion, formatDecision } from "./questionFlow";

// ─────────────────────────────────────────────
// DIGRESSION CLASSIFIER
// ─────────────────────────────────────────────

function canAnswerWithoutCoreSlot(
  intent: Intent,
  _flow: Flow,
  stage: Stage,
): boolean {
  if (intent === "compare") return true;
  if (stage === "opening") return true;
  return false;
}

// ─────────────────────────────────────────────
// MESSAGE SIGNAL DETECTORS
// ─────────────────────────────────────────────

/**
 * Khách chủ động hỏi cọc / thanh toán trước / QR.
 */
export function detectDepositAsk(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /\bcọc\b|đặt\s?cọc/.test(m) ||
    /thanh\s?toán\s?trước|trả\s?trước/.test(m) ||
    /chuyển\s?(khoản|tiền)/.test(m) ||
    /\bqr\b|mã\s?qr/.test(m) ||
    /số\s?tài\s?khoản|\bstk\b|số\s?tk/.test(m)
  );
}

/**
 * Khách lạnh: muốn tham khảo thêm, chưa quyết, để sau.
 */
export function detectColdLead(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /thôi\s+(để|tham\s?khảo|xem)|tham\s?khảo\s+thêm|cho\s+(em|anh|chị)\s+nghĩ/.test(m) ||
    /chưa\s+(quyết|cần|gấp|liền)|không\s+(cần\s+gấp|gấp)/.test(m) ||
    /(lúc|khi|hôm)\s+khác|sau\s+(hẵng|nha)|để\s+(mai|sau)/.test(m)
  );
}

/**
 * Khách phản đối giá / xin giảm.
 */
export function detectPriceObjection(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(đắt|cao|mắc|hơi\s+đắt)\s*(quá|lắm|nhỉ)?/.test(m) ||
    /giảm\s*giá|có\s+giảm|bớt|khuyến\s*mãi|\bkm\b|\bsale\b|\bưu\s*đãi\b/.test(m) ||
    /(shop|chỗ|bên)\s+(kia|khác)\s+(rẻ|tốt|hơn)/.test(m)
  );
}

/**
 * Khách xin xem ảnh/video — phải gọi get-media ngay.
 * Regex chấp nhận pronoun ở giữa: "cho chị xem", "cho em coi"...
 */
export function detectMediaRequest(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // 1) "cho [pronoun] xem|coi" + (sau đó) hình/ảnh/video/bể bơi/phòng tập
  if (
    /cho\s+(em|anh|chị|mình|tôi|bạn|chú|cô|bác)?\s*(xem|coi|gửi).{0,30}(hình|ảnh|video|clip|bể\s?bơi|phòng\s?tập|view)/i.test(
      m,
    )
  )
    return true;
  // 2) "xem ảnh/hình/video" trực tiếp
  if (/(xem|coi|gửi)\s+(thử|được)?\s*(hình|ảnh|video|clip)/i.test(m)) return true;
  // 3) "có hình/ảnh/video không"
  if (/có\s+(hình|ảnh|video|clip)\s+(nào|gì|không)/i.test(m)) return true;
  return false;
}

/**
 * Khách hỏi giá rõ ràng (không cần phải chốt mục tiêu trước).
 */
export function detectPriceQuestion(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // "chương trình ưu đãi" / "chương trình khuyến mãi" → match qua "ưu đãi"/"khuyến mãi".
  // KHÔNG match "chương trình tập luyện" (KH hỏi tư vấn, không hỏi giá).
  return /(giá|bao\s+nhiêu|mấy\s+(tiền|đồng)|giá\s+thẻ|tiền\s+gói|chi\s+phí|báo\s+giá|học\s+phí|phí\s+(tập|gói|đăng\s+ký)|ưu\s*đãi|khuyến\s*mãi)/.test(m);
}

/**
 * Khách là sinh viên / học sinh.
 */
export function detectStudent(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return /(sinh\s*viên|\bsv\b|học\s*sinh|\bhs\b|đang\s+học|đi\s+học)/.test(m);
}

/**
 * Khách đăng ký theo nhóm/gia đình.
 */
export function detectFamily(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return /(vợ\s*chồng|gia\s*đình|cả\s*nhà|2\s*người|3\s*người|cùng\s*con|với\s+(vợ|chồng|con))/.test(m);
}

/**
 * Khách hỏi về GIỜ MỞ CỬA / lúc nào trung tâm hoạt động.
 * Khác với "tiện sáng hay chiều" (đó là khách CHỌN slot, không hỏi).
 */
export function detectHoursQuestion(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase().trim();
  return (
    /(qua|đến|tới|ghé|sang|đi)\s+(được\s+)?(lúc\s+nào|khi\s+nào|giờ\s+nào|mấy\s+giờ)/.test(m) ||
    /(mở\s*cửa|đóng\s*cửa|giờ\s+(mở|đóng|hoạt\s*động|làm\s*việc))/.test(m) ||
    /(từ\s+mấy\s+giờ|đến\s+mấy\s+giờ|tới\s+mấy\s+giờ)/.test(m) ||
    /^(lúc\s+nào|khi\s+nào|mấy\s+giờ)\s*(được|cũng|là\s+được)?[?\s]*$/.test(m) ||
    /\b(giờ\s+giấc|giờ\s+làm)\b/.test(m)
  );
}

/**
 * Khách hỏi LỊCH LỚP cụ thể (lịch học bơi, lịch yoga, lịch các bộ môn) —
 * KHÔNG được trả bằng bảng giá. Phải trả lịch sơ bộ + mời ghé xem trực tiếp.
 */
export function detectClassScheduleQuestion(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // "lịch (học/lớp/tập) ..." hoặc "ca/buổi/khung giờ của lớp ..."
  if (/lịch\s+(học|lớp|tập|của|các)/.test(m)) return true;
  if (/(lớp|ca|buổi|khung\s*giờ)\s+(học|của|cho|nào)/.test(m) && /(yoga|zumba|bơi|pilates|gym|bộ\s*môn|dịch\s*vụ)/.test(m)) return true;
  if (/(yoga|zumba|bơi|pilates)\s+.*?(lịch|ca\s*nào|giờ\s*nào|mấy\s*ca)/.test(m)) return true;
  // "lịch các bộ môn", "lịch hoạt động lớp"
  if (/lịch\s+(các\s+)?(bộ\s*môn|môn|lớp|hoạt\s+động)/.test(m)) return true;
  return false;
}

/**
 * Khách hỏi câu hỏi FACTUAL về cơ sở vật chất / dịch vụ — bot phải answer cụ thể TRƯỚC.
 * Vd: "bể bơi rộng không", "phòng gym có máy gì", "có chỗ gửi xe không", "GV nước nào".
 * Trả về { topic, fact } — topic dùng để lookup answer; fact = câu trả lời ready-to-use.
 */
export function detectFacilityQuestion(
  message: string,
  flow: Flow,
): { topic: string; fact: string } | null {
  if (!message || flow !== "fitness") return null;
  const m = message.toLowerCase();

  // Bể bơi
  if (/(bể\s*bơi|bể|hồ\s*bơi|pool|nước|lọc)/.test(m)) {
    // Giờ mở bể — ưu tiên cao, check trước "ấm/lạnh"
    if (/(mở|đóng|giờ|mấy\s*giờ|từ\s*mấy)/.test(m) && !/(ấm|nóng|lạnh|sạch|clo|ozone|vệ\s*sinh|sâu)/.test(m))
      return { topic: "pool-hours", fact: "Bể bơi bên em mở từ 6h sáng đến 20h hàng ngày, là bể 4 mùa duy nhất Vĩnh Yên" };
    if (/(rộng|to|lớn|diện\s*tích|m2|mét\s*vuông|bao\s*nhiêu\s*m|kích\s*thước)/.test(m))
      return { topic: "pool-size", fact: "Bể bơi bên em rộng 350m2, là bể 4 mùa DUY NHẤT ở Vĩnh Yên" };
    // Clo — fact theo TL Fami: CÓ dùng Clo ở mức tiêu chuẩn để khử khuẩn
    if (/\bclo\b|chlo/.test(m))
      return { topic: "pool-chlorine", fact: "Bên em có sử dụng Clo ở mức tiêu chuẩn để khử khuẩn, đảm bảo nước sạch an toàn. Bộ phận kỹ thuật đo chỉ số hàng ngày" };
    // Thay nước
    if (/(thay\s*nước|đổi\s*nước|nước\s*sạch\s*không)/.test(m))
      return { topic: "pool-water-change", fact: "Bên em có bộ phận xử lý nước đúng tiêu chuẩn và thay nước định kỳ để đảm bảo chất lượng" };
    if (/(nóng|lạnh|nhiệt\s*độ|bốn\s*mùa|4\s*mùa|ấm|trong\s*nhà|ngoài\s*trời|mái\s*che)/.test(m))
      return { topic: "pool-quality", fact: "Bể bơi 4 mùa có mái che (trong nhà), nước ấm quanh năm, bơi quanh năm duy trì sức khoẻ được" };
    if (/(sạch|lọc|ozone|vệ\s*sinh)/.test(m) && !/clo/.test(m))
      return { topic: "pool-clean", fact: "Bể bơi 4 mùa, có hệ thống lọc tiêu chuẩn, đội cứu hộ riêng, bộ phận kỹ thuật đo chỉ số hàng ngày" };
    if (/(sâu|độ\s*sâu)/.test(m))
      return { topic: "pool-depth", fact: "Bể có khu nông cho người mới và khu sâu hơn cho bơi tự do" };
    // Đồ bơi
    if (/(đồ\s*bơi|quần\s*áo\s*bơi|bikini)/.test(m))
      return { topic: "pool-swimwear", fact: "Bên em khuyến khích mặc đồ bơi để bảo vệ mình và những người bơi cùng, không bị bụi vải/sợi vải vào nước" };
    // Giờ vắng/đông
    if (/(vắng|đông|cao\s*điểm|ít\s*người|đông\s*người)/.test(m))
      return { topic: "pool-traffic", fact: "Khung giờ đỡ đông: 6-8h, 10-12h, 19-20h" };
    // Giới hạn lượt
    if (/(giới\s*hạn|lượt|số\s*lần|bơi\s*mấy\s*lượt)/.test(m))
      return { topic: "pool-limit", fact: "Không giới hạn tần suất, khuyến khích 1 lượt/ngày tối đa 60 phút để không mất sức/nhiễm lạnh" };
    // Cứu hộ
    if (/(cứu\s*hộ|thầy\s*kèm|huấn\s*luyện|trông\s*coi|giám\s*sát)/.test(m))
      return { topic: "pool-lifeguard", fact: "Bể bơi có 100% cứu hộ trên bờ để quan sát các bạn và xử lý tình huống phát sinh" };
  }

  // Phòng gym
  if (/(phòng\s*gym|phòng\s*tập|máy\s*tập|máy\s*chạy|tạ|cardio|trang\s*thiết\s*bị|thiết\s*bị)/.test(m)) {
    if (/(rộng|to|lớn|diện\s*tích|bao\s*nhiêu\s*m|kích\s*thước|chứa)/.test(m))
      return { topic: "gym-size", fact: "Phòng gym 700m2 trong nhà + 300m2 sân ngoài có mái che, sức chứa 100 người cùng lúc" };
    if (/(máy|thiết\s*bị|loại|gì|chuẩn|quốc\s*tế)/.test(m))
      return { topic: "gym-equipment", fact: "Phòng gym đầy đủ máy chuẩn quốc tế: máy chạy, xe đạp tập, máy tạ, cardio đa dạng" };
  }

  // GV / HLV — bao quát "ai dạy", "ai hướng dẫn"
  if (/(gv|giáo\s*viên|huấn\s*luyện|hlv|trainer|người\s*dạy|ai\s+(dạy|hướng\s*dẫn|đứng\s*lớp))/.test(m)) {
    if (/(yoga|zumba)/.test(m) || /(ấn\s*độ|nước\s*ngoài|quốc\s*tế)/.test(m))
      return { topic: "yoga-zumba-gv", fact: "Yoga và Zumba bên em do GV người Ấn Độ chuyên nghiệp dạy, 4 ca/ngày linh hoạt lịch tập" };
    if (/(gym|pt|cá\s*nhân|1[-\s]?1)/.test(m))
      return { topic: "gym-pt", fact: "HLV phòng gym kinh nghiệm nhiều năm, đo InBody miễn phí lần đầu rồi thiết kế lộ trình theo cơ thể" };
  }

  // Pilates
  if (/pilates/.test(m)) {
    if (/(máy|thiết\s*bị|chuẩn|quốc\s*tế|loại)/.test(m))
      return { topic: "pilates-equipment", fact: "Phòng Pilates có 13 máy chuẩn quốc tế, mới nhập từ 12/2024, GV chứng chỉ quốc tế" };
  }

  // Tiện ích chung: gửi xe, lock, wifi, vệ sinh
  if (/(gửi\s*xe|chỗ\s*xe|bãi\s*xe|đỗ\s*xe|parking)/.test(m))
    return { topic: "parking", fact: "Bên em có chỗ gửi xe rộng, ghé tập không lo" };
  if (/(tủ\s*đồ|locker|lock|tủ\s*khóa|cất\s*đồ)/.test(m))
    return { topic: "locker", fact: "Có tủ đồ riêng cho hội viên cất đồ an toàn" };
  if (/(wifi|wi-?fi|internet)/.test(m))
    return { topic: "wifi", fact: "Có wifi miễn phí trong toàn trung tâm" };
  if (/(tắm|nước\s*tắm|phòng\s*tắm|vệ\s*sinh\s*tắm|bath|shower)/.test(m))
    return { topic: "shower", fact: "Có phòng tắm nước nóng riêng nam/nữ sạch sẽ" };

  // Số năm hoạt động / quy mô
  if (/(thành\s*lập|bao\s*nhiêu\s*năm|hoạt\s*động|mở\s*từ|từ\s*năm|uy\s*tín|lâu\s*chưa)/.test(m))
    return { topic: "history", fact: "Fami hoạt động từ 2014, hơn 10 năm tại Vĩnh Yên" };

  return null;
}

/**
 * Khách hỏi về chính sách bảo lưu / hủy / hoãn / vắng.
 */
export function detectHoldPolicy(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return /(bảo\s*lưu|hủy|huỷ|hoãn|nghỉ\s+(tập|gói)|vắng|đi\s*công\s*tác|đi\s*xa|chuyển\s+nhượng)/.test(
    m,
  );
}

/**
 * Khách cần PT 1-1 / mới tập / sợ sai tư thế.
 */
export function detectPTNeed(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(hlv\s*riêng|hlv\s*cá\s*nhân|hlv\s*1[-\s]?1|pt\s*riêng|tập\s*riêng|1\s*kèm\s*1|kèm\s*riêng)/.test(
      m,
    ) ||
    /(mới\s*tập|sợ\s*sai\s*tư\s*thế|chưa\s*biết\s*tập|sợ\s*chấn\s*thương|sợ\s*tập\s*sai)/.test(
      m,
    )
  );
}

/**
 * Khách so sánh 2 dịch vụ ("gym với yoga", "gym hay yoga", "cái nào tốt hơn")
 * → bot phải recommend dứt khoát 1 môn, không neutral.
 */
export function detectComparison(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const services = "(gym|yoga|zumba|bơi|pilates|cardio|aerobic)";
  return (
    new RegExp(`${services}\\s+(với|hay|và|hoặc|so\\s+với)\\s+${services}`, "i").test(m) ||
    /(cái\s+nào|nên\s+chọn|chọn\s+gì\s+(thì\s+)?tốt|môn\s+nào|tập\s+gì\s+(thì\s+)?tốt)/.test(m)
  );
}

/**
 * Khách indecisive — không tự quyết, nhờ bot chọn ("chọn giúp", "tư vấn cho",
 * "chưa biết tập gì"). Bot phải recommend dứt khoát theo goal/context.
 */
export function detectIndecisive(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(chọn\s+giúp|tư\s+vấn\s+(cho\s+|giúp\s+))/.test(m) ||
    /(chưa\s+biết|không\s+biết)\s*(tập\s+(gì|môn\s+nào)|môn\s+nào|nên)/.test(m) ||
    /(em|mình|chị|anh)?\s*chọn\s+(hộ|giúp|cho)/.test(m)
  );
}

/**
 * Khách answer câu hỏi cụ thể (số/thời gian/lựa chọn) — bot phải ACK trước.
 * Pattern: số kèm "tuần"/"buổi"/"ngày", hoặc "sáng/chiều/tối" đơn lẻ, hoặc "ok/được/đồng ý".
 */
export function detectShortAnswer(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase().trim();
  if (m.length > 80) return false; // tin dài thì không phải short answer
  return (
    /^\d+\s*(tuần|tháng|buổi|ngày)/.test(m) ||
    /\d+\s*buổi\s*(\/|một|mỗi)\s*tuần/.test(m) ||
    /(thường\s+vắng|hay\s+vắng).{0,15}\d+/.test(m) ||
    /^(sáng|chiều|tối|trưa)\s*(được|nhé|nha|ạ|đi)?$/.test(m) ||
    /^(ok|đồng ý|ừ|được|chốt|nhận|chị\s+(đồng\s+ý|chốt))/.test(m)
  );
}

/**
 * Khách bị chấn thương cấp tính / vừa bị (< 72h) — bot KHÔNG mời ngay,
 * phải khuyên nghỉ 3-5 ngày trước.
 */
export function detectAcuteInjury(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(hôm\s*qua|hôm\s*nay|sáng\s*nay|chiều\s*nay|tối\s*nay|vừa\s*bị|mới\s*bị)/.test(m) &&
      /(đau|chấn|trẹo|sai\s*tư\s*thế|té|ngã)/.test(m)
    ||
    /(không\s*(cử\s*động|nhúc\s*nhích)\s*(nổi|được)?|sưng|nóng\s*đỏ|sưng\s*nóng)/.test(m)
  );
}

/**
 * Khách hỏi general "tư vấn chương trình tập luyện" / "có chương trình gì" —
 * khác với detectPriceQuestion ("chương trình ưu đãi"). Reply phải list 4 dịch vụ.
 */
export function detectChuongTrinhConsult(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (/ưu\s*đãi|khuyến\s*mãi/.test(m)) return false; // đẩy sang detectPriceQuestion
  return (
    /(tư\s*vấn|tham\s*khảo).{0,20}(chương\s*trình|gói|dịch\s*vụ|bộ\s*môn|tập\s*luyện)/.test(m) ||
    /(chương\s*trình|gói\s+tập)\s+(tập|tập\s*luyện|nào|gì)/.test(m) ||
    /có\s+(những\s+)?(chương\s*trình|gói|dịch\s*vụ|bộ\s*môn)\s+(gì|nào)/.test(m)
  );
}

/**
 * Khách hỏi tập thử / trải nghiệm thử / thử 1 buổi.
 * Reply phải xác nhận có hỗ trợ tập thử 1 buổi.
 * Lưu ý: không match nếu message có cả "gói giá" (khi đó là price ask, không phải trial ask).
 */
export function detectTrialAsk(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  if (/gói\s+giá|những\s+gói|các\s+gói\s+nào|gói\s+nào/.test(m)) return false;
  return (
    /(tập\s*thử|tập\s*được\s*thử|trải\s*nghiệm\s*thử|thử\s+(1|một)\s+buổi|thử\s+xem|cho.{0,5}thử|được\s+thử|tập\s+trải\s+nghiệm|muốn\s+trải\s+nghiệm|đăng\s*ký\s+trải\s+nghiệm|đk\s+trải\s+nghiệm)/.test(m)
  );
}

/**
 * Khách explicit hỏi list gói giá ("có những gói giá nào", "có các gói gì", "gói nào em").
 * Khác detectPriceQuestion (broader: cả "bao nhiêu tiền"). Match this để force list giá.
 */
export function detectExplicitPriceList(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(có\s+(những|các)\s+gói|gói\s+giá\s+nào|những\s+gói\s+nào|các\s+gói\s+(nào|gì)|gói\s+nào\s+(thế|em|ạ))/.test(m)
  );
}

/**
 * Khách xác nhận chọn gói Full / đăng ký gói Full ("đăng kí gói Full", "thế chọn gói Full").
 * Khác detectIndecisive ("chưa biết tập gì") — đây là chốt CỤ THỂ gói Full.
 */
export function detectFullPackageConfirm(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(đăng\s*k(ý|i)|chọn|lấy|tham\s*gia|thử)\s+(luôn\s+)?(gói\s+)?full/.test(m) ||
    /(gói\s+full|thẻ\s+full)\s+(nhỉ|nha|nhé|đi|luôn)/.test(m)
  );
}

/**
 * Khách nói "chưa biết tập gì, em tham khảo / chọn giúp em" ở stage opening —
 * Fami flow: hỏi "đã từng tập bộ môn nào chưa / có yêu thích bộ môn nào không"
 * TRƯỚC khi list 4 dịch vụ.
 */
export function detectChuaBietTapGi(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /(chưa\s+biết|không\s+biết)\s*(nên\s+)?tập\s+(gì|môn\s+nào|bộ\s*môn\s+nào)/.test(m) ||
    /(em\s+cho|cho)\s+(chị|anh|em|mình|tôi).{0,10}tham\s*khảo/.test(m)
  );
}

/**
 * Khách đi "tham quan" / chỉ ghé xem, chưa chọn — bot phải giới thiệu 4 dịch vụ
 * + nhấn gói Full đa năng.
 */
export function detectThamQuan(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return /tham\s*quan|đi\s+qua\s+(coi|xem)|chỉ\s+(đi|ghé)\s+(qua|xem)/.test(m);
}

/**
 * Khách nói tuổi bé (vd "cháu 6 tuổi", "bé 7 tuổi nhé", "cháu nhà 6t"). Match thuần số tuổi.
 * Dùng kèm context serviceType=boi để switch sang ask test bạo nước.
 */
export function detectChildAgeStated(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return /\b(\d{1,2})\s*(tuổi|t)\b/.test(m);
}

// ─────────────────────────────────────────────
// MEDIA KEY SUGGESTION
// ─────────────────────────────────────────────

/**
 * Map slots → key tool get-media phù hợp nhất.
 * Trả null nếu chưa đủ info để gợi key tốt (vd fitness chưa có serviceType).
 *
 * Fitness:
 *   gym/full → fitness-gym
 *   yoga    → fitness-yoga
 *   zumba   → fitness-zumba
 *   boi     → fitness-pool
 *   pilates → fitness-gym (cùng phòng tập, fallback an toàn)
 *
 * Giải cơ:
 *   vai/gáy/cổ → mr-neck-shoulder
 *   chân/gối   → mr-sport
 *   khác       → mr-general
 */
/**
 * Detect dịch vụ khách MỚI mention trong tin nhắn hiện tại → trả key media tương ứng.
 * Dùng để override state.serviceType (đã lock từ turn cũ) khi khách hỏi về dịch vụ KHÁC.
 * Vd: serviceType="boi", message="cũng muốn tham khảo zumba" → "fitness-zumba".
 */
export function detectMentionedServiceKey(message: string): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (/\bzumba\b/.test(m)) return "fitness-zumba";
  if (/\byoga\b/.test(m)) return "fitness-yoga";
  if (/\bbơi|bể\s*bơi|bơi\s*lội\b/.test(m)) return "fitness-pool";
  if (/\bpilates\b/.test(m)) return "fitness-gym";
  if (/\bgym\b/.test(m)) return "fitness-gym";
  return null;
}

export function computeSuggestedMediaKey(state: ConversationState): string | null {
  const { flow, knownInfo } = state;

  if (flow === "fitness") {
    const svc = knownInfo.serviceType;
    const mapFitness: Record<string, string> = {
      gym: "fitness-gym",
      full: "fitness-gym",
      pilates: "fitness-gym",
      yoga: "fitness-yoga",
      zumba: "fitness-zumba",
      boi: "fitness-pool",
    };
    if (svc && mapFitness[svc]) return mapFitness[svc];
    // Fallback: map theo goal khi chưa có serviceType
    const goal = knownInfo.fitnessGoal;
    const mapGoal: Record<string, string> = {
      "giam-mo": "fitness-gym",
      "tang-co": "fitness-gym",
      "suc-khoe": "fitness-gym",
      "thu-gian": "fitness-yoga",
      "hoc-boi": "fitness-pool",
    };
    if (goal && mapGoal[goal]) return mapGoal[goal];
    return null;
  }

  // giai-co
  const pain = knownInfo.painArea;
  if (!pain) return null;
  const tokens = pain.toLowerCase().split(/[\s,/\-_]+/).filter(Boolean);
  const has = (...words: string[]) => words.some((w) => tokens.includes(w));
  if (has("vai", "gáy", "gay", "cổ", "co")) return "mr-neck-shoulder";
  if (has("chân", "chan", "gối", "goi")) return "mr-sport";
  return "mr-general";
}

/**
 * Block [MEDIA]: hint MỀM, không ép.
 * Bot tự quyết có gọi get-media hay không dựa trên moment phù hợp.
 *
 * Nguyên tắc inject:
 *   - mediaShown=true            → cấm cứng (đã handle ở đầu buildLogicGate).
 *   - opening / commitment       → không khuyến khích (sai moment).
 *   - không có suggestedKey      → không gợi.
 *   - còn lại                    → gợi key + để LLM tự quyết.
 */
function buildMediaHint(state: ConversationState): string {
  if (state.mediaShown) return "";
  // Discovery = bot đang HỎI thăm dò (đã tập chưa, mục tiêu gì) → gửi ảnh là chen ngang.
  // Chỉ gợi media khi sang inbody/evaluation/negotiation — moment bot build value/pitch.
  if (
    state.stage === "opening" ||
    state.stage === "discovery" ||
    state.stage === "commitment"
  ) return "";

  const key = computeSuggestedMediaKey(state);
  if (!key) return "";

  return (
    `[MEDIA: chưa gửi. suggestedKey="${key}". TỰ QUYẾT gọi get-media nếu khách đang phân vân/build-value/xin xem trực tiếp. KHÔNG gửi khi chào hỏi/đang chốt/đang thăm dò. Max 1 lần/conv.]`
  );
}

// ─────────────────────────────────────────────
// LOGIC GATES
// ─────────────────────────────────────────────

export function buildLogicGate(state: ConversationState, message?: string): string {
  const { stage, intent, flow, knownInfo, mediaShown } = state;
  const mediaShownKeys = state.mediaShownKeys ?? [];
  const hints: string[] = [];

  // ── CROSS-CUTTING: media đã gửi rồi → cấm gọi lại
  // EXCEPT (a) khách EXPLICIT xin xem hoặc (b) khách mention DỊCH VỤ MỚI chưa gửi media.
  const customerAskingMedia = message ? detectMediaRequest(message) : false;
  const mentionedKey = message ? detectMentionedServiceKey(message) : null;
  const isNewServiceKey = mentionedKey !== null && !mediaShownKeys.includes(mentionedKey);
  if (mediaShown && !customerAskingMedia && !isNewServiceKey) {
    hints.push(
      "[GATE media-shown: ĐÃ gửi ảnh. KHÔNG gọi lại get-media. Nếu khách xin thêm → text 'em đã gửi rồi nha, mời ghé trực tiếp xem'.]",
    );
  }

  // ── ƯU TIÊN TUYỆT ĐỐI: ĐỦ tên+SĐT+giờ → chỉ confirm rồi DỪNG ──
  if (
    knownInfo.name !== null &&
    knownInfo.phone !== null &&
    knownInfo.preferredTime !== null
  ) {
    return `[GATE done-slots: ĐỦ tên=${knownInfo.name}, SĐT=${knownInfo.phone}, giờ=${knownInfo.preferredTime}. Reply 1 CÂU "Dạ em giữ slot ${knownInfo.preferredTime} cho mình rồi nha ${state.honorific} ${knownInfo.name}, hẹn gặp ${state.honorific} ạ" rồi DỪNG. KHÔNG pitch/QR/hỏi thêm.]`;
  }

  // ── Khách đổi giờ (compact) ──
  if (
    message &&
    knownInfo.preferredTime &&
    /(thôi|đổi|chuyển|hoặc|hay là|sang)\s/i.test(message)
  ) {
    hints.push(`[GATE đổi giờ: giờ MỚI="${knownInfo.preferredTime}". Reply phải khớp giờ mới, KHÔNG dùng giờ cũ.]`);
  }

  // ── KH chốt gói Full ("đăng kí gói Full nhỉ?") — ACK gói Full + hỏi info ──
  if (flow === "fitness" && message && detectFullPackageConfirm(message)) {
    return (
      "[GATE full-package-confirm: KHÔNG pitch lại giá. Reply 2 câu: " +
      `(1) ACK gói Full phù hợp: 'Dạ vâng ${state.honorific}, em thấy gói Full phù hợp với mình lắm — vì mỗi thời điểm mình sẽ có 1 mục tiêu khác nhau, tập đủ 4 dịch vụ rất linh động ạ'. ` +
      "(2) Hỏi GỘP: 'Cho em xin tên, SĐT với " + state.honorific + " muốn đến buổi sáng, chiều hay tối ạ'. " +
      "KHÔNG bỏ qua phần ACK gói Full.]"
    );
  }

  // ── KH hỏi tập thử / trải nghiệm thử ──
  if (flow === "fitness" && message && detectTrialAsk(message)) {
    // Chưa biết bộ môn → hỏi BỘ MÔN trước (TL1 kịch bản Fami). KHÔNG hỏi khung giờ ngay
    // khi chưa biết khách quan tâm gì — vô nghĩa, phải biết tập gì rồi mới sắp giờ.
    if (knownInfo.serviceType === null) {
      return (
        `[GATE trial-ask (chưa biết bộ môn): hỏi BỘ MÔN trước, KHÔNG hỏi khung giờ. ` +
        `Reply theo TL1 kịch bản Fami: 'Dạ em chào ${state.honorific}, cảm ơn ${state.honorific} đã quan tâm đến dịch vụ của trung tâm. Bên em có nhiều bộ môn Gym, Yoga, Zumba, Bơi — không biết ${state.honorific} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ'. ` +
        `BẮT BUỘC nhắc đủ 4 từ Gym, Yoga, Zumba, Bơi. KHÔNG hỏi khung giờ. KHÔNG pitch giá.]`
      );
    }
    return (
      "[GATE trial-ask: trả lời TRƯỚC: 'Dạ bên em có ạ, em hỗ trợ mình tập thử 1 buổi để xem phòng tập và giáo viên có phù hợp không, sau đó mình cân đối các gói giá ạ'. " +
      "Có thể kèm khung giờ '5h sáng hoặc 18h chiều'. KHÔNG pitch 3 gói số giá ở turn này.]"
    );
  }

  // ── KH explicit hỏi list gói giá ("gói giá nào", "có những gói nào") — Fami style ──
  // Hard-return để cleanReply không strip pitch lặp với prev trial reply.
  if (flow === "fitness" && message && detectExplicitPriceList(message)) {
    const svcLabel =
      knownInfo.serviceType === "zumba"
        ? "Zumba"
        : knownInfo.serviceType === "yoga"
          ? "Yoga"
          : knownInfo.serviceType === "boi"
            ? "Bơi"
            : knownInfo.serviceType === "gym"
              ? "Gym"
              : "dịch vụ";
    const minPrice =
      knownInfo.serviceType === "zumba"
        ? "375k"
        : knownInfo.serviceType === "yoga"
          ? "350k"
          : "333k";
    return (
      `[GATE explicit-price-list: Reply theo style Fami kịch bản. ` +
      `(1) ACK 'Dạ vâng ${state.honorific}, về học phí, bên em có nhiều gói cho mình lựa chọn'. ` +
      `(2) List gói tháng/quý/6 tháng/12 tháng cho ${svcLabel}. ` +
      `(3) Nhấn ưu đãi: 'hiện tại bên em ưu đãi chỉ từ ${minPrice}/tháng ạ'. ` +
      `BẮT BUỘC nhắc 'gói' và 'ưu đãi từ ${minPrice}/tháng'. ` +
      `KHÔNG nhắc lại 'tập thử 1 buổi' (đã nói turn trước).]`
    );
  }

  // ── KH hỏi "tư vấn chương trình tập luyện" — list 4 dịch vụ ──
  if (flow === "fitness" && message && detectChuongTrinhConsult(message)) {
    return (
      `[GATE chuong-trinh-consult: Reply mở 'Dạ em chào ${state.honorific}, cảm ơn ${state.honorific} đã quan tâm. Bên em hiện tại có nhiều bộ môn: Gym, Yoga, Zumba, Bơi. Không biết ${state.honorific} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ'. ` +
      "BẮT BUỘC nhắc đủ 4 từ Gym, Yoga, Zumba, Bơi.]"
    );
  }

  // ── KH "chưa biết tập gì, em cho tham khảo" — hỏi history bộ môn trước ──
  if (flow === "fitness" && message && detectChuaBietTapGi(message) && stage === "opening") {
    return (
      `[GATE chua-biet-tap-gi: KHÔNG list 4 dịch vụ NGAY. Reply 1 câu hỏi: 'Dạ em chào ${state.honorific}, ${state.honorific} ơi trước đây mình đã từng tập bộ môn nào chưa ạ, hay là mình có yêu thích bộ môn nào không ạ?'. KHÔNG list dịch vụ ở turn này.]`
    );
  }

  // ── KH explicit nói "muốn giảm cân" ở turn đầu (chưa có serviceType) — hỏi history TRƯỚC ──
  // (Fami flow: ack mục tiêu → hỏi đã thử biện pháp gì chưa → mới recommend)
  if (
    flow === "fitness" &&
    message &&
    /(muốn\s+)?(giảm\s+cân|giảm\s+mỡ|giảm\s+béo)/i.test(message) &&
    knownInfo.serviceType === null &&
    state.turnCount <= 1
  ) {
    return (
      `[GATE giam-can-opening: KHÔNG recommend dịch vụ NGAY, hỏi history TRƯỚC. ` +
      `Reply 1 câu: 'Dạ em chào ${state.honorific}, cảm ơn ${state.honorific} đã quan tâm. Không biết ${state.honorific} có đang tập luyện hay sử dụng biện pháp giảm cân nào không ạ?'. ` +
      `BẮT BUỘC nhắc 'tập luyện' và 'biện pháp giảm cân'. KHÔNG hỏi 'gym/yoga' cụ thể.]`
    );
  }

  // ── KH "đi qua tham quan thôi" — list 4 dịch vụ + gói Full đa năng ──
  if (flow === "fitness" && message && detectThamQuan(message)) {
    return (
      "[GATE tham-quan: Reply 2 câu — " +
      "(1) 'Dạ vâng " + state.honorific + ", bên em là Tổ hợp thể thao bao gồm Gym, Yoga, Zumba và Bơi, mỗi bộ môn sẽ có lợi ích riêng'. " +
      "(2) 'Bên em cũng có gói Full đa năng bao gồm cả 4 dịch vụ để mình linh động đỡ nhàm chán ạ. " + state.honorific + " đang thiên về mục tiêu nào để em tư vấn thêm ạ?'. " +
      "BẮT BUỘC nhắc 'gói Full' / 'tổ hợp' + 4 dịch vụ.]"
    );
  }

  // ── ƯU TIÊN: chấn thương cấp tính (giải cơ) → cảnh báo nghỉ trước (compact) ──
  if (flow === "giai-co" && message && detectAcuteInjury(message)) {
    return (
      "[GATE chấn thương cấp: KHÔNG mời giải cơ. Khuyên nghỉ 3-5 ngày + chườm đá, nếu đau tăng/tê chân tay → đi khám. KHÔNG pitch gói, KHÔNG hỏi thêm slot.]"
    );
  }

  // ── ƯU TIÊN: khách lạnh → KHÔNG push (compact) ──
  if (message && detectColdLead(message)) {
    return (
      "[GATE: khách đang lạnh, muốn tham khảo. Reply 1-2 câu LÙI: 'Dạ vâng nha anh/chị, anh/chị cứ tham khảo thoải mái, có gì em sẵn sàng tư vấn thêm'. KHÔNG xin tên/SĐT/giờ, KHÔNG pitch, KHÔNG hỏi tiếp.]"
    );
  }

  // ── Khách hỏi factual về cơ sở (compact) ──
  if (message) {
    const fq = detectFacilityQuestion(message, flow);
    if (fq) {
      hints.push(
        `[GATE factual: mở reply bằng FACT "${fq.fact}" + 1 câu dẫn dắt. KHÔNG bỏ qua câu hỏi pivot sang pitch.]`,
      );
    }
  }

  // ── ƯU TIÊN: khách hỏi GIỜ MỞ CỬA → trả giờ, KHÔNG xin tên/SĐT (compact) ──
  if (message && detectHoursQuestion(message)) {
    const hours = flow === "fitness" ? "05:00–20:00" : "09:00–23:00";
    hints.push(
      `[GATE giờ mở cửa: trả "bên em mở ${hours}" + hỏi sáng/chiều tiện. KHÔNG xin tên/SĐT turn này.]`,
    );
  }

  // ── ƯU TIÊN: bảo lưu/vắng/hoãn (compact) ──
  if (flow === "fitness" && message && detectHoldPolicy(message)) {
    hints.push(
      "[GATE bảo lưu: gói năm (3m+) bảo lưu được khi vắng 1-2 tuần, gói tháng không bảo lưu nhưng chuyển nhượng được trong gia đình. Answer câu này trước, KHÔNG nhảy InBody.]",
    );
  }

  // ── ƯU TIÊN: khách answer ngắn → ACK luân phiên (xem ACK MẪU trong instructions) ──
  if (message && detectShortAnswer(message)) {
    hints.push(
      `[GATE: khách answer ngắn → MỞ reply bằng ACK luân phiên (xem ACK MẪU trong system prompt — KHÔNG dùng mãi 'em note rồi ạ'). Sau ACK 1 câu mới chuyển ý.]`,
    );
  }

  // ── ƯU TIÊN: khách cần PT 1-1 (compact) ──
  if (flow === "fitness" && message && detectPTNeed(message)) {
    hints.push(`[GATE PT: pitch thẳng "PT 20 buổi 6 triệu (2 tháng), HLV 1-1". KHÔNG hỏi gym/yoga.]`);
  }

  // ── ƯU TIÊN: khách phản đối giá → reframe theo VALUE ──
  // (Detail value 3 mũi đã có ở playbook negotiation_neutral + [OBJECTIONS] block)
  if (message && detectPriceObjection(message) && flow === "fitness") {
    return (
      "[GATE: khách phản đối giá. KHÔNG hạ giá, KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê. " +
      "Reframe value 3 mũi (cơ sở 700m2 + bể 4 mùa duy nhất / GV Ấn Độ + InBody miễn phí / social proof hội viên gắn bó 2-3 năm). " +
      "Mời thử 1 buổi miễn phí. KHÔNG xin tên/SĐT tin này.]"
    );
  }
  if (message && detectPriceObjection(message) && flow === "giai-co") {
    return (
      "[GATE: khách phản đối giá. Reframe: KTV đào tạo giải phẫu cơ bài bản, tác động đúng nhóm cơ kẹt, đỡ rõ trong 1-2 buổi. " +
      "Mời thử 1 buổi không cam kết.]"
    );
  }

  // ── Khách xin xem ảnh/video (compact) ──
  if (message && detectMediaRequest(message)) {
    const key = computeSuggestedMediaKey(state);
    if (key) {
      hints.push(
        `[GATE media-request: gọi get-media key="${key}" 1 LẦN. Reply ≤80 chars "Dạ em gửi vài hình cho ${state.honorific} xem nha". Copy URLs vào mediaUrls.]`,
      );
    }
  }

  // ── PROACTIVE: gửi ảnh build trust khi đã biết goal/service VÀ chưa gửi media cho service đó ──
  // (User feedback: bot chờ khách hỏi xin ảnh, chưa chủ động — phải proactive ngay khi biết goal/service)
  // Bypass mediaShown khi khách mention DỊCH VỤ MỚI (vd: đã gửi bơi, giờ hỏi zumba → gửi zumba).
  const hasContextForMedia =
    knownInfo.fitnessGoal !== null ||
    knownInfo.serviceType !== null ||
    mentionedKey !== null ||
    (flow === "giai-co" && knownInfo.painArea !== null);
  // Ưu tiên key khách vừa mention (override state.serviceType cũ).
  const proactiveKey = mentionedKey ?? computeSuggestedMediaKey(state);
  const keyAlreadySent = proactiveKey !== null && mediaShownKeys.includes(proactiveKey);
  // Stage được phép proactive media:
  //   - fitness: CHỈ inbody/evaluation — moment bot đã pitch value, ảnh để build trust.
  //     KHÔNG fire ở discovery — discovery là lúc bot ĐANG HỎI thăm dò ("đã tập chưa",
  //     "mục tiêu gì"), gửi ảnh kèm câu hỏi discovery là chen ngang, sai moment.
  //     (User feedback 2026-05: bot từng gửi media ngay turn đầu khi khách mới nói
  //     "quan tâm zumba" — bot mới hỏi "đã tập chưa" mà đã đính kèm ảnh → awkward.)
  //   - giai-co: evaluation, HOẶC khi ĐỦ 3 slot pain (painArea + painSpread + pastMethod) —
  //     ngầm hiểu đã sang evaluation, kể cả khi stage transition lag do classifier.
  //     KHÔNG fire khi mới có painArea+painSpread (chưa hỏi pastMethod) — moment đó vẫn
  //     đang khai thác triệu chứng, chưa pitch value, gửi ảnh là chen ngang.
  const giaiCoAllPainSlots =
    knownInfo.painArea !== null &&
    knownInfo.painSpread !== null &&
    knownInfo.pastMethod !== null;
  const stageAllowsProactiveMedia =
    flow === "fitness"
      ? stage === "inbody" || stage === "evaluation"
      : stage === "evaluation" || giaiCoAllPainSlots;
  if (
    !keyAlreadySent &&
    !customerAskingMedia &&
    hasContextForMedia &&
    stageAllowsProactiveMedia
  ) {
    const key = proactiveKey;
    if (key) {
      hints.push(
        `[GATE proactive-media: gọi get-media key="${key}" 1 LẦN. Reply text 1 câu dẫn dắt "Em gửi vài hình cho ${state.honorific} hình dung nha". Copy URLs vào mediaUrls, nextStep="show_media".]`,
      );
    }
  }

  // ── KH so sánh Zumba với Aerobic — hard-return để không bị GATE evaluation/compare override ──
  if (
    flow === "fitness" &&
    message &&
    /aerobic|earobic/i.test(message)
  ) {
    return (
      "[GATE Zumba-vs-Aerobic ƯU TIÊN: KHÔNG pitch gói. Trả lời SO SÁNH chuyên môn theo TL Fami: " +
      "'Dạ Zumba và Aerobic đều tập trên nền nhạc, tuy nhiên Zumba thiên về nhảy và cảm thụ âm nhạc hơn — đa dạng động tác, nhẹ nhàng uyển chuyển cũng có mà mạnh mẽ dứt khoát cũng có. Aerobic thiên về mạnh mẽ, cardio liên tục, sẽ khó theo hơn Zumba ạ.' " +
      "Sau đó mời tập thử 1 buổi: 'Anh/chị qua thử 1 buổi xem phòng tập và giáo viên có phù hợp không nha'.]"
    );
  }

  // ── KH hỏi Zumba có giảm cân không — Fami knowledge ──
  if (
    flow === "fitness" &&
    knownInfo.serviceType === "zumba" &&
    message &&
    /(giảm\s*(cân|mỡ|béo)|đốt\s*mỡ)/i.test(message)
  ) {
    hints.push(
      "[GATE Zumba-giảm-cân: trả lời knowledge: 'Zumba là một trong những bộ môn giảm mỡ toàn thân, săn chắc eo, đùi, bắp tay, lại giúp xả stress và năng lượng tích cực ạ. Nếu muốn nhanh thì có thể kết hợp thêm 1-2 buổi Gym để tối ưu hơn'. KHÔNG nhảy thẳng InBody/3 gói.]",
    );
  }

  // ── Bơi: KH muốn HỌC BƠI nhưng chưa rõ NL/TE — Fami hỏi NL/TE TRƯỚC khi pitch gói ──
  // CHỈ fire khi:
  //   - message có ý "quan tâm/muốn HỌC bơi" (không phải FAQ về bể bơi)
  //   - KHÔNG phải factual question (giờ mở/clo/đồ bơi...)
  //   - chưa mention NL/TE hoặc tuổi
  if (
    flow === "fitness" &&
    knownInfo.serviceType === "boi" &&
    message &&
    /(quan\s*tâm|muốn|cần|hỏi\s+về)\s+(học\s+)?bơi|học\s+bơi/i.test(message) &&
    !detectFacilityQuestion(message, flow) &&
    !/(trẻ\s*(con|em)|bé\s*nhà|con\s+(tôi|chị|anh|em)|cháu\s+(nhà|tôi|chị|anh)|\bbé\b|người\s*lớn|nl\b|adult)/i.test(message) &&
    !detectChildAgeStated(message)
  ) {
    return (
      "[GATE bơi-hỏi-NL/TE: KHÔNG pitch gói, KHÔNG list 'có 2 lựa chọn'. " +
      `Reply DUY NHẤT 1 câu: 'Dạ em chào ${state.honorific}, không biết ${state.honorific} đang quan tâm học bơi cho người lớn hay trẻ em ạ?'. ` +
      "BẮT BUỘC nhắc 'người lớn' và 'trẻ em'.]"
    );
  }

  // ── Bơi cho trẻ em (Fami: hỏi tuổi + test bạo nước trước khi pitch gói) ──
  // HARD RETURN — chỉ hỏi tuổi, KHÔNG pitch.
  if (
    flow === "fitness" &&
    knownInfo.serviceType === "boi" &&
    message &&
    /(trẻ\s*(con|em)|bé\s*nhà|con\s+(tôi|chị|anh|em)|cháu\s+(nhà|tôi|chị|anh)|\bbé\b)/i.test(message) &&
    !detectChildAgeStated(message)
  ) {
    return (
      "[GATE bơi-trẻ-em (hỏi tuổi): KHÔNG pitch gói, KHÔNG list 'có mấy hướng'. " +
      `Reply DUY NHẤT 1 câu: 'Dạ để học bơi được hiệu quả, bên em sẽ nhận học sinh từ 6 tuổi. Không biết bạn nhà mình năm nay mấy tuổi rồi ạ?'. ` +
      "BẮT BUỘC nhắc '6 tuổi' và 'mấy tuổi'.]"
    );
  }

  // ── Bơi: khách vừa nói tuổi bé ("cháu 6 tuổi") → ask test bạo nước ──
  if (
    flow === "fitness" &&
    knownInfo.serviceType === "boi" &&
    message &&
    detectChildAgeStated(message)
  ) {
    return (
      "[GATE bơi-tuổi-stated (test bạo nước): KHÔNG pitch gói. " +
      `Reply 2 câu: (1) ACK tuổi + giải thích test nước 'Dạ bên em nhận từ 6 tuổi, tuy nhiên để chương trình học đạt hiệu quả cao, bên em hỗ trợ test nước với các bạn nhỏ về mức độ bạo nước'. ` +
      `(2) Hỏi: 'Không biết bé nhà mình ở nhà có tắm được vòi sen hay đi bơi có dám ngụp nước không ạ?'. ` +
      "BẮT BUỘC nhắc 'test nước' / 'bạo nước' và hỏi 'vòi sen' hoặc 'ngụp nước'.]"
    );
  }

  // ── Multi-service: khách nhắc 2+ dịch vụ trong 1 tin (compact) ──
  if (
    flow === "fitness" &&
    message &&
    /(gym|yoga|zumba|bơi|pilates).{0,30}(và|\+|với)\s*(gym|yoga|zumba|bơi|pilates)/i.test(
      message,
    )
  ) {
    hints.push("[GATE multi-service: đề xuất thẻ Full 4 dịch vụ (1.2tr/tháng → 7tr/12 tháng).]");
  }

  // ── HS/SV (compact, giá cụ thể) ──
  if (
    flow === "fitness" &&
    knownInfo.memberType === "hoc-sinh" &&
    !knownInfo.preferredTime
  ) {
    hints.push(
      "[GATE HS/SV: gói Full HS/SV — 700k/tháng, 2tr/3 tháng, 3tr/6 tháng, 4tr/12 tháng. Pitch giá cụ thể, không 'có ưu đãi' chung chung.]",
    );
  }

  // ── Khách chỉ muốn 1 dịch vụ (compact) ──
  if (
    flow === "fitness" &&
    message &&
    (/chỉ\s*(tập|cần|muốn)?\s*(yoga|zumba|bơi|gym|pilates)\s*(thôi|nhỉ)?/i.test(message) ||
      /không\s+cần\s+(gym|yoga|zumba|bơi|pilates|full)/i.test(message) ||
      /(muốn|chỉ)\s+(học\s+)?(yoga|zumba|bơi|pilates)(?!\s*\+)/i.test(message) ||
      /(yoga|zumba|bơi|pilates|gym)\s+thôi/i.test(message))
  ) {
    hints.push("[GATE single-service: KHÔNG ép Full, pitch gói đơn dịch vụ khách chọn. KHÔNG nói 'kết hợp cardio'.]");
  }

  // ── Khách hỏi giá (Fami trial-first close style) ──
  if (message && detectPriceQuestion(message) && !knownInfo.name && !knownInfo.phone) {
    if (flow === "fitness") {
      // Nếu CHƯA có goal cụ thể → nói ưu đãi chung + mời trải nghiệm (tránh bung 3 gói khi chưa hiểu nhu cầu).
      // Có goal rồi → bung gói theo goal (PRICING block lọc theo goal).
      if (knownInfo.fitnessGoal === null) {
        hints.push(
          "[GATE giá (chưa goal): nói ưu đãi chung 'chỉ từ 333k/tháng' + mời TRẢI NGHIỆM THỬ — KHÔNG bung 3 gói chi tiết khi chưa biết mục tiêu. Vd 'Hiện tại bên em có nhiều ưu đãi chỉ từ 333k/tháng, em tặng anh/chị chương trình trải nghiệm thử xem có phù hợp không. Anh/chị có muốn đăng ký trải nghiệm không ạ'. KHÔNG dẫn InBody, KHÔNG xin tên/SĐT.]",
        );
      } else {
        hints.push(
          "[GATE giá (đã có goal): trả giá CỤ THỂ từ [PRICING] theo goal. Vd 'Full 1.2tr/tháng, 3tr/3 tháng, 7tr/12 tháng'. KHÔNG né, KHÔNG xin tên/SĐT.]",
        );
      }
    } else {
      hints.push("[GATE giá: trả giá NGAY. Lẻ 200k-590k, liệu trình từ 3.3tr/10 buổi.]");
    }
  }

  // ── Khách hỏi cọc/thanh toán (compact) ──
  if (message && detectDepositAsk(message)) {
    const qrShown = (state as any).qrShown ?? false;
    if (!qrShown) {
      if (knownInfo.name && knownInfo.phone) {
        const qrFlow = flow === "fitness" ? "fitness" : "muscle-release";
        return `[GATE deposit: GỌI get-qr flow="${qrFlow}" NGAY. Reply ngắn xác nhận cọc + gửi QR + hướng dẫn nội dung CK (tên+SĐT). Copy qrUrl, nextStep="show_qr".]`;
      }
      return `[GATE deposit (chưa tên/SĐT): "Dạ cọc trước được nha ${state.honorific} — cho em xin tên với SĐT để lập đơn rồi gửi QR". CHƯA gọi get-qr.]`;
    }
    return `[GATE deposit: QR đã gửi. Xác nhận nội dung CK, hướng dẫn bước tiếp. KHÔNG gọi lại get-qr.]`;
  }

  // ── OPENING lặp: khách reply ngắn (ok/ừ/được) lần 2+ mà chưa cho signal ──
  if (
    state.stage === "opening" &&
    state.turnCount >= 2 &&
    knownInfo.serviceType === null &&
    knownInfo.painArea === null
  ) {
    if (state.turnCount >= 3) {
      hints.push("[GATE opening-lặp ≥3: reply ≤80 chars 'Dạ vâng, anh/chị cần gì cứ nhắn em nha'. KHÔNG pitch.]");
    } else {
      hints.push(
        `[GATE opening-lặp: KHÔNG lặp câu chào. Khơi gợi nhẹ — vd "${state.honorific} đang thiên về cải thiện vóc dáng hay sức khỏe tổng thể ạ".]`,
      );
    }
  }

  // (Removed: discovery serviceType/goal null GATEs — đã có few-shot OPENING + discovery_neutral tactic.)

  // ── FITNESS: inbody pitch — chỉ pitch khi khách KHÔNG có signal khác ──
  // Skip InBody pitch nếu khách:
  //   - đang compare / hỏi giá (đáp ứng giá trước)
  //   - phản đối giá (objection trước)
  //   - bảo "chỉ tập X thôi" (single-service)
  //   - cold lead (đã handle ở GATE ưu tiên trên, nhưng safety)
  if (flow === "fitness" && stage === "inbody") {
    const skipInbody =
      intent === "compare" ||
      knownInfo.memberType === "hoc-sinh" ||
      knownInfo.memberType === "gia-dinh" ||
      // InBody chủ yếu cho gym/giảm mỡ. Bơi/yoga/zumba/pilates không cần.
      knownInfo.serviceType === "boi" ||
      knownInfo.serviceType === "yoga" ||
      knownInfo.serviceType === "zumba" ||
      knownInfo.serviceType === "pilates" ||
      knownInfo.fitnessGoal === "thu-gian" ||
      knownInfo.fitnessGoal === "hoc-boi" ||
      (message && detectPriceQuestion(message)) ||
      (message && detectPriceObjection(message)) ||
      (message && /chỉ\s*(tập|cần|muốn)?\s*(yoga|zumba|bơi|gym|pilates)\s*(thôi|nhỉ)?/i.test(message)) ||
      (message && /(muốn|chỉ)\s+(học\s+)?(yoga|zumba|bơi|pilates)(?!\s*\+)/i.test(message));

    let ib: string;
    if (skipInbody) {
      const banInBody =
        knownInfo.serviceType === "yoga" ||
        knownInfo.serviceType === "boi" ||
        knownInfo.serviceType === "zumba" ||
        knownInfo.serviceType === "pilates" ||
        knownInfo.fitnessGoal === "thu-gian" ||
        knownInfo.fitnessGoal === "hoc-boi";
      ib = banInBody
        ? "khách yoga/bơi/zumba/pilates/thư-giãn → KHÔNG nhắc InBody. Pitch service-specific."
        : "skip InBody pitch, answer nhu cầu trước. Có thể nhắc InBody 1 dòng cuối.";
    } else if (knownInfo.schedule === null) {
      const svc = knownInfo.serviceType ?? "dịch vụ";
      ib = `chưa schedule → ack "${svc} cho ${knownInfo.fitnessGoal ?? "mục tiêu"}" + hỏi "sáng/chiều, mấy buổi/tuần". KHÔNG pitch gói.`;
    } else {
      ib = `có schedule=${knownInfo.schedule} → ack lịch + pitch InBody ngắn ("máy đọc mỡ/cơ thật") + mời ghé sáng/chiều. KHÔNG show giá.`;
    }
    hints.push(`[GATE inbody: ${ib}]`);
  }

  // ── Negotiation + khách đã chấp nhận (compact) ──
  if (stage === "negotiation" && (intent === "selecting" || intent === "ready")) {
    hints.push(
      "[GATE negotiation-accept: KHÔNG pitch thêm, hỏi GỘP 'Cho em xin tên, SĐT với anh/chị muốn đến buổi sáng/chiều/tối ạ' (bỏ phần giờ nếu đã có preferredTime).]",
    );
  }

  // ── FITNESS: evaluation — khách đã chọn → skip pitch, xin info ──
  if (flow === "fitness" && stage === "evaluation" && (intent === "selecting" || intent === "ready")) {
    hints.push(
      "[GATE: khách sẵn sàng đăng ký. KHÔNG pitch thêm, hỏi tên+SĐT để giữ slot.]",
    );
  }
  // (Removed: evaluation pitch GATE chi tiết — đã có few-shot EXAMPLE với value + 3 gói cụ thể per goal.)

  // ── GIẢI CƠ: chưa biết vùng đau — chỉ giữ case "có giờ trước" (cần ack đặc biệt) ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea === null &&
    knownInfo.preferredTime !== null
  ) {
    hints.push(
      `[GATE: khách báo giờ=${knownInfo.preferredTime} TRƯỚC khi mô tả vùng đau. Ack giờ rồi mới hỏi vùng đau, KHÔNG bỏ qua giờ.]`,
    );
  }
  // (Removed: painArea null GATEs — đã có few-shot discovery cho giải cơ.)

  // ── GIẢI CƠ: biết painArea nhưng chưa hỏi painSpread ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea !== null &&
    knownInfo.painSpread === null
  ) {
    // Anti-loop: nếu turn ≥ 3 hoặc đã có painDuration/pastMethod → SKIP painSpread,
    // không lặp đi lặp lại câu hỏi "đau lan ra hay cố định".
    const shouldSkipSpread =
      state.turnCount >= 3 ||
      knownInfo.painDuration !== null ||
      knownInfo.pastMethod !== null;
    if (shouldSkipSpread) {
      hints.push(
        "[GATE: đã hỏi painSpread 1 lần, khách không answer rõ → SKIP, KHÔNG hỏi lại 'lan ra hay cố định'. " +
          "Tiến tới hỏi pastMethod hoặc painDuration tự nhiên hơn, vd 'Trước giờ anh/chị có thử massage hay dán cao chưa ạ?']",
      );
    } else {
      hints.push(
        `[GATE: biết vùng_đau=${knownInfo.painArea} nhưng chưa biết tính chất lan tỏa. ` +
          `Cấu trúc reply 2 câu: (1) ack triệu chứng + nhắc KTV bên em xử lý — vd "Dạ ${knownInfo.painArea} đau kiểu này thường là cơ co rút ở 1 điểm, KTV bên em xử lý nhiều rồi ạ". ` +
          "(2) Hỏi 1 LẦN duy nhất: 'Cơn đau lan ra xung quanh hay chỉ đau một điểm cố định thôi ạ'. " +
          "Sau đó dù khách answer hay không, KHÔNG lặp lại câu hỏi này ở turn sau.]",
      );
    }
  }

  // ── GIẢI CƠ: biết painArea + painSpread, chưa hỏi pastMethod ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea !== null &&
    knownInfo.painSpread !== null &&
    knownInfo.pastMethod === null
  ) {
    // Anti-loop: nếu prev đã hỏi massage/thuốc → SKIP hỏi lại, tiến tới evaluation
    const prevAskedMethod = state.lastBotReply
      ? /(massage|thuốc|dán cao|đã thử)/i.test(state.lastBotReply)
      : false;
    // Anti-repeat: nếu prev đã nhắc "KTV bên em" → KHÔNG lặp ở turn này.
    const prevMentionedKTV = state.lastBotReply
      ? /\bKTV\s+bên\s+em\b/i.test(state.lastBotReply)
      : false;
    if (prevAskedMethod || state.turnCount >= 3) {
      hints.push(
        "[GATE: đã hỏi pastMethod tin trước → SKIP, KHÔNG hỏi lại. " +
          "Tiến tới evaluation: hình ảnh hóa vùng đau + contrast bề mặt vs sâu + mời 1 buổi thử.]",
      );
    } else if (prevMentionedKTV) {
      hints.push(
        `[GATE: biết vùng_đau=${knownInfo.painArea}, prev đã nhắc 'KTV bên em' → KHÔNG lặp lại cụm này. ` +
          `Hỏi thẳng 1 LẦN: 'Trước giờ ${state.honorific} có thử massage hay dán cao chưa ạ'. Có thể prefix bằng ack ngắn về vùng đau lan (1 câu).]`,
      );
    } else {
      hints.push(
        `[GATE: biết vùng_đau=${knownInfo.painArea}. ` +
          `Cấu trúc 2 câu: (1) nhắc KTV bên em đã xử lý nhiều ca tương tự, (2) hỏi 1 LẦN: 'Trước giờ ${state.honorific} có thử massage hay dán cao chưa ạ'. KHÔNG lặp ở turn sau.]`,
      );
    }
  }


  // ── GIẢI CƠ: evaluation — khách đã đồng ý + báo giờ → skip pitch (compact) ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null &&
    (intent === "selecting" || intent === "ready") &&
    knownInfo.preferredTime !== null
  ) {
    hints.push(
      `[GATE: khách đã xác nhận lịch ${knownInfo.preferredTime}. KHÔNG pitch lại, xin tên+SĐT để giữ slot.]`,
    );
  }
  // (Removed: giải cơ evaluation pitch GATE — đã có few-shot EXAMPLE với visualize + contrast + invite.)

  // ── COMMITMENT: chốt lịch (compact, 4 nhánh nội bộ) ──
  if (stage === "commitment") {
    const { name, phone } = knownInfo;
    const hasTime = knownInfo.preferredTime !== null;
    const qrShown = (state as any).qrShown ?? false;
    const prevAskedContact = state.lastBotReply
      ? /(cho\s+em\s+xin\s+tên|xin\s+tên\s+(với|và)\s+sđt|cho\s+em\s+xin\s+(tên|liên\s+hệ))/i.test(
          state.lastBotReply,
        )
      : false;

    let cmt: string;
    if (!name || !phone) {
      if (prevAskedContact) {
        cmt = "prev đã xin tên/SĐT mà khách chưa cho → answer câu khách hỏi rồi DỪNG, KHÔNG xin lại. Reply ≤150 chars.";
      } else if (!hasTime) {
        cmt = "CHƯA tên+SĐT+giờ → hỏi GỘP 1 câu: 'Cho em xin tên, SĐT với anh/chị muốn đến buổi sáng, chiều hay tối ạ'. KHÔNG nhắc giá/gói.";
      } else {
        cmt = `đã có giờ=${knownInfo.preferredTime} → chỉ xin tên+SĐT. KHÔNG hỏi lại buổi.`;
      }
    } else if (!hasTime) {
      cmt = "đã có tên/SĐT → hỏi giờ: 'Anh/chị đến buổi sáng, chiều hay tối ạ'.";
    } else if (!qrShown) {
      cmt = `ĐỦ INFO (tên=${name}, SĐT=${phone}, giờ=${knownInfo.preferredTime}). Xác nhận 1 câu: 'Em giữ slot [giờ] cho mình rồi nha ${state.honorific} [tên]' rồi DỪNG. ${knownInfo.preferredTime?.match(/\d{1,2}\/\d{1,2}/) ? "" : "Nếu chỉ có buổi → hỏi thêm ngày."}`;
    } else {
      cmt = "đã gửi QR. Xác nhận bước tiếp theo. DỪNG.";
    }
    hints.push(`[GATE commitment: ${cmt}]`);
  }

  return hints.join("\n");
}

// ─────────────────────────────────────────────
// KNOWLEDGE BLOCKS — inject theo stage, tránh thừa token
// ─────────────────────────────────────────────

function buildFitnessPricing(info: KnownInfo): string {
  const svc = info.serviceType;
  const mt = info.memberType;
  const goal = info.fitnessGoal;
  const lines: string[] = [];

  // Bậc thang ưu tiên: HS/SV / gia đình → áp riêng (override mọi goal-filter).
  if (mt === "hoc-sinh") {
    lines.push("  FULL HS/SV(14-22t, 4 dịch vụ): 1m=700k|3m=2tr|6m=3tr|12m=4tr ← anchor chính");
    if (!svc || svc === "gym") {
      lines.push("  PT: 10b=3tr|20b=5tr|20b(2m)=6tr (HLV 1-1)");
    }
    return `[PRICING:\n${lines.join("\n")}\n]`;
  }
  if (mt === "gia-dinh") {
    lines.push("  FULL gia đình (4 dịch vụ): 2ng=12tr|3ng=17tr|4ng=20tr ← anchor chính");
    lines.push("  FULL cá nhân: 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr");
    return `[PRICING:\n${lines.join("\n")}\n]`;
  }

  // ── Goal-based filter ──
  // Mục tiêu mạnh hơn serviceType khi pick anchor:
  //   giam-mo  → Full (cardio+gym) + Gym + PT (đốt mỡ nhanh). Bỏ Pilates/Yoga lẻ trừ khi svc=yoga.
  //   tang-co  → Gym + PT (xây cơ). Bỏ Yoga/Zumba/Bơi.
  //   thu-gian → Yoga/Zumba + Pilates. Bỏ Gym/PT trừ khi svc=gym.
  //   hoc-boi  → Học bơi + Bơi NL. Bỏ Gym/Yoga/Pilates.
  //   suc-khoe / null → Full + service đã chọn (nếu có).

  const showGym = goal === "giam-mo" || goal === "tang-co" || goal === "suc-khoe" || goal === null
    ? !svc || svc === "gym" || svc === "full"
    : svc === "gym";
  const showPT = goal === "giam-mo" || goal === "tang-co"
    ? !svc || svc === "gym" || svc === "full"
    : false;
  const showYogaZumba = goal === "thu-gian" || goal === "suc-khoe" || goal === null
    ? !svc || svc === "yoga" || svc === "zumba" || svc === "full"
    : svc === "yoga" || svc === "zumba";
  const showBoi = goal === "hoc-boi" || goal === "suc-khoe" || goal === null
    ? !svc || svc === "boi" || svc === "full"
    : svc === "boi";
  const showPilates = goal === "thu-gian" || goal === "tang-co" || goal === null
    ? svc === "pilates"
    : svc === "pilates";

  // Anchor "FULL 4 dịch vụ" — chỉ ưu tiên khi không phải single-service hard-lock.
  const fullIsAnchor =
    goal === "giam-mo" || goal === "suc-khoe" || goal === null;
  if (fullIsAnchor && (!svc || svc === "full" || svc === "gym")) {
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr ← anchor chính");
  }
  if (showGym) {
    lines.push("  Gym: fulltime-12m=5tr | 3b/t-12m=4.5tr | 3b/t-6m=2tr");
  }
  if (showPT) {
    lines.push("  PT: 10b=3tr|15b=4tr|20b=5tr | 20b(2m)=6tr|30b(2m)=8tr|40b(2m)=10tr | 50b(3m)=12tr");
  }
  if (showYogaZumba) {
    lines.push("  Yoga/Zumba: fulltime-12m=5.8tr | 3b/t-12m=4.5tr (GV Ấn Độ, 4 ca/ngày)");
  }
  if (showBoi) {
    lines.push("  Bơi NL: 1m=800k|3m=1.8tr|6m=3.5tr|12m(3b/t)=3tr|12m-full=5tr|24m=8.6tr");
    if (goal === "hoc-boi" || svc === "boi") {
      lines.push("  Bơi TE: 1m=600k|3m=1.2tr|6m=2.2tr|12m(3b/t)=2tr|12m-full=3tr");
      lines.push("  Học bơi: lớp(12b)=1.2tr+1m | TE-3m/NL-học+bơi=1.5tr | 1-1(12b)=3tr+3m | nhóm≥2=5tr/cặp+3m. Cam kết biết bơi.");
    }
  }
  if (showPilates) {
    lines.push("  Pilates thảm(1:7): 10b=1.5tr|20b=2.4tr|30b=3tr");
    lines.push("  Pilates máy(1:6): 10b=1.9tr|20b=3.6tr|30b=5.1tr");
    lines.push("  Pilates nhóm(1:3): 10b=3tr|20b=5.8tr|30b=8.1tr | Cá nhân(1:1): 10b=4.5tr|20b=8.6tr");
  }
  // Anchor "FULL" cho thư giãn / non-anchor case khi user vẫn cần thấy combo.
  if (!fullIsAnchor && (!svc || svc === "full") && lines.length === 0) {
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr");
  }
  if (lines.length === 0) {
    // Safety fallback — nếu filter quá khắt → show Full default
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr ← anchor chính");
  }
  return `[PRICING:\n${lines.join("\n")}\n]`;
}

function buildFitnessObjections(h: string): string {
  return `[OBJECTIONS:
  "Đắt quá" → Reframe bằng VALUE: "Full 7tr/12 tháng đi kèm phòng gym 700m2 máy chuẩn QT, bể bơi 4 mùa duy nhất Vĩnh Yên, Yoga & Zumba GV người Ấn Độ ${h}. Hội viên bên em hay gắn bó dài và rủ thêm bạn bè vào tập cùng — anh/chị qua thử 1 buổi cảm nhận thực tế nha". KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG giảm giá. Offer gói ngắn nếu vẫn từ chối.
  "Tập 1 môn" → "Thẻ Full chỉ hơn chút mà dùng cả 4 ${h} — tập 1 môn lâu chán, thêm Yoga/Bơi duy trì động lực"
  "Tháng lẻ thôi" → "Tháng lẻ 1.2tr ${h}, mà gói năm 7tr lại bảo lưu được khi bận và chuyển nhượng được trong gia đình — đa số chọn năm để chủ động hơn"
  "Chờ KM" → "Giá bên em xu hướng chỉ tăng ${h} — đợt này đang mức tốt nhất. Em giữ chỗ trước nha"
  "Chưa tin" → gọi get-media + "${h} qua tham quan — HLV đo Inbody miễn phí, xem số rồi chọn gói chuẩn luôn"
  "Xin thêm/quen sếp" → Trình bày đủ giá niêm yết, "đây là mức ưu đãi tốt nhất em áp dụng được" → chốt ngay]`;
}

function buildGiaiCoPricing(): string {
  return `[PRICING:
  Lẻ: Thải độc=100k|Spa Foot=200k|Full Foot=270k|Spa Body=280k|Full Body=330k|VIP2=380k|VIP1=420k
  Giải cơ lẻ: 45p(1-2v)=200k|75p=330k|CB1=330k|CB2=380k|CS-CB=380k|CS-VIP1=480k|CS-VIP2=590k
  ⚠️ Không nhận tip — KTV được trả công đầy đủ
  Liệu trình (ưu tiên tư vấn):
    VIP1×10=4.2tr(tặng 1→11b)⭐ | VIP1×20=8.4tr(tặng 3→23b)
    VIP2×10=3.8tr(tặng 1→11b)⭐ | VIP2×20=7.6tr(tặng 3→23b)
    Full Body×10=3.3tr(tặng 1→11b) | Full Body×20=6.6tr(tặng 3→23b)
  Anchor: CS-VIP2(590k)→CS-VIP1(480k)→CB1(330k). Ưu tiên chốt VIP2×10 = ~345k/buổi.]`;
}

function buildGiaiCoObjections(h: string): string {
  return `[OBJECTIONS:
  "Có đau không?" → "Sẽ có cảm giác 'đau đã' ở vùng bị tắc ${h} — đó là đúng điểm. KTV điều chỉnh lực theo ngưỡng. Sau đó hầu hết nói: 'Biết thế đến sớm hơn'"
  "Ê ẩm không?" → "Có thể ê nhẹ 1-2 ngày — như vừa tập gym về. Dấu hiệu tốt ${h}"
  "Giá cao hơn" → "KTV được đào tạo giải phẫu cơ bài bản ${h} — tác động đúng nhóm cơ. Trả cho kết quả bền vững"
  "Thoát vị đĩa đệm?" → "Được ${h} — KTV tránh trực tiếp cột sống, giải tỏa cơ xung quanh để giảm áp lực đĩa đệm"
  "Chấn thương TT" → Cấp tính: "Nghỉ 3-5 ngày rồi mình xử lý ${h}" | Mạn tính: "Đây chính xác là điều bên em làm tốt nhất ${h}"
  "Không có TG" → "75p/tuần thôi ${h} — cơ thể 'đình công' thật sự thì mọi công sức làm ra rất đáng tiếc"
  "Thử 1 buổi rồi tính" → "Hoàn toàn hợp lý ${h} — buổi đầu thường nhẹ 50-70% ngay. Em không ép"]`;
}

function buildKnowledgeBlock(
  state: ConversationState,
  h: string,
  message?: string,
  prevBotReply?: string,
): string {
  const { stage, flow, knownInfo, intent } = state;

  // Show pricing khi cần: discovery+hỏi giá, evaluation, negotiation, hoặc objection.
  // KHÔNG show khi:
  //  - commitment đã đủ tên+SĐT+giờ (tránh bot pitch khi đã chốt)
  //  - prevBotReply đã list giá (tránh bot lặp pitch package list)
  const askingPrice = message ? detectPriceQuestion(message) : false;
  const objectingPrice = message ? detectPriceObjection(message) : false;
  const fullCommitInfo =
    stage === "commitment" &&
    !!knownInfo.name &&
    !!knownInfo.phone &&
    !!knownInfo.preferredTime;

  // Detect tin trước có pitch package (≥ 2 con số giá kèm "tr"/"k")
  const prevHadPricing = prevBotReply
    ? /\d+\s*(tr|triệu|k)\b.*?\d+\s*(tr|triệu|k)\b/i.test(prevBotReply)
    : false;

  const showPricing =
    !fullCommitInfo &&
    !prevHadPricing &&
    (stage === "evaluation" ||
      stage === "negotiation" ||
      (stage === "commitment" && (!knownInfo.name || !knownInfo.phone)) ||
      intent === "compare" ||
      askingPrice ||
      objectingPrice);

  const showObjHandling =
    stage === "objection" || stage === "negotiation" || objectingPrice;

  const blocks: string[] = [];

  if (flow === "fitness") {
    if (stage === "opening" || stage === "discovery") {
      blocks.push(
        `[CENTER: Fami Fitness & Yoga Center Vĩnh Yên | 05:00–20:00 | Thành lập 2014\n` +
        `  Bơi → Bể 4 mùa 350m2 DUY NHẤT Vĩnh Yên, nước nóng quanh năm, lọc ozone\n` +
        `  Gym → 700m2 trong nhà + 300m2 ngoài có mái che, chứa 100 người\n` +
        `  Yoga/Zumba → GV người Ấn Độ chuyên nghiệp, 4 ca/ngày\n` +
        `  Pilates → 13 máy chuẩn quốc tế, GV chứng chỉ QT (từ 12/2024)]`,
      );
    }
    if (showPricing) blocks.push(buildFitnessPricing(knownInfo));
    if (showObjHandling) blocks.push(buildFitnessObjections(h));
  }

  if (flow === "giai-co") {
    if (stage === "opening" || stage === "discovery") {
      blocks.push(
        `[CENTER: TT Chăm sóc Sức khỏe Hoa Sen | 09:00–23:00 | Thành lập 08/2018\n` +
        `  17 phòng | 4 KTV giải cơ chuyên sâu + 15 KTV massage\n` +
        `  Dịch vụ: giải cơ chuyên sâu, massage, spa, tắm thuốc, gội đầu, chăm sóc da]`,
      );
    }
    if (showPricing) blocks.push(buildGiaiCoPricing());
    if (showObjHandling) blocks.push(buildGiaiCoObjections(h));
  }

  if (blocks.length === 0) return "";
  return `[KNOWLEDGE:\n${blocks.join("\n")}\n]`;
}

// ─────────────────────────────────────────────
// FEW-SHOT EXAMPLES
// ─────────────────────────────────────────────

function buildFewShot(
  state: ConversationState,
  h: string,
  prevBotReply?: string,
  message?: string,
): string | null {
  // Skip EXAMPLE khi prev reply đã pitch giá — tránh bot lặp 3 gói (chỉ ở evaluation)
  const prevHadPricing = prevBotReply
    ? /\d+\s*(tr|triệu|k)\b.*?\d+\s*(tr|triệu|k)\b/i.test(prevBotReply)
    : false;
  if (prevHadPricing && state.stage === "evaluation") {
    return `[EXAMPLE — đã pitch giá tin trước → tin này KHÔNG list lại 3 gói. Tối đa nhắc 1 gói + chuyển sang câu hỏi chốt giờ. Reply ≤ 150 ký tự.]`;
  }

  // ── KHÁCH HỎI GIÁ lần đầu (chưa có goal cụ thể) — Fami trial-first close ──
  // Phong cách Fami: nói giá "ưu đãi chỉ từ Xk/tháng" → MỜI TRẢI NGHIỆM THỬ trước khi bung gói
  if (
    state.flow === "fitness" &&
    !prevHadPricing &&
    message &&
    detectPriceQuestion(message) &&
    state.knownInfo.fitnessGoal === null
  ) {
    return `[EXAMPLE — KHÁCH HỎI GIÁ lần đầu (chưa có goal): TRIAL-FIRST CLOSE phong cách Fami]
Khách: "bao nhiêu tiền/tháng" / "giá thế nào" / "có ưu đãi gì không"
ĐÚNG (chọn 1):
  (a) "Dạ hiện tại bên em có rất nhiều ưu đãi chỉ từ 333k/tháng ${h}. Vì ${h} là người mới, em tặng ${h} chương trình trải nghiệm thử để xem có phù hợp không. ${h} có muốn đăng ký trải nghiệm không ạ?"
  (b) "Dạ trung tâm mở từ 5h–20h30, giá ưu đãi chỉ từ 333k/tháng. Không biết ${h} đang quan tâm bộ môn nào để em tư vấn gói phù hợp ạ?"
SAI: bung 3 gói chi tiết ngay; pitch InBody; hỏi 'tập để làm gì' (quá direct).
NGUYÊN TẮC: nói giá ƯU ĐÃI chung chung → MỜI trải nghiệm → khách đồng ý mới bung gói cụ thể.`;
  }

  // ── DISCOVERY + khách hỏi giá LẦN 2 sau khi bot đã pitch giá ──
  // Trường hợp này hay xảy ra: khách "chi phí cao quá" / "nói rõ ra" / "có gói nào khác".
  // Bot phải pivot — ack → đào sâu 1 gói cụ thể HOẶC mời InBody, KHÔNG list lại 3 gói.
  if (
    state.flow === "fitness" &&
    state.stage === "discovery" &&
    prevHadPricing &&
    message &&
    detectPriceQuestion(message)
  ) {
    return `[EXAMPLE — KHÁCH HỎI GIÁ LẦN 2 / "NÓI RÕ RA" — KHÔNG repeat 3 gói cũ]
Khách: "chi phí như nào nói rõ ra" / "gói nào rẻ nhất" / "còn gói khác không"
ĐÚNG (chọn 1 hướng, ngắn ≤ 150 ký tự):
  (a) Đào sâu 1 gói: "Dạ rẻ nhất là Gym 3 buổi/tuần 12 tháng 4.5tr ${h}, chia ra ~375k/tháng — phù hợp nếu ${h} chỉ tập gym tự."
  (b) Mời thử miễn phí: "Dạ ${h} qua đo InBody miễn phí trước, HLV xem mỡ/cơ rồi mới chọn gói chuẩn — ${h} tiện sáng hay chiều ạ?"
  (c) Hỏi schedule: "Dạ ${h} tập mấy buổi 1 tuần để em chọn đúng gói tiết kiệm nhất ạ?"
SAI: list lại "Gym 5tr | Full 7tr"; lặp y câu cũ; nói chung chung "tùy gói".`;
  }

  // ── DISCOVERY + khách hỏi nhóm vs cá nhân / nhóm có rẻ hơn ──
  if (
    state.flow === "fitness" &&
    state.stage === "discovery" &&
    message &&
    /(nhóm|cá\s*nhân|tập\s*riêng|tập\s*chung)/i.test(message) &&
    /(rẻ|giá|chi\s*phí|bao\s*nhiêu|khác|hơn)/i.test(message)
  ) {
    return `[EXAMPLE — KHÁCH HỎI NHÓM VS CÁ NHÂN — phải có CON SỐ CỤ THỂ]
Khách: "nhóm có rẻ hơn không" / "tập nhóm với cá nhân khác gì"
ĐÚNG (kèm con số, không generic):
  "Dạ có ${h} — gym tập chung ai cũng tự tập như nhau, gói 3 buổi/tuần 12 tháng 4.5tr.
   PT 1-1 thì kèm sát hơn, 20 buổi 5tr (~250k/buổi), HLV chỉnh kỹ thuật từng động tác.
   ${h} đang muốn nhanh thấy kết quả hay tiết kiệm hơn ạ?"
SAI: "nhóm thường rẻ hơn cá nhân ạ" (mơ hồ, không số);
     hỏi tiếp "muốn tham gia nhóm hay tập riêng" mà chưa cho khách thấy chênh lệch.`;
  }

  const { stage, intent, flow, knownInfo } = state;

  // ── FITNESS: OPENING — phong cách Fami: hỏi bộ môn quan tâm trước, KHÔNG list ngay ──
  if (
    flow === "fitness" &&
    stage === "opening" &&
    knownInfo.serviceType === null &&
    knownInfo.fitnessGoal === null
  ) {
    return `[EXAMPLE — OPENING phong cách Fami: chào ấm áp, HỎI quan tâm trước]
Khách: "alo" / "quan tâm" / "có gì không"
ĐÚNG (chọn 1, ngắn 1-2 câu):
  (a) "Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ?"
  (b) "Dạ em chào ${h}, bên em là Tổ hợp thể thao có Gym, Yoga, Zumba và Bơi. Phòng tập mở từ 5h–20h30 ạ. Không biết ${h} đi tập được khung giờ nào để em hỗ trợ tư vấn?"
SAI: list ngay 4 dịch vụ + mục tiêu trong tin chào → quá nhiều thông tin, mất "câu hỏi mở".`;
  }

  // ── FITNESS: hỏi dịch vụ/giá chung khi chưa biết loại ──
  if (
    flow === "fitness" &&
    intent === "compare" &&
    knownInfo.serviceType === null
  ) {
    return `[EXAMPLE — ANSWER FIRST + BUILD INTEREST]
Khách: "bên mình có gói gì / giá bao nhiêu"
Em: "Fami có 4 dịch vụ chính ${h}, điểm đặc biệt là dùng chung 1 thẻ:
     Bơi — bể 4 mùa duy nhất Vĩnh Yên, nước nóng quanh năm
     Gym — 700m2 trong nhà + sân ngoài, chứa 100 người cùng lúc
     Yoga & Zumba — GV người Ấn Độ chuyên nghiệp, 4 ca/ngày
     Pilates — 13 máy chuẩn quốc tế (mới mở 12/2024)
     Thẻ Full cả 4 dịch vụ từ 1.2tr/tháng ${h}.
     ${h} đang muốn tập để đạt mục tiêu gì để em gợi gói chuẩn nha"`;
  }

  // ── FITNESS: biết dịch vụ + mục tiêu, đang discovery → xác nhận + hỏi schedule ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal !== null &&
    knownInfo.schedule === null
  ) {
    const svc = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal;
    return `[EXAMPLE — TIN ĐẦU: 1 CÂU HỎI SCHEDULE, KHÔNG KHEN, KHÔNG GIỚI THIỆU, KHÔNG GIÁ]
Khách: "mình muốn tập ${svc} ${goal}"
ĐÚNG: "${h} tập mấy buổi một tuần?" hoặc "${h} hay tập sáng hay chiều tối hơn?"
SAI: "Tuyệt vời!", "Dạ, tập Gym để giảm mỡ là hợp lý...", giới thiệu cơ sở, list gói/giá.`;
  }

  // ── FITNESS: KH muốn giảm cân nhưng chưa chọn môn — Fami pitch giải pháp Gym+Zumba+Bơi ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.fitnessGoal === "giam-mo" &&
    knownInfo.serviceType === null
  ) {
    // Turn đầu (turnCount<=1): hỏi history theo TL Fami
    // Turn sau: pitch giải pháp Gym + Zumba (+Bơi)
    if (state.turnCount <= 1 || !prevBotReply) {
      return `[EXAMPLE — giảm cân lần đầu: HỎI HISTORY trước, KHÔNG pitch ngay]
"Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. Không biết ${h} có đang tập luyện hay sử dụng biện pháp giảm cân nào không ạ?"`;
    }
    return `[EXAMPLE — giảm cân (đã qua hỏi history): PITCH GIẢI PHÁP Gym+Zumba+Bơi theo TL Fami]
"Dạ với giảm cân, em khuyến khích ${h} kết hợp Gym và Zumba ạ. Nếu ${h} thích Bơi, có thể kết hợp thêm Bơi. 3 bộ môn này đều đốt calo và săn chắc cơ thể, kết hợp với nhau sẽ đạt mục tiêu nhanh hơn. Zumba còn xả stress, giúp ${h} có động lực duy trì lâu dài. ${h} có muốn thử 1 buổi để cảm nhận không ạ?"
⚠️ KHÔNG pitch 3 gói số giá vào lúc này — chỉ recommend giải pháp. Khách hỏi giá mới bung.`;
  }

  // ── FITNESS: biết dịch vụ, chưa có mục tiêu — phong cách Fami: hỏi DEEP, không pitch ngay ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal === null
  ) {
    const svc = knownInfo.serviceType;
    // Per-service discovery question theo tone Fami thực tế.
    const discoveryByService: Record<string, string> = {
      gym: `"Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến bộ môn gym của trung tâm. Không biết ${h} đã tập gym bao giờ chưa ạ?"\n(Turn sau hỏi: "Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ?")`,
      yoga: `"Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập yoga chưa ạ?"\n(Nếu chưa tập: trấn an "Yoga là chuỗi các động tác bắt đầu từ hơi thở, động tác chậm có HLV hướng dẫn nên ${h} hoàn toàn yên tâm tập được ở lớp cộng đồng kể cả người mới ạ".)`,
      zumba: `"Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập zumba chưa ạ?"\n(Nếu chưa tập: "Zumba là quá trình rèn luyện, ${h} yên tâm đừng lo không theo được — vào lớp cô giáo sẽ hỗ trợ trong giờ giải lao. Bài mới cô hướng dẫn từng đoạn ạ".)`,
      boi: `"Dạ em chào ${h}, không biết ${h} đang quan tâm học bơi cho người lớn hay trẻ em ạ?"\n(Nếu trẻ em: hỏi "Bên em nhận từ 6 tuổi, bạn nhà mình năm nay mấy tuổi rồi ạ?" + test bạo nước "Ở nhà bé có dám ngụp nước/tắm vòi sen không ạ?")`,
      pilates: `"Dạ em chào ${h}, Pilates bên em có 13 máy chuẩn quốc tế ${h} ơi. Trước đây ${h} đã tập pilates hay yoga gì chưa ạ?"`,
      full: `"Dạ em chào ${h}, bên em là Tổ hợp thể thao Gym + Yoga + Zumba + Bơi. ${h} ơi trước đây mình đã tập bộ môn nào chưa ạ? Hay có yêu thích bộ môn nào không?"`,
    };
    const example = discoveryByService[svc] ??
      `"Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến ${svc} của trung tâm. Trước đây ${h} đã tập ${svc} chưa ạ?"`;
    return `[EXAMPLE — DISCOVERY phong cách Fami: hỏi 1 CÂU sâu, KHÔNG pitch gói/giá]
Khách: "muốn đăng ký ${svc}" / "cho hỏi lớp ${svc}"
ĐÚNG:
${example}
SAI: "Tuyệt vời!", list gói/giá, list nhiều câu hỏi gộp.`;
  }

  // ── FITNESS: inbody pitch — few-shot ──
  if (flow === "fitness" && stage === "inbody") {
    const goal = knownInfo.fitnessGoal ?? "mục tiêu";
    return `[EXAMPLE — INBODY PITCH: text thuần, KHÔNG **bold**, KHÔNG giá/gói]
1 message = xác nhận lịch ngắn + pitch Inbody + câu mời. KHÔNG kèm bất cứ gì khác.

SAI: "Với lịch X, ${h} có thể chọn Full 12 tháng 7tr..."  ← nhảy gói
ĐÚNG: "Dạ, để ${goal} hiệu quả thì cần kết hợp tập luyện đúng hướng ${h}. Bên em đo InBody miễn phí lần đầu, HLV phân tích tỷ lệ mỡ cơ rồi tư vấn lộ trình chuẩn luôn. ${h} qua thử 1 buổi cho dễ chọn gói nha"`;
  }

  // ── FITNESS: đang evaluation → show gói có narrative ──
  if (
    flow === "fitness" &&
    stage === "evaluation" &&
    knownInfo.serviceType !== null
  ) {
    const svc = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal ?? "sức khỏe tổng thể";

    // Goal-specific value hint
    const goalHint: Record<string, string> = {
      "tang-co": `Tăng cơ cần tập có hệ thống + kỹ thuật đúng giai đoạn đầu → nhấn PT cá nhân, cộng thêm Yoga/Pilates để phục hồi cơ. KHÔNG chỉ nhấn diện tích phòng.`,
      "giam-mo": `Giảm mỡ hiệu quả = cardio + weight training kết hợp → nhấn thẻ Full (Gym + Zumba/Bơi dùng chung), bể bơi 4 mùa duy nhất Vĩnh Yên. KHÔNG chỉ nhấn diện tích phòng.`,
      "thu-gian": `Thư giãn → nhấn Yoga GV Ấn Độ 4 ca/ngày linh hoạt lịch + không gian rộng không chen chúc.`,
      "hoc-boi": `Học bơi → nhấn bể 4 mùa duy nhất Vĩnh Yên + cam kết biết bơi sau khóa (học lại miễn phí).`,
      "suc-khoe": `Sức khỏe tổng thể → nhấn thẻ Full 4 dịch vụ trong 1 thẻ, dùng cả năm bảo lưu được khi bận.`,
    };
    const specificHint =
      goalHint[goal] ??
      `Nhấn điểm khác biệt cụ thể của ${svc} phù hợp mục tiêu ${goal}.`;

    // Concrete package examples per goal — correct anchor order: high → mid → light
    const goalPackages: Record<string, string> = {
      "giam-mo":
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 kèm sát, đốt mỡ nhanh + đúng kỹ thuật\n` +
        `Full 12 tháng 7tr — Gym + Bơi/Zumba 1 thẻ, cardio + weight đa năng\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — tự tập, tiết kiệm`,
      "tang-co":
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 xây kỹ thuật nền đúng, tránh chấn thương\n` +
        `Full 12 tháng 7tr — Gym + Yoga/Pilates phục hồi cơ trong 1 thẻ\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — tự tập theo lịch dài hơi`,
      "thu-gian":
        `Full 12 tháng 7tr — Gym + Yoga + Zumba + Bơi trong 1 thẻ\n` +
        `Yoga/Zumba fulltime 12 tháng 5.8tr — không giới hạn ca, GV Ấn Độ 4 ca/ngày\n` +
        `Yoga/Zumba 3 buổi/tuần 12 tháng 4.5tr — lịch cố định 3 buổi/tuần`,
      "hoc-boi":
        `Học bơi 1-1 (12 buổi) 3tr + 3 tháng bể — HLV riêng, cam kết biết bơi, học lại miễn phí\n` +
        `Học bơi lớp nhóm (12 buổi) 1.2tr + 1 tháng bể — lớp nhỏ, tiết kiệm hơn\n` +
        `Bơi NL fulltime 12 tháng 5tr — sau khi biết bơi, tập tự do cả năm`,
      "suc-khoe":
        `Full 12 tháng 7tr — Gym + Bơi + Yoga + Zumba 1 thẻ, toàn diện nhất\n` +
        `Full 6 tháng 4.5tr — đủ 4 dịch vụ, thử 6 tháng trước\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — chỉ gym nếu muốn đơn giản`,
    };
    const concretePackages =
      goalPackages[goal] ??
      `[gói cao nhất] [giá] — [lý do gắn ${goal}]\n[gói vừa] [giá] — [lý do]\n[gói nhẹ nhất] [giá] — thử trước`;

    // Pitch 3 gói anchor đa dạng (cao→vừa→nhẹ) — khách thấy nhiều choice dễ chọn theo budget
    return `[EXAMPLE — Reply ≤ 320 ký tự. Value 1 câu + 3 GÓI ANCHOR + câu hỏi chốt]
Value cụ thể: ${specificHint}
Gói (giá thật, thứ tự cao→vừa→nhẹ):
${concretePackages}
Mẫu reply: "[1 câu value]. Bên em có mấy hướng cho ${h}: [3 gói trên]. ${h} tiện ghé InBody buổi sáng hay chiều để HLV thiết kế lộ trình nha"
⚠️ MỖI gói PHẢI có giá. KHÔNG hỏi lại nhu cầu/giờ đã có trong [KNOWN].`;
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea === null
  ) {
    return `[EXAMPLE — ANSWER FIRST + DẪN DẮT TÂM LÝ]
Khách: "giải cơ là gì / giá bao nhiêu"
Em: "Giải cơ chuyên sâu khác massage thông thường ${h} —
     không phải vuốt bề mặt mà tháo từng nút thắt bên trong cơ (Trigger Points),
     nên hiệu quả bền hơn thay vì thư giãn tạm thời.
     Giá từ 200k (45 phút, 1-2 vùng) đến 590k (CS-VIP 2 kèm tắm thuốc + xông).
     ${h} đang cảm thấy đau mỏi vùng nào nhiều nhất để em tư vấn đúng gói nha"`;
  }

  // ── GIẢI CƠ: evaluation — visualize + contrast + invite 1 buổi ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null
  ) {
    const pain = knownInfo.painArea;
    const method = knownInfo.pastMethod;
    const duration = knownInfo.painDuration;

    // Contrast text dựa trên pastMethod
    const contrastMap: Record<string, string> = {
      massage: `Massage làm mềm bề mặt nhất thời — nút thắt sâu vẫn còn, đó là lý do đỡ rồi lại đau lại ${h}.`,
      thuoc: `Thuốc giảm viêm bề mặt nhưng không gỡ được điểm kích hoạt bên trong — hết thuốc là đau lại ${h}.`,
      "vat-ly-tri-lieu": `Vật lý trị liệu thông thường tác động vào khớp nhiều hơn — với cơ bị xơ cứng thì cần vào sâu lớp cơ hơn ${h}.`,
      "chua-thu": `Cơ thể ${h} chưa được xử lý gốc lần nào — đây là thời điểm phù hợp để gỡ trước khi xơ hóa nặng hơn.`,
    };
    const contrastText = method
      ? (contrastMap[method] ??
        `Phương pháp trước chỉ xử lý bề mặt — giải cơ chuyên sâu đi vào tận lớp cơ sâu ${h}.`)
      : `Đau ${pain} kiểu này thường là nút thắt đã bắt đầu xơ hóa — massage bề mặt không gỡ được ${h}.`;

    const preferredTime = knownInfo.preferredTime;
    const hasContact = knownInfo.name !== null && knownInfo.phone !== null;
    // Tách thành 2 bước để không gộp giờ + tên + SĐT trong cùng 1 câu (dồn dập, dễ scare khách).
    // Bước 1: chỉ hỏi giờ. Bước 2: khi khách chốt giờ rồi, mới xin tên + SĐT.
    const closingLine = hasContact
      ? `Dạ em giữ slot ${preferredTime ?? "..."} cho mình rồi nha ${h} ${knownInfo.name}, hẹn gặp ${h} ạ`
      : preferredTime
        ? `Để em giữ slot ${preferredTime} cho ${h}, ${h} cho em xin tên với SĐT để em note nha`
        : `${h} tiện khung sáng hay chiều ạ`;

    const timeNote = preferredTime
      ? `ĐÃ BIẾT giờ=${preferredTime} → KHÔNG hỏi giờ lại, kết bằng xin tên/SĐT.`
      : "Chưa có giờ → CHỈ hỏi giờ (sáng/chiều), KHÔNG xin tên/SĐT cùng lúc — đợi khách chốt giờ rồi turn sau mới xin liên hệ.";
    const visualHint =
      pain.includes("vai") || pain.includes("co")
        ? "vùng cổ vai sẽ nhẹ hơn, đỡ cứng khựng"
        : "cảm giác đau âm ỉ cũng dịu rõ hơn";
    return `[EXAMPLE — GIẢI CƠ EVALUATION: VISUALIZE → CONTRAST → VIỄN CẢNH → MỜI 1 BUỔI]
⚠️ Không show bảng 3 gói. Text thuần, không markdown. ${timeNote}
⚠️ Quyết định gửi ảnh xem [MEDIA] block — nếu thấy moment phù hợp (khách đang phân vân, cần thêm trust)
   thì gọi get-media với suggestedKey. Nếu khách đã rõ ràng/đang chốt → bỏ qua, gửi text thôi.

SAI: "em gửi hình để dễ hình dung nha" (hỏi thay vì chủ động gửi nếu đã quyết gửi);
     "em gợi CS-VIP 2 × 10 buổi 3.8tr..." (bán gói sớm);
     hỏi lại giờ khi đã có.

ĐÚNG (text response, có hoặc không kèm media tùy moment):
"Dạ, vùng ${pain}${duration ? ` đã ${duration}` : ""} như ${h} mô tả thường giống một nút thắt bị kẹt trong cơ ạ. ${contrastText}
Khi xử lý đúng điểm đó thì sáng dậy ${visualHint} ${h}.
Bên em có KTV chuyên giải cơ chuyên sâu, ${h} có thể thử 1 buổi trước để cảm nhận thực tế. ${closingLine}"`;
  }

  // ── GIẢI CƠ / FITNESS: commitment — hỏi GỘP 3 thứ, xác nhận và dừng ──
  if (stage === "commitment") {
    return `[EXAMPLE — COMMITMENT: HỎI GỘP → XÁC NHẬN → DỪNG]
⚠️ Không lặp "KTV đánh giá thực tế / tư vấn lộ trình". Không đẩy QR trừ khi khách hỏi.

CHƯA đủ 3 (tên+SĐT+giờ):
ĐÚNG: "Cho em xin tên, SĐT với ${h} muốn đến buổi sáng, chiều hay tối ạ"
SAI:  thiếu giờ; xác nhận khi chưa có tên/SĐT.

ĐÃ đủ 3:
ĐÚNG: "Dạ em giữ slot [giờ] cho mình rồi nha ${h} [tên], hẹn gặp ${h} ạ" → DỪNG HẲN.
SAI:  hỏi thêm "cọc trước không".`;
  }

  return null;
}

// ─────────────────────────────────────────────
// KNOWN INFO SUMMARY
// ─────────────────────────────────────────────

function buildKnownSummary(info: KnownInfo, flow: Flow): string {
  const parts: string[] = [];

  if (info.name !== null) parts.push(`tên=${info.name}`);
  if (info.phone !== null) parts.push(`sđt=${info.phone}`);

  if (flow === "fitness") {
    if (info.serviceType !== null) parts.push(`dịch-vụ=${info.serviceType}`);
    if (info.fitnessGoal !== null) parts.push(`mục-tiêu=${info.fitnessGoal}`);
    if (info.memberType !== null)
      parts.push(`loại-thành-viên=${info.memberType}`);
    if (info.durationMonths !== null)
      parts.push(`thời-hạn=${info.durationMonths}tháng`);
    if (info.schedule !== null) parts.push(`lịch=${info.schedule}`);
  } else {
    if (info.painArea !== null) parts.push(`vùng-đau=${info.painArea}`);
    if (info.painSpread !== null) parts.push(`lan-toa=${info.painSpread}`);
    if (info.painDuration !== null)
      parts.push(`đau-bao-lâu=${info.painDuration}`);
    if (info.pastMethod !== null) parts.push(`đã-thử=${info.pastMethod}`);
    if (info.sessionPackage !== null) parts.push(`gói=${info.sessionPackage}`);
    if (info.preferredTime !== null)
      parts.push(`giờ-muốn=${info.preferredTime}`);
  }

  return parts.length > 0 ? `[KNOWN: ${parts.join(", ")}]` : "";
}

// ─────────────────────────────────────────────
// MISSING SLOTS HINT
// ─────────────────────────────────────────────

function buildMissingSlotHint(
  info: KnownInfo,
  flow: Flow,
  intent: Intent,
  stage: Stage,
): string {
  const missing: string[] = [];

  if (flow === "fitness") {
    // serviceType chỉ bắt buộc khi CHƯA có goal — khi đã có goal, bot tự RECOMMEND
    // dựa trên goal (giảm-mỡ → Gym/Cardio, tăng-cơ → Gym+PT, thư-giãn → Yoga, ...).
    // Re-ask "muốn gym hay yoga" sau khi đã pitch là sai (mất commitment).
    if (info.serviceType === null && info.fitnessGoal === null) {
      missing.push("serviceType");
    }
    // fitnessGoal chỉ bắt buộc ở discovery khi intent=explore
    if (
      info.fitnessGoal === null &&
      info.serviceType === null &&
      stage === "discovery" &&
      intent === "explore"
    ) {
      missing.push("fitnessGoal");
    }
    if (info.durationMonths === null && stage === "commitment")
      missing.push("durationMonths");
  } else {
    if (info.painArea === null) missing.push("painArea");
    if (info.painSpread === null && stage === "discovery")
      missing.push("painSpread");
    if (info.painDuration === null && stage === "discovery")
      missing.push("painDuration");
    // pastMethod là slot bắt buộc ở discovery — phải có trước khi sang evaluation
    if (
      info.pastMethod === null &&
      (stage === "discovery" || stage === "evaluation")
    ) {
      missing.push("pastMethod");
    }
    if (info.sessionPackage === null && stage === "commitment")
      missing.push("sessionPackage");
  }

  if (missing.length === 0) return "[SLOTS: đủ thông tin cần thiết]";

  if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
    return `[SLOTS_MISSING: ${missing.join(", ")} — ANSWER câu hỏi khách TRƯỚC, hỏi slot SAU ở cuối response]`;
  }

  return `[SLOTS_MISSING: ${missing.join(", ")} — hỏi 1 slot quan trọng nhất TRƯỚC]`;
}

// ─────────────────────────────────────────────
// MAIN PREFIX BUILDER
// ─────────────────────────────────────────────

export function buildPrefix(
  state: ConversationState,
  message?: string,
  prevBotReply?: string,
): string {
  const h = resolveHonorific(state.honorific);

  // ─── QUESTION FLOW DECISION (ưu tiên cao nhất) ───
  // Nếu match 1 trong các pattern của TL Fami → return 1 ANSWER_LOCK duy nhất,
  // bypass tất cả GATE / few-shot / TACTIC khác. gpt-4o-mini cần ít context để
  // output đúng template.
  if (state.flow === "fitness" && message) {
    const decision = decideFitnessQuestion(state, message, prevBotReply);
    if (decision) {
      console.log(`[questionFlow] decision=${decision.id}`);
      const lines: string[] = [
        `[HON: ${h}] [STAGE: ${state.stage}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
        `[TACTIC: ƯU TIÊN ANSWER_LOCK ở dưới — viết theo template, KHÔNG pitch/list/nhảy chủ đề khác.]`,
        `[RULES: Text thuần, KHÔNG markdown, KHÔNG link [text](url). Câu mềm, MAX 1 câu hỏi/reply. Câu hỏi kết bằng "ạ?" hoặc "?". 2 câu kết "ạ" liên tiếp PHẢI có dấu "." giữa. CẤM khen đáp án khách. CẤM "tuyệt vời/quá/chắc chắn rồi". CẤM "nha?".]`,
        buildKnownSummary(state.knownInfo, state.flow),
        formatDecision(decision),
      ];
      return lines.filter(Boolean).join("\n");
    }
  }

  let tactic = getTactic(state.flow, state.stage, state.emotion);

  // Override TACTIC khi khách đã chấp nhận ở negotiation
  if (
    state.stage === "negotiation" &&
    (state.intent === "selecting" || state.intent === "ready")
  ) {
    tactic =
      "Khách đã chấp nhận. KHÔNG pitch giá/gói/lý do mua nữa. " +
      "Hỏi gộp 1 câu ngắn: tên + SĐT + sáng/chiều/tối (bỏ phần thiếu nếu đã có). " +
      "Giọng nhẹ, không khen giả.";
  }

  // Override TACTIC khi commitment đã đủ tên+SĐT+giờ
  if (
    state.stage === "commitment" &&
    state.knownInfo.name &&
    state.knownInfo.phone &&
    state.knownInfo.preferredTime
  ) {
    tactic =
      `Khách đã đủ tên=${state.knownInfo.name}, SĐT=${state.knownInfo.phone}, giờ=${state.knownInfo.preferredTime}. ` +
      `Reply NGẮN 1 câu xác nhận: 'Dạ em giữ slot [giờ] cho mình rồi nha ${h} ${state.knownInfo.name}, hẹn gặp ${h} ạ' rồi DỪNG HẲN. ` +
      "TUYỆT ĐỐI KHÔNG hỏi gộp lại tên/SĐT/giờ. KHÔNG gợi cọc/QR.";
  }

  // Override TACTIC khi khách lạnh (thôi/tham khảo/để mai/chưa quyết) — KHÔNG xin info
  if (message && detectColdLead(message)) {
    tactic =
      "Khách đang lạnh / muốn tham khảo thêm. Reply CHỈ 1 câu LÙI nhẹ: " +
      "'Dạ vâng nha anh/chị, anh/chị cứ tham khảo thoải mái, có gì cần em sẵn sàng tư vấn thêm ạ.' rồi DỪNG. " +
      "❌ TUYỆT ĐỐI KHÔNG xin tên/SĐT/giờ trong tin này. KHÔNG pitch gói. KHÔNG nhắc giá.";
  }

  // Override TACTIC: khách hỏi LỊCH LỚP (lịch học bơi, lịch yoga, lịch các bộ môn)
  // → KHÔNG trả bằng bảng giá. Áp dụng cho mọi stage fitness.
  if (
    state.flow === "fitness" &&
    message &&
    detectClassScheduleQuestion(message) &&
    !detectPriceQuestion(message)
  ) {
    tactic =
      "Khách hỏi LỊCH LỚP (không phải hỏi giá). ❌ TUYỆT ĐỐI KHÔNG trả bằng bảng giá / không list 3 gói. " +
      "Trả lịch sơ bộ: 'Yoga & Zumba có 4 ca/ngày (sáng-trưa-chiều-tối), Bơi mở 5h–20h, Gym mở 5h–20h ạ. " +
      "Lịch chi tiết từng lớp em check lại gửi anh/chị, hoặc anh/chị ghé trực tiếp xem lịch dán tại quầy lễ tân nha'. " +
      "Câu kết 1 câu hỏi nhẹ về buổi tiện đi (sáng/chiều/tối) để gợi ca phù hợp. KHÔNG đẩy InBody, KHÔNG báo giá.";
  }
  // Override TACTIC discovery cho 3 trường hợp đặc biệt
  else if (state.stage === "discovery" && state.flow === "fitness") {
    // (a) Khách bảo "chỉ tập X" → ack + hỏi schedule, không hỏi mục tiêu, không ép Full
    if (
      message &&
      /(chỉ|chỉ\s+tập|chỉ\s+cần|chỉ\s+muốn)\s+(yoga|zumba|bơi|gym|pilates)/i.test(
        message,
      )
    ) {
      const svc = state.knownInfo.serviceType ?? "yoga";
      tactic =
        `Khách CHỈ muốn ${svc}. Ack ngắn (${svc} GV Ấn Độ 4 ca/ngày) + hỏi schedule "tiện sáng hay chiều tối". ❌ KHÔNG hỏi mục tiêu, KHÔNG ép gói Full, KHÔNG nhắc InBody.`;
    }
    // (b) Khách cần PT 1-1 → pitch PT thẳng, không hỏi gym/yoga
    else if (message && detectPTNeed(message)) {
      const honor = state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
      tactic =
        `Khách cần PT 1-1. Pitch THẲNG: "PT 20 buổi 2 tháng 6tr, HLV 1-1 xây kỹ thuật nền tránh chấn thương ${honor}". Câu kết: "tiện ghé đo InBody hôm nào ạ". ❌ KHÔNG hỏi "muốn gym hay yoga".`;
    }
    // (c1) Khách hỏi giá explicit ("báo giá", "chi phí", "bao nhiêu") → show pricing NGAY,
    // không loop hỏi serviceType/goal nữa. Map theo goal đã có (hoặc Full default).
    else if (message && detectPriceQuestion(message)) {
      // Detect prev đã pitch giá (≥2 con số tiền) → khách hỏi LẦN 2 → KHÔNG repeat pitch,
      // pivot sang đào sâu / mời ghé thử / hỏi schedule cụ thể.
      const prevHadPricing = prevBotReply
        ? /\d+\s*(tr|triệu|k)\b.*?\d+\s*(tr|triệu|k)\b/i.test(prevBotReply)
        : false;
      if (prevHadPricing) {
        tactic =
          "Khách hỏi giá NHƯNG bot đã pitch 2+ mức giá ở tin trước rồi. ❌ TUYỆT ĐỐI KHÔNG list lại 3 gói/giá cũ. " +
          "Pivot sang 1 trong 3 hướng (chọn 1, KHÔNG làm cả 3): " +
          "(a) ĐÀO SÂU 1 gói cụ thể theo budget khách ngầm thể hiện (vd 'gói nhẹ nhất là Gym 3 buổi/tuần 12 tháng 4.5tr — chia ra ~375k/tháng' nếu khách kêu cao); " +
          "(b) MỜI ghé thử 1 buổi InBody MIỄN PHÍ + dùng thử phòng tập, không cam kết — câu kết 'tiện sáng hay chiều ạ?'; " +
          "(c) HỎI schedule cụ thể (số buổi/tuần, sáng/chiều/tối) để gợi gói chuẩn hơn. " +
          "Reply ≤ 150 ký tự, 1-2 câu, có acknowledge câu khách hỏi.";
      } else {
        const goal = state.knownInfo.fitnessGoal;
        let pricing: string;
        if (goal === "giam-mo") {
          pricing =
            "Pitch 3 HÌNH THỨC theo budget — XUỐNG DÒNG mỗi mục, dạng:\n" +
            "  Dạ để giảm mỡ thì bên em có 3 hình thức ạ:\n" +
            "  - Tự tập tại phòng: Gym fulltime 12 tháng 5tr\n" +
            "  - HLV cá nhân 1-1: PT 20 buổi 6tr (2 tháng), HLV thiết kế bài đốt mỡ riêng\n" +
            "  - Lớp nhóm + đa dịch vụ: thẻ Full (Gym+Bơi+Yoga+Zumba) 7tr/12 tháng\n" +
            "  Anh/chị thiên về hướng nào ạ\n" +
            "Trình bày đủ 3 lựa chọn rồi mới hỏi";
        } else if (goal === "tang-co") {
          pricing =
            "Pitch 3 HÌNH THỨC — XUỐNG DÒNG mỗi mục:\n" +
            "  - Tự tập: Gym fulltime 12 tháng 5tr\n" +
            "  - HLV cá nhân 1-1: PT 20 buổi 6tr (2 tháng), xây kỹ thuật nền\n" +
            "  - Combo nhóm: thẻ Full 7tr/12 tháng kèm Yoga hồi phục";
        } else if (goal === "thu-gian") {
          pricing =
            "Pitch THẲNG: 'Yoga GV Ấn Độ 5.8tr/12 tháng fulltime hoặc 4.5tr (3 buổi/tuần)'";
        } else {
          pricing =
            "Pitch 3 HÌNH THỨC — XUỐNG DÒNG mỗi mục:\n" +
            "  - Tự tập tại phòng: Gym fulltime 12 tháng 5tr\n" +
            "  - HLV cá nhân 1-1: PT 20 buổi 6tr (2 tháng)\n" +
            "  - Lớp nhóm + đa dịch vụ: thẻ Full (Gym+Bơi+Yoga+Zumba) 7tr/12 tháng";
        }
        tactic =
          `Khách hỏi giá explicit. ❌ KHÔNG hỏi lại 'muốn tập gì'. ${pricing}. ` +
          `Câu kết 1 câu mời ghé thử HOẶC xin schedule (sáng/chiều/tối). KHÔNG pitch InBody làm chủ đề.`;
      }
    }
    // (c2) Khách so sánh 2 môn HOẶC indecisive ("chọn giúp em") → recommend DỨT KHOÁT theo goal,
    // KHÔNG neutral kiểu "cả 2 đều tốt". Map theo fitnessGoal đã có (hoặc Full nếu chưa rõ).
    else if (
      message &&
      (detectComparison(message) || detectIndecisive(message))
    ) {
      const goal = state.knownInfo.fitnessGoal;
      let pitch: string;
      if (goal === "giam-mo") {
        pitch =
          "RECOMMEND: 'Gym + Cardio đốt mỡ nhanh nhất, kết hợp Yoga để hồi phục — thẻ Full 4 dịch vụ 7tr/12 tháng là phù hợp nhất ạ'";
      } else if (goal === "tang-co") {
        pitch =
          "RECOMMEND: 'Gym + PT 1-1 (20 buổi 6tr) sẽ hiệu quả nhất, HLV xây kỹ thuật nền tránh sai tư thế'";
      } else if (goal === "thu-gian") {
        pitch =
          "RECOMMEND: 'Yoga GV người Ấn Độ là tối ưu cho thư giãn, giảm stress, ngủ ngon — 5.8tr/12 tháng fulltime'";
      } else if (goal === "hoc-boi") {
        pitch =
          "RECOMMEND: 'Học bơi 1-1 12 buổi 3tr+3 tháng bể, cam kết biết bơi — bể 4 mùa duy nhất Vĩnh Yên'";
      } else {
        pitch =
          "RECOMMEND: 'Thẻ Full 4 dịch vụ là phù hợp nhất — vừa Gym, Bơi, Yoga, Zumba luân phiên tránh chán, 7tr/12 tháng'";
      }
      tactic =
        `Khách compare/indecisive. ❌ TUYỆT ĐỐI KHÔNG trả lời neutral kiểu 'cả 2 đều tốt'. ${pitch}. ` +
        `Lý do 1 câu ngắn + 1 câu hỏi schedule (sáng/chiều/tối) HOẶC xin tên/SĐT để giữ slot. KHÔNG hỏi lại 'muốn tập gym/yoga/zumba'.`;
    }
  }

  // Override TACTIC inbody khi cần SKIP InBody pitch
  // (khách compare/hỏi giá/chỉ 1 dịch vụ/sinh viên/gia đình/yoga-zumba-bơi-pilates)
  // Hoặc đã có ĐỦ goal+schedule → KHÔNG hỏi lại, pitch THẲNG package
  if (state.stage === "inbody" && state.flow === "fitness") {
    const ki = state.knownInfo;
    const hasGoalAndSchedule =
      ki.fitnessGoal !== null && ki.schedule !== null;
    const shouldSkip =
      state.intent === "compare" ||
      ki.memberType === "hoc-sinh" ||
      ki.memberType === "gia-dinh" ||
      ki.serviceType === "boi" ||
      ki.serviceType === "yoga" ||
      ki.serviceType === "zumba" ||
      ki.serviceType === "pilates" ||
      ki.fitnessGoal === "thu-gian" ||
      ki.fitnessGoal === "hoc-boi" ||
      hasGoalAndSchedule ||
      (message && detectPriceQuestion(message)) ||
      (message && detectPriceObjection(message)) ||
      (message && detectMediaRequest(message));
    if (shouldSkip) {
      // Build tactic theo signal cụ thể
      if (ki.memberType === "hoc-sinh") {
        tactic =
          "Khách là HS/SV. Trả lời gói FULL HS/SV cụ thể: 700k/tháng, 2tr/3 tháng, 4tr/12 tháng. 1 câu hỏi kết: 'em muốn tháng lẻ hay dài hạn'. KHÔNG pitch InBody.";
      } else if (ki.memberType === "gia-dinh") {
        tactic =
          "Khách gia đình. Trả lời gói FULL gia đình: 2 người 12tr, 3 người 17tr, 4 người 20tr. " +
          "KHÔNG pitch InBody.";
      } else if (ki.serviceType === "boi" || ki.fitnessGoal === "hoc-boi") {
        tactic =
          "Khách quan tâm bơi. Pitch CỤ THỂ: bể 4 mùa duy nhất Vĩnh Yên. " +
          "Học bơi 1-1 12 buổi 3tr+3m | nhóm 1.2tr+1m. Cam kết biết bơi. " +
          "❌ TUYỆT ĐỐI KHÔNG nhắc 'InBody' trong tin (bơi không liên quan InBody).";
      } else if (ki.serviceType === "yoga" || ki.fitnessGoal === "thu-gian") {
        tactic =
          "Khách yoga/thư giãn. Pitch yoga: 12 tháng 5.8tr fulltime / 4.5tr (3 buổi/tuần), GV Ấn Độ. " +
          "❌ TUYỆT ĐỐI KHÔNG nhắc 'InBody' (yoga không cần đo). KHÔNG ép gói Full.";
      } else if (message && detectPriceQuestion(message)) {
        tactic =
          "Khách hỏi giá. Trả lời GIÁ cụ thể NGAY: thẻ Full 1.2tr/tháng, 3tr/3 tháng, 7tr/12 tháng. " +
          "KHÔNG pitch InBody/dẫn dắt mục tiêu trước.";
      } else if (message && detectPriceObjection(message)) {
        tactic =
          "Khách phản đối giá. Reframe bằng VALUE: máy móc xịn (phòng gym 700m2, bể bơi 4 mùa duy nhất Vĩnh Yên), GV/HLV chất lượng (Yoga & Zumba GV người Ấn Độ), social proof (nhiều hội viên gắn bó nhiều năm và giới thiệu thêm bạn bè vào tập). " +
          "Mời ghé trải nghiệm thực tế: 'Anh/chị qua thử 1 buổi cho cảm nhận, em giữ slot HLV miễn phí nha'. " +
          "KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG pitch InBody, KHÔNG hạ giá.";
      } else if (message && detectMediaRequest(message)) {
        tactic =
          "Khách xin xem ảnh. GỌI tool get-media NGAY. Reply text 1 câu ngắn dẫn dắt.";
      } else if (hasGoalAndSchedule) {
        // ĐÃ ĐỦ goal+schedule → KHÔNG hỏi lại, pitch THẲNG 3 gói anchor đa dạng
        const goal = ki.fitnessGoal ?? "tổng thể";
        tactic =
          `Khách đã đủ goal=${goal} + schedule=${ki.schedule}. KHÔNG hỏi lại "muốn tập gym/yoga/zumba". ` +
          "Pitch THẲNG 3 GÓI ANCHOR đa dạng (cao→vừa→nhẹ): PT 6tr (kèm sát) | Full 7tr/12m | Gym 4.5tr/12m (tự tập tiết kiệm). " +
          "Câu kết: 'tiện ghé InBody buổi sáng để HLV thiết kế lộ trình nha'.";
      } else {
        tactic =
          "Khách compare. Trả lời thẳng nhu cầu khách (giá/dịch vụ cụ thể). " +
          "KHÔNG pitch InBody làm chủ đề chính.";
      }
    }
  }

  // Anti-loop hint: snippet ngắn + warn pitch lặp giá + pivot suggestion.
  let antiLoopHint = "";
  if (prevBotReply) {
    const trim = prevBotReply.slice(0, 100).replace(/\n/g, " ");
    const prevHadPricing = /\d+\s*(tr|triệu|k)\b.*?\d+\s*(tr|triệu|k)\b/i.test(
      prevBotReply,
    );
    const prevAskedSchedule = /(sáng|chiều|tối|mấy\s*buổi|tuần)/i.test(
      prevBotReply,
    );
    const pivotHint = prevHadPricing
      ? " — TIN NÀY pivot: chọn 1 trong (a) đào sâu 1 gói cụ thể theo budget; (b) mời ghé InBody MIỄN PHÍ thử 1 buổi; (c) hỏi schedule cụ thể. KHÔNG list lại 3 gói/giá cũ."
      : prevAskedSchedule
        ? " — đã hỏi schedule, KHÔNG hỏi lại; tiến tới mục tiêu hoặc số buổi/tuần."
        : "";
    antiLoopHint = `[PREV: "${trim}..."${pivotHint} Nếu khách đã trả lời câu cũ → ACK 1 câu rồi đi tiếp; tuyệt đối không lặp lại nội dung tin trước.]`;
  }

  // Build GATE first — detect "override mode" (hard-return single GATE) để skip few-shot/knowledge.
  // Override = GATE ưu tiên tuyệt đối làm bộ não bot, KHÔNG nên bị TACTIC/few-shot/knowledge gây nhiễu.
  const gateOutput = buildLogicGate(state, message);
  const isOverrideGate =
    /Zumba-vs-Aerobic|chấn thương cấp|done-slots|đang lạnh|phản đối giá|GATE deposit|cold lead|giam-can-opening|bơi-hỏi-NL\/TE|bơi-trẻ-em|bơi-tuổi-stated|chuong-trinh-consult|chua-biet-tap-gi|tham-quan|full-package-confirm|trial-ask|explicit-price-list/i.test(
      gateOutput,
    );

  const knowledgeBlock = isOverrideGate ? "" : buildKnowledgeBlock(state, h, message, prevBotReply);
  const fewShotBlock = isOverrideGate ? "" : (buildFewShot(state, h, prevBotReply, message) ?? "");

  // Khi override-GATE bật, TACTIC mặc định (vd "pitch CỤ THỂ bể 4 mùa") sẽ mâu thuẫn với GATE.
  // → Thay TACTIC bằng instruction trung tính "đọc GATE bên dưới".
  if (isOverrideGate) {
    tactic = "ƯU TIÊN [GATE] ở dưới — viết theo đúng GATE, KHÔNG pitch/list/nhảy chủ đề khác.";
  }

  const lines: string[] = [
    `[HON: ${h}] [STAGE: ${state.stage}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
    `[TACTIC: ${tactic}]`,
    `[RULES: 1 ý ngắn ≤200 chars / 2-3 câu liền 1 dòng. Khi liệt kê 3+ lựa chọn → XUỐNG DÒNG mỗi mục với "(1)/(2)/(3)" hoặc "-" (≤350 chars tổng). CẤM markdown **bold**/*italic*. CẤM viết tắt giá nội bộ ra cho khách: "12m=5tr", "3b/t", dấu "|" và "=" — phải đổi sang "12 tháng 5 triệu", "3 buổi/tuần", phẩy hoặc \\n. CẤM "tuyệt vời/quá/chắc chắn rồi", "em gửi hình" mà không gọi tool, "em có thể tư vấn thêm" sáo rỗng. CẤM khen đáp án của khách: "rất tốt / tốt quá / tốt rồi / ổn lắm / ổn rồi / hợp lý / tần suất tốt / lý tưởng / phù hợp lắm / vậy là chuẩn / lựa chọn đúng" — ACK chỉ nhắc lại / note. CẤM kết câu hỏi bằng "nha?" / "nha ạ?" / "ạ nha?" — câu hỏi kết bằng "?" hoặc "ạ?". "nha" chỉ dùng cho câu khẳng định ("Dạ vâng nha"). KHÔNG lặp nội dung TACTIC/GATE/KNOWLEDGE — đọc rồi tự viết.]`,
    antiLoopHint,
    buildKnownSummary(state.knownInfo, state.flow),
    buildMissingSlotHint(
      state.knownInfo,
      state.flow,
      state.intent,
      state.stage,
    ),
    knowledgeBlock,
    buildMediaHint(state),
    gateOutput,
    fewShotBlock,
  ];

  return lines.filter(Boolean).join("\n");
}

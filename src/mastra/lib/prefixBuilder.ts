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
  return /(giá|bao\s+nhiêu|mấy\s+(tiền|đồng)|giá\s+thẻ|tiền\s+gói|chi\s+phí|báo\s+giá|học\s+phí|phí\s+(tập|gói|đăng\s+ký))/.test(m);
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
  if (state.stage === "opening" || state.stage === "commitment") return "";

  const key = computeSuggestedMediaKey(state);
  if (!key) return "";

  return (
    `[MEDIA: chưa gửi. suggestedKey="${key}". TỰ QUYẾT gọi get-media nếu khách đang phân vân/build-value/xin xem trực tiếp. KHÔNG gửi khi chào hỏi/đang chốt. Max 1 lần/conv.]`
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
      "[GATE: mediaShown=true — ĐÃ gửi ảnh/video cho khách. " +
        "TUYỆT ĐỐI KHÔNG gọi lại tool get-media trong turn này. " +
        "Nếu khách hỏi xem thêm → trả lời text 'em đã gửi rồi nha, anh/chị xem lại giúp em', mời ghé trực tiếp.]",
    );
  }

  // ── ƯU TIÊN: khách đổi giờ → bot phải dùng giờ MỚI, không dùng giờ trong memory ──
  if (
    message &&
    knownInfo.preferredTime &&
    /(thôi|đổi|chuyển|hoặc|hay là|sang)\s/i.test(message)
  ) {
    hints.push(
      `[GATE ƯU TIÊN: khách vừa ĐỔI giờ. Giờ MỚI = "${knownInfo.preferredTime}". ` +
        `TUYỆT ĐỐI KHÔNG dùng giờ cũ trong memory thread. Reply phải khớp giờ mới này.]`,
    );
  }

  // ── ƯU TIÊN: chấn thương cấp tính (giải cơ) → cảnh báo nghỉ trước ──
  if (flow === "giai-co" && message && detectAcuteInjury(message)) {
    return (
      "[GATE ƯU TIÊN TUYỆT ĐỐI — CHẤN THƯƠNG CẤP TÍNH:\n" +
        "  Khách vừa bị / đang sưng nóng / không cử động được → KHÔNG mời giải cơ ngay.\n" +
        "  ❌ KHÔNG hỏi painSpread/pastMethod/giờ. KHÔNG pitch gói. KHÔNG mời 1 buổi.\n" +
        "  ✅ Khuyên nghỉ + chườm: 'Dạ với chấn thương cấp như anh/chị, " +
        "bên em khuyên nghỉ 3-5 ngày, chườm đá vùng sưng. Nếu sau 5 ngày vẫn đau, " +
        "anh/chị qua bên em xử lý phần cơ co cứng còn lại nha. Trường hợp đau tăng dần " +
        "hoặc tê chân tay thì nên đi khám sớm ạ'.\n" +
        "  An toàn cho khách = uy tín cho center.]"
    );
  }

  // ── ƯU TIÊN: khách lạnh, muốn tham khảo thêm → KHÔNG push ──
  if (message && detectColdLead(message)) {
    return (
      "[GATE ƯU TIÊN TUYỆT ĐỐI — KHÁCH ĐANG LẠNH:\n" +
        "  ❌ KHÔNG xin tên, SĐT, giờ — kể cả khi tin trước bot đã hỏi.\n" +
        "  ❌ KHÔNG pitch gói, KHÔNG nhắc giá, KHÔNG kêu 'qua thử 1 buổi'.\n" +
        "  ❌ KHÔNG hỏi câu hỏi tiếp theo (làm khách áp lực).\n" +
        "  ✅ Reply ngắn gọn 1-2 câu duy nhất, kiểu lịch sự lùi 1 bước:\n" +
        "       'Dạ vâng nha anh/chị, anh/chị cứ tham khảo thoải mái. " +
        "Có gì cần thêm thông tin em luôn sẵn ạ'.\n" +
        "  ✅ Có thể đính kèm 1 thông tin nhỏ giúp khách quyết sau (vd " +
        "'Em note mức ưu đãi tháng này lại cho anh/chị nha').\n" +
        "Đây là moment KHÁCH muốn dừng — lùi đúng cách = giữ được lead, push thêm = mất.]"
    );
  }

  // ── ƯU TIÊN: khách hỏi GIỜ MỞ CỬA → trả giờ ngay, KHÔNG hỏi sáng/chiều/tối ──
  if (message && detectHoursQuestion(message)) {
    const hours = flow === "fitness" ? "05:00–20:00" : "09:00–23:00";
    hints.push(
      `[GATE ƯU TIÊN: khách hỏi giờ mở cửa / qua được lúc nào. ` +
        `Trả GIỜ MỞ CỬA cụ thể: bên em mở ${hours} ${state.honorific} ạ. ` +
        `Sau đó MỚI hỏi schedule: "${state.honorific} tiện sáng hay chiều tối ạ". ` +
        `❌ TUYỆT ĐỐI KHÔNG hỏi ngược "sáng/chiều/tối" mà chưa trả giờ mở cửa — khách hỏi giờ chứ không phải chọn slot.]`,
    );
  }

  // ── ƯU TIÊN: khách hỏi về bảo lưu / vắng → trả lời chính sách CỤ THỂ ──
  if (flow === "fitness" && message && detectHoldPolicy(message)) {
    hints.push(
      "[GATE ƯU TIÊN: khách hỏi về bảo lưu/vắng/hoãn. Trả lời chính sách CỤ THỂ ngay:" +
        "  ✓ Gói NĂM (3m+) bảo lưu được khi đi công tác/vắng — chỉ cần báo trước 1-2 ngày." +
        "  ✓ Gói tháng không bảo lưu, nhưng có thể chuyển nhượng cho người trong gia đình." +
        "  Vd reply: 'Dạ, gói năm bảo lưu được anh/chị nha — vắng 1-2 tuần báo trước là em hold lại, chị quay lại kích hoạt tiếp'. " +
        "❌ TUYỆT ĐỐI KHÔNG nhảy sang InBody/gói khi khách đang hỏi bảo lưu — phải answer câu hỏi này trước.]",
    );
  }

  // ── ƯU TIÊN: khách answer ngắn câu cụ thể → bot phải ACK trước ──
  if (message && detectShortAnswer(message)) {
    hints.push(
      "[GATE ƯU TIÊN: khách vừa answer câu hỏi tin trước (số/thời gian/lựa chọn cụ thể). " +
        "BẮT BUỘC mở đầu reply bằng ACK NEUTRAL — chỉ note lại / nhắc lại nội dung khách vừa nói. " +
        `Vd: "1-2 tuần" → "Dạ ${state.honorific} hay vắng 1-2 tuần thì..."; ` +
        `"4 buổi/tuần" → "Dạ 4 buổi/tuần em note rồi ạ"; ` +
        `"sáng" → "Dạ sáng nha ${state.honorific}". ` +
        'CẤM cụm khen đáp án: "rất tốt / tốt quá / tốt rồi / ổn lắm / ổn rồi / hợp lý / tần suất tốt / lý tưởng / phù hợp lắm / vậy là chuẩn". ' +
        "Sau ACK mới chuyển ý mới (1 câu).]",
    );
  }

  // ── ƯU TIÊN: khách yêu cầu PT 1-1 / mới tập sợ sai tư thế ──
  if (flow === "fitness" && message && detectPTNeed(message)) {
    const honor = state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
    hints.push(
      `[GATE PT: pitch THẲNG 1 gói PT — "PT 20 buổi (2 tháng) 6tr, HLV 1-1". Câu kết: "Hôm nào ${honor} ghé đo InBody". KHÔNG hỏi "${honor} muốn gym hay yoga".]`,
    );
  }

  // ── ƯU TIÊN: khách phản đối giá → reframe theo VALUE (máy móc/HLV/social proof) ──
  if (message && detectPriceObjection(message) && flow === "fitness") {
    return (
      "[GATE ƯU TIÊN: khách phản đối giá. KHÔNG hạ giá, KHÔNG chia nhỏ giá theo ngày, KHÔNG so sánh ly cà phê.\n" +
        "REPLY DÀI 5-7 CÂU, 350-450 ký tự (override [RULES] char limit). BẮT BUỘC đủ CẢ 3 MŨI value, không bỏ mũi nào, mỗi mũi ≥1 chi tiết cụ thể (tên/số/đặc điểm).\n" +
        "MŨI 1 — CƠ SỞ VẬT CHẤT: phòng gym 700m2 trong nhà + 300m2 sân ngoài có mái che, máy tập chuẩn quốc tế, sức chứa 100 người. Bể bơi 4 mùa 350m2 DUY NHẤT Vĩnh Yên — nước nóng quanh năm, lọc ozone, đội cứu hộ riêng. Pilates 13 máy chuẩn QT mới nhập 12/2024.\n" +
        "MŨI 2 — HLV / GV CHẤT LƯỢNG: Yoga & Zumba có GV người Ấn Độ chuyên nghiệp dạy 4 ca/ngày. HLV gym kinh nghiệm nhiều năm, đo InBody miễn phí lần đầu rồi xây lộ trình đúng theo mỡ/cơ thực tế.\n" +
        "MŨI 3 — SOCIAL PROOF: hội viên gắn bó 2-3 năm là chuyện bình thường, hay rủ thêm vợ/chồng/bạn bè/đồng nghiệp vào tập cùng — tỉ lệ duy trì cao vì 1 thẻ dùng được nhiều môn không chán.\n" +
        "CẤU TRÚC reply BẮT BUỘC THEO THỨ TỰ:\n" +
        "  Câu 1 — khẳng định giá đi kèm chất lượng (vd: 'Dạ giá bên em đi cùng chất lượng đầu tư thực sự ạ').\n" +
        "  Câu 2-3 — mũi 1 (cơ sở vật chất, ≥1 con số: 700m2 / bể 4 mùa).\n" +
        "  Câu 4 — mũi 2 (HLV/GV: nhấn GV Ấn Độ + InBody miễn phí).\n" +
        "  Câu 5 — mũi 3 (social proof: hội viên gắn bó nhiều năm + giới thiệu thêm bạn bè).\n" +
        "  Câu 6 — mời ghé trải nghiệm thực tế: 'Anh/chị qua thử 1 buổi cho cảm nhận, em giữ slot HLV miễn phí nha'.\n" +
        "Mỗi mũi ≥30 chars. Đủ 3 mũi mới được kết câu mời. KHÔNG xin tên/SĐT trong tin này.]"
    );
  }
  if (message && detectPriceObjection(message) && flow === "giai-co") {
    return (
      "[GATE ƯU TIÊN: khách phản đối giá. Reframe theo giá trị bền vững: " +
        "'Dạ em hiểu ạ — giải cơ chuyên sâu cao hơn massage thường vì KTV được đào tạo giải phẫu cơ bài bản, " +
        "tác động đúng nhóm cơ kẹt. Khách thường thấy đỡ rõ trong 1-2 buổi đầu, không phải đi đi lại lại như massage'. " +
        "Mời thử 1 buổi: 'Anh/chị thử 1 buổi xem hợp không, em không ép gói lâu dài nha'.]"
    );
  }

  // ── ƯU TIÊN: khách xin xem ảnh/video → gọi get-media ĐÚNG 1 LẦN ──
  // (Bypass mediaShown=true 1 lần — khách EXPLICIT yêu cầu thì phải đáp ứng)
  if (message && detectMediaRequest(message)) {
    const key = computeSuggestedMediaKey(state);
    if (key) {
      hints.push(
        `[GATE ƯU TIÊN: khách CHỦ ĐỘNG xin xem ảnh/video. ` +
          `Gọi tool get-media với key="${key}" ĐÚNG 1 LẦN DUY NHẤT trong turn này. ` +
          `❌ TUYỆT ĐỐI KHÔNG gọi tool 2-3 lần liên tiếp (gây duplicate). ` +
          `Reply text NGẮN ≤ 80 ký tự, CHỈ 1 câu: ` +
          `"Dạ em gửi ${state.flow === "fitness" ? "vài hình phòng tập" : "vài hình"} cho ${state.honorific} xem nha". ` +
          `Copy URLs từ tool result vào mediaUrls output, set nextStep="show_media". KHÔNG pitch giá/gói.]`,
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
  if (
    !keyAlreadySent &&
    !customerAskingMedia &&
    hasContextForMedia &&
    (stage === "discovery" || stage === "inbody" || stage === "evaluation")
  ) {
    const key = proactiveKey;
    if (key) {
      const isNewSvc = mentionedKey !== null && mediaShownKeys.length > 0;
      const reasonHint = isNewSvc
        ? `Khách vừa hỏi dịch vụ MỚI (chưa gửi media của dịch vụ này) → CHỦ ĐỘNG gửi ảnh ${key}.`
        : `${stage}, biết goal/service mà chưa gửi ảnh. CHỦ ĐỘNG gửi ảnh build trust visual.`;
      hints.push(
        `[GATE PROACTIVE MEDIA: ${reasonHint} ` +
          `Gọi tool get-media key="${key}" NGAY trong turn này. ` +
          `Đừng đợi khách xin — sale tốt là sale chủ động show ảnh. ` +
          `Reply text vẫn theo TACTIC chính + 1 câu ngắn dẫn dắt: ` +
          `"Em gửi ${flow === "fitness" ? "vài hình" : "vài hình thực tế"} cho ${state.honorific} hình dung nha". ` +
          `Copy URLs vào mediaUrls, set nextStep="show_media". Gọi 1 LẦN duy nhất.]`,
      );
    }
  }

  // ── Multi-service: khách nhắc 2+ dịch vụ trong 1 tin → ack combo, không lặp goal ──
  if (
    flow === "fitness" &&
    message &&
    /(gym|yoga|zumba|bơi|pilates).{0,30}(và|\+|với)\s*(gym|yoga|zumba|bơi|pilates)/i.test(
      message,
    )
  ) {
    hints.push(
      "[GATE: khách nhắc 2+ dịch vụ. Đây là tín hiệu interest combo → đề xuất thẻ Full ngay (1.2tr/3tr/7tr) " +
        "hoặc gợi 2 gói riêng nếu khách hỏi cụ thể. " +
        "KHÔNG lặp lại câu hỏi 'tập để giảm mỡ/tăng cơ/thư giãn' nếu đã hỏi tin trước.]",
    );
  }

  // ── ƯU TIÊN: khách là sinh viên / học sinh → list giá HS/SV thẳng ──
  if (
    flow === "fitness" &&
    knownInfo.memberType === "hoc-sinh" &&
    !knownInfo.preferredTime // chưa chốt giờ thì còn pitch được
  ) {
    const honor = state.honorific === "anh/chị" ? "em" : state.honorific;
    hints.push(
      `[GATE ƯU TIÊN: khách là HS/SV (memberType=hoc-sinh). ` +
        `BẮT BUỘC đề cập gói FULL HS/SV với giá thật (KHÔNG nói "có ưu đãi" chung chung):` +
        `  1 tháng 700k | 3 tháng 2tr | 6 tháng 3tr | 12 tháng 4tr (anchor 12 tháng).` +
        `  Vd: "Dạ với SV bên em có gói Full 4 dịch vụ (gym/bơi/yoga/zumba) ưu đãi: 700k/tháng, 2tr/3 tháng, 4tr/12 tháng ${honor} nha".` +
        ` Sau đó hỏi 1 câu kết: "${honor} muốn tập tháng lẻ hay đăng ký dài hạn ạ". ` +
        `❌ KHÔNG nói "có ưu đãi cho sinh viên" mà không nêu con số.]`,
    );
  }

  // ── ƯU TIÊN: khách chỉ muốn 1 dịch vụ → KHÔNG ép Full ──
  if (
    flow === "fitness" &&
    message &&
    (/chỉ\s*(tập|cần|muốn)?\s*(yoga|zumba|bơi|gym|pilates)\s*(thôi|nhỉ)?/i.test(
      message,
    ) ||
      /không\s+cần\s+(gym|yoga|zumba|bơi|pilates|full)/i.test(message) ||
      /(muốn|chỉ)\s+(học\s+)?(yoga|zumba|bơi|pilates)(?!\s*\+)/i.test(message) ||
      /(yoga|zumba|bơi|pilates|gym)\s+thôi/i.test(message))
  ) {
    hints.push(
      "[GATE: khách yêu cầu CHỈ MỘT dịch vụ. KHÔNG ép gói Full, KHÔNG gợi 4-trong-1. " +
        "Pitch gói đơn theo dịch vụ khách chọn (vd Yoga 12 tháng 5.8tr / 3 buổi-12 tháng 4.5tr). " +
        "TUYỆT ĐỐI KHÔNG nói 'kết hợp với cardio/gym/bơi để hiệu quả hơn'.]",
    );
  }

  // ── ƯU TIÊN: khách hỏi giá rõ ràng → ANSWER GIÁ FIRST ──
  if (
    message &&
    detectPriceQuestion(message) &&
    !knownInfo.name &&
    !knownInfo.phone
  ) {
    if (flow === "fitness") {
      hints.push(
        "[GATE: khách hỏi giá — TRẢ LỜI GIÁ NGAY trong tin này, KHÔNG né. " +
          "Tham chiếu nhanh từ bảng PRICING ở [KNOWLEDGE]. " +
          "Vd: 'Dạ, thẻ Full 4 dịch vụ (gym/bơi/yoga/zumba): 1.2tr/tháng | 3tr/3 tháng | 7tr/12 tháng anh/chị nha. " +
          "Anh/chị tập để giảm mỡ, tăng cơ hay thư giãn để em gợi gói chuẩn nhất ạ'. " +
          "TUYỆT ĐỐI KHÔNG dẫn vào InBody khi khách đang hỏi giá. KHÔNG xin tên/SĐT trong tin này.]",
      );
    } else {
      hints.push(
        "[GATE: khách hỏi giá — TRẢ LỜI GIÁ NGAY. " +
          "Mức tham chiếu: 200k (45p, 1-2 vùng) → 590k (CS-VIP 2 trọn gói). Liệu trình từ 3.3tr/10 buổi. " +
          "Sau đó hỏi vùng đau để tư vấn cụ thể.]",
      );
    }
  }

  // ── CROSS-CUTTING: khách chủ động hỏi cọc / thanh toán trước ──
  // Phải check TRƯỚC các GATE commitment "DỪNG HẲN" để không bị che.
  if (message && detectDepositAsk(message)) {
    const qrShown = (state as any).qrShown ?? false;
    if (!qrShown) {
      if (knownInfo.name && knownInfo.phone) {
        const qrFlow = flow === "fitness" ? "fitness" : "muscle-release";
        return (
          `[GATE ƯU TIÊN TUYỆT ĐỐI: khách chủ động hỏi về cọc / thanh toán trước. ` +
          `BẮT BUỘC GỌI tool get-qr với flow="${qrFlow}" NGAY trong turn này. ` +
          `Sau đó viết reply ngắn: xác nhận đặt cọc được + gửi kèm QR + 1 dòng hướng dẫn ghi nội dung chuyển khoản là tên và SĐT khách. ` +
          `Copy qrUrl từ kết quả tool vào field "qrUrl" của output, set nextStep="show_qr". ` +
          `BỎ QUA mọi lệnh "DỪNG HẲN" khác — cọc là yêu cầu chủ động của khách, phải đáp ứng.]`
        );
      }
      // Chưa có tên/SĐT → xin trước, chưa gọi QR
      return (
        `[GATE: khách hỏi về cọc/thanh toán trước nhưng CHƯA đủ tên/SĐT. ` +
        `Trả lời: "Dạ cọc trước được nha ${flow === "fitness" ? "anh/chị" : "anh/chị"} — cho em xin tên với SĐT để lập đơn rồi em gửi QR ngay ạ". ` +
        `KHÔNG gọi get-qr cho đến khi có đủ tên/SĐT.]`
      );
    }
    // Đã gửi QR rồi mà khách hỏi lại → hướng dẫn lại
    return (
      `[GATE: QR đã được gửi trước đó. Không gọi lại get-qr. ` +
      `Xác nhận nội dung chuyển khoản (tên + SĐT khách) và hướng dẫn bước tiếp theo.]`
    );
  }

  // ── OPENING lặp: khách reply ngắn (ok/ừ/được) lần 2+ mà chưa cung cấp signal ──
  // Tránh bot lặp y câu chào → đổi tone, dẫn dắt cụ thể hơn.
  if (
    state.stage === "opening" &&
    state.turnCount >= 2 &&
    knownInfo.serviceType === null &&
    knownInfo.painArea === null
  ) {
    if (state.turnCount >= 3) {
      // Turn ≥ 3 vẫn không signal → reply CỰC NGẮN, không pitch
      hints.push(
        "[GATE: khách đã reply ngắn 3 lần liên tiếp mà chưa có ý định cụ thể. " +
          "Reply NGẮN ≤ 80 ký tự, KHÔNG pitch, KHÔNG hỏi thêm. " +
          "Vd: 'Dạ vâng, anh/chị cần thêm thông tin gì cứ nhắn em nha'. " +
          "TUYỆT ĐỐI KHÔNG lặp 'gym và bơi' / 'mục tiêu tập luyện' từ tin trước.]",
      );
    } else {
      const honor = state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
      hints.push(
        `[GATE: khách reply ngắn lần 2 mà chưa cho signal. ` +
          `TUYỆT ĐỐI KHÔNG lặp y câu chào trước. KHÔNG pitch InBody. ` +
          `Reply ngắn 1-2 câu, max 130 ký tự, đổi tone sang KHƠI GỢI nhẹ. ` +
          `Vd: "Dạ ${honor} đang thiên về cải thiện vóc dáng hay sức khỏe tổng thể nha" ` +
          `hoặc "Dạ ${honor} đang phân vân giữa gym hay yoga ạ". ` +
          `Câu hỏi mở để khách dễ chọn.]`,
      );
    }
  }

  // ── FITNESS: chưa biết dịch vụ ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType === null
  ) {
    if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết serviceType — ANSWER FIRST: trả lời câu hỏi khách trước, " +
          "lồng hỏi 'anh/chị quan tâm dịch vụ nào / mục tiêu gì' vào CUỐI response]",
      );
    } else {
      hints.push(
        "[GATE: chưa biết serviceType — COLLECT FIRST: hỏi dịch vụ quan tâm trước]",
      );
    }
  }

  // ── FITNESS: biết dịch vụ nhưng chưa biết mục tiêu ──
  // Gate mới: giữ khách ở discovery thêm 1 câu hỏi về mục tiêu
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal === null &&
    intent === "explore"
  ) {
    hints.push(
      `[GATE: biết dịch_vụ=${knownInfo.serviceType} nhưng chưa biết mục tiêu (fitnessGoal). ` +
        "KHÔNG báo giá. Hỏi mục tiêu tập: 'để giảm mỡ, tăng cơ, thư giãn hay mục tiêu khác ạ' " +
        "Trước khi hỏi, nhấn 1 điểm nổi bật của dịch vụ đó để giữ interest.]",
    );
  }

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

    if (skipInbody) {
      // Yoga/swim/relax: KHÔNG nhắc InBody chút nào.
      // Compare/price: vẫn có thể nhắc nhẹ.
      const banInBody =
        knownInfo.serviceType === "yoga" ||
        knownInfo.serviceType === "boi" ||
        knownInfo.serviceType === "zumba" ||
        knownInfo.serviceType === "pilates" ||
        knownInfo.fitnessGoal === "thu-gian" ||
        knownInfo.fitnessGoal === "hoc-boi";
      if (banInBody) {
        hints.push(
          "[GATE inbody-skip: khách yoga/bơi/zumba/pilates/thư-giãn → ❌ TUYỆT ĐỐI KHÔNG nhắc InBody (không liên quan). Pitch service-specific theo TACTIC.]",
        );
      } else {
        hints.push(
          "[GATE inbody-skip: BỎ QUA pitch InBody, trả lời nhu cầu trước. Có thể nhắc InBody miễn phí ở cuối tin (1 dòng).]",
        );
      }
    } else if (knownInfo.schedule === null) {
      const svc = knownInfo.serviceType ?? "dịch vụ";
      hints.push(
        `[GATE inbody (chưa schedule): KHÔNG pitch full. Chỉ 2 việc: (1) ack ngắn "${svc} cho ${knownInfo.fitnessGoal ?? "mục tiêu"} là hướng đi ổn ${state.honorific}". (2) hỏi schedule "tiện sáng/chiều, mấy buổi/tuần". CẤM "cần tập đúng hướng/lộ trình chuẩn".]`,
      );
    } else {
      hints.push(
        `[GATE inbody (lịch=${knownInfo.schedule}): 3 câu ngắn — ack lịch + pitch InBody (vd "${state.honorific} ghé đo InBody, máy đọc mỡ/cơ thật") + mời "tiện ghé sáng hay chiều". KHÔNG show gói/giá.]`,
      );
    }
  }

  // ── FITNESS / GIẢI CƠ: negotiation + khách đã chấp nhận → bỏ pitch ──
  // Áp dụng khi khách nói "ok thử 1 buổi" / "đồng ý" / "chốt gói đó" / "đặt cọc"
  // Bot KHÔNG được pitch tiếp giá hay giá trị — phải xin tên/SĐT/giờ ngay.
  if (
    stage === "negotiation" &&
    (intent === "selecting" || intent === "ready")
  ) {
    hints.push(
      "[GATE: khách đã chấp nhận (negotiation + selecting/ready). " +
        "TUYỆT ĐỐI KHÔNG pitch thêm thẻ/gói/lý do mua nữa. " +
        "Hỏi GỘP 1 câu duy nhất: 'Cho em xin tên, SĐT với " +
        (flow === "fitness" ? "anh/chị" : "anh/chị") +
        " muốn đến buổi sáng, chiều hay tối ạ' " +
        "(hoặc bỏ phần khung giờ nếu đã có preferredTime). " +
        "Khen giả 'Tuyệt quá / Tuyệt vời / Chắc chắn' là CẤM.]",
    );
  }

  // ── FITNESS: evaluation — nhắc build value trước ──
  if (flow === "fitness" && stage === "evaluation") {
    // Khách chủ động chọn/đăng ký → skip pitch, hỏi ngay tên/SĐT
    if (intent === "selecting" || intent === "ready") {
      hints.push(
        "[GATE: khách đã sẵn sàng đăng ký. KHÔNG pitch thêm gói — " +
          "hỏi ngay tên và SĐT: 'Cho em xin tên với SĐT để giữ slot ạ' " +
          "TUYỆT ĐỐI không giới thiệu lại dịch vụ hay giá ở tin này.]",
      );
    } else {
      const goalCtx = knownInfo.fitnessGoal
        ? `mục_tiêu=${knownInfo.fitnessGoal}`
        : "chưa có mục tiêu";
      const svcCtx = knownInfo.serviceType
        ? `dịch_vụ=${knownInfo.serviceType}`
        : "";
      hints.push(
        `[GATE: evaluation — ${svcCtx} ${goalCtx}. ` +
          "BẮT BUỘC theo thứ tự: (1) 1-2 câu value CỤ THỂ theo mục tiêu → " +
          "(2) gợi tối đa 3 gói ANCHOR CAO→VỪA→NHẸ, MỖI GÓI PHẢI ghi giá thật từ bảng giá kèm 1 lý do gắn mục tiêu → " +
          "(3) kết bằng câu hỏi giờ/lịch đến InBody. " +
          "TUYỆT ĐỐI KHÔNG bỏ giá trong mô tả gói — gói thiếu giá là sai.]",
      );
    }
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea === null
  ) {
    // Đặc biệt: khách đã báo giờ trước khi mô tả vùng đau → ack lịch trước
    if (knownInfo.preferredTime !== null) {
      hints.push(
        `[GATE: khách đã báo giờ=${knownInfo.preferredTime} TRƯỚC khi mô tả vùng đau. ` +
          "BẮT BUỘC ack lịch trong câu MỞ ĐẦU rồi mới hỏi vùng đau. " +
          `Vd: "Dạ em note giờ ${knownInfo.preferredTime} cho ${state.honorific} rồi nha. ` +
          `Cho em hỏi ${state.honorific} đang đau vùng nào để KTV chuẩn bị tốt hơn ạ". ` +
          "TUYỆT ĐỐI KHÔNG hỏi vùng đau ngay khi chưa ack lịch.]",
      );
    } else if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết painArea — ANSWER FIRST: trả lời câu hỏi khách trước, " +
          "lồng hỏi về vùng đang đau/mỏi vào CUỐI response một cách tự nhiên]",
      );
    } else {
      hints.push(
        "[GATE: chưa biết painArea — COLLECT FIRST: hỏi anh/chị đang đau/mỏi vùng nào trước]",
      );
    }
  }

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
          "Hỏi 1 LẦN duy nhất: 'Cơn đau lan ra xung quanh hay chỉ đau một điểm cố định thôi ạ'. " +
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
    if (prevAskedMethod || state.turnCount >= 3) {
      hints.push(
        "[GATE: đã hỏi pastMethod tin trước → SKIP, KHÔNG hỏi lại. " +
          "Tiến tới evaluation: hình ảnh hóa vùng đau + contrast bề mặt vs sâu + mời 1 buổi thử.]",
      );
    } else {
      hints.push(
        `[GATE: biết vùng_đau=${knownInfo.painArea}. Hỏi 1 LẦN: 'Trước giờ anh/chị có thử massage hay dán cao chưa ạ'. KHÔNG lặp ở turn sau.]`,
      );
    }
  }


  // ── GIẢI CƠ: đã biết vùng đau + pastMethod, đang evaluation ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null
  ) {
    const durationCtx = knownInfo.painDuration
      ? `đau ${knownInfo.painDuration}`
      : "chưa biết thời gian đau";
    const methodCtx = knownInfo.pastMethod
      ? `đã_thử=${knownInfo.pastMethod}`
      : "chưa có pastMethod";

    // Khách đã đồng ý + báo giờ → bỏ qua pitch, hỏi ngay tên/SĐT
    if ((intent === "selecting" || intent === "ready") && knownInfo.preferredTime !== null) {
      hints.push(
        `[GATE: khách đã xác nhận đặt lịch buổi ${knownInfo.preferredTime}. ` +
          "KHÔNG pitch lại — xác nhận ngắn 1 câu rồi hỏi ngay tên và SĐT: " +
          "'Để em giữ slot [giờ] cho anh/chị, cho em xin tên với SĐT ạ' " +
          "TUYỆT ĐỐI không lặp lại nội dung tư vấn đã nói.]",
      );
    } else {
      const hasContact = knownInfo.name !== null && knownInfo.phone !== null;
      const closingInstruction = hasContact
        ? `đã có tên=${knownInfo.name} và SĐT — KHÔNG hỏi lại tên/SĐT. Sau pitch xác nhận ngắn 1 câu ('Dạ em giữ slot ${knownInfo.preferredTime ?? "..."} cho mình rồi nha ${state.honorific} ${knownInfo.name}, hẹn gặp ${state.honorific} ạ') rồi dừng`
        : knownInfo.preferredTime
          ? `đã biết giờ=${knownInfo.preferredTime} — sau khi pitch xong KẾT THÚC bằng xin tên/SĐT ('Để em giữ slot ${knownInfo.preferredTime} cho anh, cho em xin tên với SĐT nha'). TUYỆT ĐỐI không hỏi lại giờ`
          : "sau khi pitch xong hỏi giờ muốn đến (sáng/chiều/tối) và xin tên/SĐT trong 1 câu gộp";
      hints.push(
        `[GATE: evaluation — vùng_đau=${knownInfo.painArea}, ${durationCtx}, ${methodCtx}. ` +
          "Cấu trúc response: (1) hình ảnh hóa vùng đó → (2) contrast với pastMethod đã biết → (3) vẽ viễn cảnh sau khi gỡ → " +
          `(4) CHỈ mời 1 buổi thử — ${closingInstruction}. KHÔNG show bảng gói 3 dòng ngay lần đầu. ` +
          "Quyết định gửi ảnh/video xem [MEDIA] block riêng — KHÔNG ép.]",
      );
    }
  }

  // ── COMMITMENT: chốt lịch ──
  if (stage === "commitment") {
    const dateCtx = buildDateContext();
    const { name, phone } = knownInfo;
    const hasTime = knownInfo.preferredTime !== null;
    const qrShown = (state as any).qrShown ?? false;

    if (!name || !phone) {
      if (!hasTime) {
        // Chưa có cả 3 → hỏi GỘP 1 lần
        hints.push(
          "[GATE: CHƯA CÓ tên, SĐT và giờ. " +
            "Hỏi GỘP 1 câu duy nhất: 'Cho em xin tên, SĐT với anh/chị muốn đến buổi sáng, chiều hay tối để em giữ slot ạ' " +
            "TUYỆT ĐỐI KHÔNG hỏi từng thứ riêng lẻ. KHÔNG đề cập giá hay gói (10 buổi, liệu trình...) trong tin này. Chỉ 1 câu hỏi gộp.]",
        );
      } else {
        // Đã biết giờ, chỉ cần tên/SĐT — TUYỆT ĐỐI không hỏi lại buổi
        hints.push(
          `[GATE: đã biết giờ=${knownInfo.preferredTime} — chỉ cần tên và SĐT. ` +
            "Hỏi: 'Cho em xin tên với SĐT để giữ slot ạ'. " +
            "❌ TUYỆT ĐỐI KHÔNG hỏi 'buổi sáng/chiều/tối' nữa vì đã có giờ. " +
            "❌ KHÔNG đề cập giá/gói. Chỉ 1 câu hỏi tên/SĐT.]",
        );
      }
    } else if (!hasTime) {
      // Đã có tên/SĐT, cần giờ
      hints.push(
        "[GATE: đã có tên/SĐT — chỉ cần hỏi khung giờ: 'Anh/chị muốn đến buổi sáng, chiều hay tối ạ?' KHÔNG hỏi thêm gì khác.]",
      );
    } else if (!qrShown) {
      // ĐỦ INFO (tên + SĐT + giờ) → XÁC NHẬN VÀ DỪNG
      hints.push(
        `[GATE: ĐỦ INFO — tên=${name}, sđt=${phone}, giờ=${knownInfo.preferredTime}. ` +
        `NGÀY HÔM NAY:\n${dateCtx}\n` +
        "XÁC NHẬN lịch 1 câu ngắn gọn, ghi ngày cụ thể nếu preferredTime đã có ngày " +
        `('Dạ em giữ slot [thời gian] cho mình rồi nha ${state.honorific} [tên], hẹn gặp ${state.honorific} ạ') rồi DỪNG HẲN. ` +
        "Nếu preferredTime chỉ có buổi (sáng/chiều/tối) thì hỏi thêm ngày: " +
        "'Anh/chị muốn đến [buổi] ngày nào để em giữ slot ạ' " +
        "TUYỆT ĐỐI KHÔNG hỏi thêm bất cứ điều gì khác.]"
      );
    } else {
      hints.push(
        "[GATE: đã gửi QR. Xác nhận và hướng dẫn bước tiếp theo. DỪNG.]",
      );
    }
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

  // ── FITNESS: OPENING — chào + giới thiệu 4 dịch vụ, KHÔNG dùng "3 hình thức" ──
  if (
    flow === "fitness" &&
    stage === "opening" &&
    knownInfo.serviceType === null &&
    knownInfo.fitnessGoal === null
  ) {
    return `[EXAMPLE — OPENING: chào + liệt kê 4 DỊCH VỤ với xuống dòng]
"Dạ chào ${h}, bên em có 4 dịch vụ chính ạ:
- Gym
- Bơi lội (bể 4 mùa, nước nóng quanh năm)
- Yoga (GV Ấn Độ)
- Zumba (GV Ấn Độ)
${h} đang quan tâm môn nào, hay muốn em gợi theo mục tiêu giảm cân / tăng cơ / thư giãn ạ"`;
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

  // ── FITNESS: biết dịch vụ, chưa có mục tiêu, đang discovery → hỏi mục tiêu ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal === null
  ) {
    const svc = knownInfo.serviceType;
    const highlights: Record<string, string> = {
      boi: `Bể bơi bên em là bể 4 mùa duy nhất tại Vĩnh Yên ${h} — nước nóng quanh năm, lọc ozone, có đội cứu hộ.`,
      yoga: `Yoga bên em có GV người Ấn Độ chuyên nghiệp ${h} — 4 ca/ngày nên rất linh hoạt lịch tập.`,
      zumba: `Zumba bên em do GV người Ấn Độ dạy ${h} — 4 ca/ngày, lớp vui và năng động lắm.`,
      gym: `Phòng gym bên em rộng 700m2 trong nhà + 300m2 sân ngoài có mái che ${h} — chứa 100 người mà không chật.`,
      pilates: `Pilates bên em có 13 máy chuẩn quốc tế ${h} — GV chứng chỉ quốc tế, mới khai trương 12/2024.`,
      full: `Thẻ Full cho ${h} dùng cả 4 dịch vụ: Gym, Bơi, Yoga và Zumba — từ 1.2tr/tháng.`,
    };
    const highlight =
      highlights[svc] ??
      `Dịch vụ ${svc} bên em rất được hội viên yêu thích ${h}.`;
    return `[EXAMPLE — BUILD INTEREST + HỎI MỤC TIÊU, KHÔNG BÁO GIÁ GÓI]
Khách: "muốn đăng ký ${svc}" / "cho hỏi lớp ${svc}"
Em: "${highlight}
     ${h} muốn tập để giảm mỡ, tăng cơ hay thư giãn phục hồi — để em gợi đúng hướng nha"
⚠️ KHÔNG liệt kê gói hoặc báo giá ở bước này.`;
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
    const closingLine = hasContact
      ? `Dạ em giữ slot ${preferredTime ?? "..."} cho mình rồi nha ${h} ${knownInfo.name}, hẹn gặp ${h} ạ`
      : preferredTime
        ? `Để em giữ slot ${preferredTime} cho ${h}, cho em xin tên với SĐT nha`
        : `${h} tiện khung sáng hay chiều để em giữ slot — cho em xin tên với SĐT luôn nha`;

    const timeNote = preferredTime
      ? `ĐÃ BIẾT giờ=${preferredTime} → KHÔNG hỏi giờ lại, kết bằng xin tên/SĐT.`
      : "Chưa có giờ → hỏi giờ ở cuối.";
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

  // Override TACTIC discovery cho 3 trường hợp đặc biệt
  if (state.stage === "discovery" && state.flow === "fitness") {
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
    buildKnowledgeBlock(state, h, message, prevBotReply),
    buildMediaHint(state),
    buildLogicGate(state, message),
    buildFewShot(state, h, prevBotReply, message) ?? "",
  ];

  return lines.filter(Boolean).join("\n");
}

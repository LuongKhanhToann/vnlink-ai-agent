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
  detectAddBookingIntent,
  detectRescheduleIntent,
} from "./stateMachine";
import type { IntentSignal } from "./intent";
import { getTactic } from "./playbook";
import { buildGoalConsultHint } from "./goalConsult";
import { buildDateContext, suggestDatePair, hasConcreteDate, hasDateWindow } from "./dateHelper";

// ─────────────────────────────────────────────
// MULTI-INTENT HINT — render khi KH hỏi 2+ thứ trong 1 tin
// ─────────────────────────────────────────────

/** Convert IntentSignal sang text ngắn để hiển thị trong prefix hint. */
function humanizeSignal(s: IntentSignal): string {
  const domainLabel: Record<string, string> = {
    greeting: "chào hỏi",
    service_inquiry: "hỏi info dịch vụ",
    pricing: "hỏi giá/gói",
    scheduling: "hỏi lịch/giờ",
    discovery_answer: "trả lời discovery",
    safety_concern: "lo ngại an toàn",
    objection: "phản đối/so sánh",
    commitment: "muốn chốt/đăng ký",
    media_request: "xin xem ảnh/video",
    edge: "câu hỏi ngoài kịch bản",
    chitchat: "filler",
  };
  const base = domainLabel[s.domain] ?? s.domain;
  const parts: string[] = [base];
  if (s.attribute) parts.push(`(${s.attribute})`);
  if (s.service) parts.push(`về ${s.service}`);
  return parts.join(" ");
}

/**
 * Build hint hướng dẫn agent cover SECONDARY intents trong cùng 1 reply.
 * Return "" nếu không có secondary intent.
 *
 * Đặt ở CUỐI prefix (sau GATE) để agent đọc cuối cùng, dễ tích hợp vào reply.
 */
function buildMultiIntentHint(state: ConversationState): string {
  // Lọc secondary KHÔNG phải câu hỏi cần trả lời riêng:
  //   - greeting: câu chào đã nằm trong "Dạ..." của reply chính → KHÔNG append "Dạ em chào..."
  //     (classifier temp thấp vẫn thỉnh thoảng đẩy greeting/general_hi làm secondary khi tin gộp
  //      có cả lời chào lẫn nội dung → append câu chào vào CUỐI reply = lỗi "mash" loạn).
  //   - chitchat / filler: không có nội dung để cover.
  const ACTIONABLE = (s: IntentSignal): boolean =>
    s.domain !== "greeting" && s.domain !== "chitchat";
  const secondaries = (state.secondaryIntents ?? []).filter(ACTIONABLE);
  if (secondaries.length === 0) return "";
  const list = secondaries.map(humanizeSignal).join(" + ");
  return (
    `[MULTI-INTENT: KH còn hỏi: ${list}. ` +
    `→ Điền 1-2 câu NGẮN cover các điểm này vào FIELD 'secondaryAnswers' (mảng string), ` +
    `KHÔNG nhét vào 'text'. Post-process sẽ tự append vào cuối reply. ` +
    `Nếu GATE/TACTIC ở trên bảo "DỪNG / KHÔNG pitch giá" → BỎ secondary nào trùng nội dung bị cấm; ` +
    `chỉ giữ secondary informational (giờ, địa chỉ, có HLV nữ không, có ảnh không, ...).]`
  );
}

/**
 * Far-context multi-service: khi KH đã quan tâm 2+ bộ môn xuyên các turn,
 * render hint nhắc bot NHỚ tất cả & tư vấn SONG SONG từng môn (không quên môn ở xa).
 * Theo yêu cầu: KHÔNG tự gộp về thẻ Full — chỉ gợi combo khi KH hỏi giá-cả-2/combo.
 * Return "" khi < 2 môn (không cần nhắc).
 */
function buildServicesContextHint(state: ConversationState): string {
  const svcLabelMap: Record<string, string> = {
    gym: "Gym",
    yoga: "Yoga",
    zumba: "Zumba",
    boi: "Bơi",
    pilates: "Pilates",
  };
  const list = (state.servicesInterested ?? [])
    .map((s) => svcLabelMap[s] ?? s)
    .filter(Boolean);
  if (list.length < 2) return "";
  const focus = state.knownInfo.serviceType;
  const focusLabel = focus ? svcLabelMap[focus] ?? focus : null;
  return (
    `[CONTEXT đa môn: KH đang quan tâm ${list.join(", ")}` +
    (focusLabel ? ` (đang bàn: ${focusLabel})` : "") +
    `. NHỚ & trả lời ĐÚNG từng môn khách hỏi, đừng bỏ sót môn đã nhắc ở turn trước. ` +
    `Mỗi môn có lợi ích/giá riêng — ĐỪNG MẶC ĐỊNH gộp hết về thẻ Full chỉ vì khách nhắc nhiều môn. ` +
    `Gợi combo Full khi thật sự hợp mục tiêu khách HOẶC khi khách hỏi giá cả gói / muốn tập nhiều môn — để khách tự chọn lẻ hay combo.]`
  );
}

/**
 * KH nhắn CỤT (1-4 từ, ≤30 ký tự) — tín hiệu khách lười gõ / dò chừng, KHÔNG phải tín hiệu
 * muốn nghe pitch dài. Vd "gym", "giảm cân", "tối", "bao nhiêu", "có gì".
 * Dùng để bơm [NHỊP] hint giữ reply ngắn + chặn media chủ động (đúng rule fitness.ts:
 * "khách nhắn cụt 2-4 chữ → reply NGẮN, ấm, KHÔNG bung 1 đoạn dài").
 */
export function isTerseMessage(message?: string): boolean {
  if (!message) return false;
  const m = message.trim();
  if (m.length === 0 || m.length > 30) return false;
  const words = m
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 1 && words.length <= 4;
}

/**
 * Tin CHỈ là lời chào / gọi trống — KHÔNG mang thông tin mới (vd "hiii e", "alo",
 * "ê em ơi", "chào shop", "em ơi"). Strip hết từ chào + đại từ gọi + tiểu từ; còn
 * lại ≤1 ký tự → coi là bare greeting. Dùng cho GUARD re-greeting (chặn pitch lại).
 *
 * CỐ Ý KHÔNG bắt "ok/ừ/được/dạ vâng" (có thể là CÂU TRẢ LỜI selecting, không phải chào)
 * và KHÔNG bắt tin có bộ môn/mục tiêu/số ("hi gym", "giảm cân") — chỉ chặn chào suông.
 */
export function isBareGreetingOrFiller(message?: string): boolean {
  const t = (message || "").toLowerCase().trim();
  if (!t || t.length > 25) return false;
  const tokens = t
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;

  // ⚠️ KHÔNG dùng \b (vô hiệu với ký tự tiếng Việt) — phân loại theo TOKEN.
  // HELLO = từ chào; PING = gọi trống ("ơi", "ê"); FILLER = đại từ/tiểu từ vô nghĩa.
  const isHello = (w: string) =>
    /^(h+i+|h+e+l+o+|hello|helo|h[eế]l[oô]|a?l[oô]+|l[oô]+|chào|chao|hế|gm|good|morning|xin)$/u.test(w);
  const isPing = (w: string) => /^(ơi|oi|ới|ê+|êi)$/u.test(w);
  const FILLER = new Set([
    "em","e","anh","a","chị","chi","mình","minh","tôi","toi","bạn","ban",
    "ad","admin","shop","ạ","dạ","da","vâng","vang","nhé","nha","với","voi",
  ]);

  let hasHook = false;
  for (const w of tokens) {
    if (isHello(w) || isPing(w)) {
      hasHook = true;
      continue;
    }
    if (FILLER.has(w)) continue;
    // Token lạ (bộ môn/mục tiêu/số/câu trả lời) → KHÔNG phải chào suông.
    return false;
  }
  // Cần ÍT NHẤT 1 từ chào/gọi → tránh bắt nhầm "dạ vâng"/"ạ" (có thể là câu trả lời).
  return hasHook;
}

/**
 * Hint nhắc agent SOI độ ngắn tin khách → reply ngắn, 1 bước, không bung pitch/media.
 * Return "" khi tin không cụt. Đặt CUỐI prefix để model đọc cuối, ưu tiên cao cho ràng buộc độ dài.
 */
function buildTerseHint(state: ConversationState, message?: string): string {
  if (!isTerseMessage(message)) return "";
  // Đang chốt (đủ tên+SĐT) thì câu xác nhận vốn đã ngắn — không cần hint, tránh nhiễu.
  if (
    state.stage === "commitment" &&
    state.knownInfo.name &&
    state.knownInfo.phone
  )
    return "";
  const preview = (message ?? "").trim().slice(0, 24);
  return (
    `[NHỊP: KH vừa nhắn rất ngắn ("${preview}") → trả NGẮN 1-2 câu ấm, làm ĐÚNG 1 bước, ` +
    `tối đa 1 câu hỏi. ❌ KHÔNG bung InBody/bảng gói/list dài. ❌ KHÔNG chủ động gửi ảnh trừ khi khách xin xem.]`
  );
}

/**
 * SALE-SENSE — nhịp CHỐT theo CẢM XÚC khách (emotion) + độ "chín" của context.
 *
 * Đọc emotion như một sale thật, thay vì rập khuôn theo stage:
 *   - ẤM (excited/trusting)  → TIẾN 1 nhịp: mạnh dạn mời thử / đo InBody / gợi ghé hôm nào.
 *   - PHÂN VÂN (hesitant)    → LÙI nhẹ: gãi đúng băn khoăn, mời trải nghiệm KHÔNG cam kết, không ép.
 *   - LO (anxious)           → TRẤN AN cụ thể trước, hạ lo ngại rồi mới mời thử, chưa bung giá.
 *   - BỰC (frustrated)       → lắng nghe & gỡ đúng vấn đề, KHÔNG pitch/chốt vội.
 *   - neutral + đã có momentum + đang ở stage pitch → nudge 1 CTA nhẹ để hội thoại không "chết".
 *
 * Advisory — chỉ điều tiết GIỌNG & HƯỚNG, defer cho GATE/TACTIC khi mâu thuẫn. Chỉ inject ở PITCH.
 * Return "" khi chưa tới lúc (opening lạnh / đã đủ tên+SĐT / retention) để khỏi nhiễu token.
 */
function buildSaleSenseHint(state: ConversationState, _message?: string): string {
  const { stage, emotion, knownInfo, flow, honorific } = state;

  // Đã đủ tên+SĐT → đang chốt slot (GATE commitment lo). retention/recovery có concierge riêng.
  if (knownInfo.name && knownInfo.phone) return "";
  if (stage === "retention" || stage === "recovery") return "";

  const hasMomentum =
    flow === "fitness"
      ? knownInfo.fitnessGoal !== null || knownInfo.serviceType !== null
      : knownInfo.painArea !== null;

  // Opening/discovery + cảm xúc trung tính + chưa có gì → còn đang thăm dò, đừng chốt sớm.
  if (
    (stage === "opening" || stage === "discovery") &&
    emotion === "neutral" &&
    !hasMomentum
  )
    return "";

  const h = resolveHonorific(honorific);
  const trialWord = flow === "fitness" ? "thử 1 buổi / đo InBody miễn phí" : "thử 1 buổi không cam kết";

  switch (emotion) {
    case "excited":
    case "trusting":
      return (
        `[SALE-SENSE: khách đang ẤM/xuôi theo — đây là lúc TIẾN 1 nhịp, đừng hỏi lan man thêm. ` +
        `Chốt mềm tự nhiên: mời ${trialWord} + gợi ghé "${flow === "fitness" ? "sáng hay chiều" : "buổi nào"} tiện" để giữ momentum. ` +
        `Nếu GATE/TACTIC đã bảo xin tên/SĐT hoặc DỪNG → theo GATE.]`
      );
    case "hesitant":
      return (
        `[SALE-SENSE: khách đang PHÂN VÂN — ĐỪNG push chốt hay xin info dồn. Gãi đúng điều khách lăn tăn, ` +
        `đưa 1 lý do an tâm cụ thể, mời trải nghiệm KHÔNG cam kết ("${h} ${trialWord} rồi quyết cũng được ạ"). Hỏi nhẹ 1 điều khách còn băn khoăn.]`
      );
    case "anxious":
      return (
        `[SALE-SENSE: khách đang LO (sợ tập sai/đau/không theo kịp) — TRẤN AN cụ thể trước ` +
        `(có HLV/KTV kèm, điều chỉnh theo sức, người mới tập được), hạ lo ngại rồi mới nhẹ nhàng mời ${trialWord}. CHƯA bung giá/gói.]`
      );
    case "frustrated":
      return (
        `[SALE-SENSE: khách đang KHÓ CHỊU — lắng nghe & ghi nhận trước, trả lời THẲNG đúng câu hỏi, ` +
        `KHÔNG pitch/không chốt vội. Lấy lại thiện cảm đã rồi mới dẫn dắt tiếp.]`
      );
    default:
      // neutral nhưng đã có momentum & đang stage pitch → nudge 1 CTA nhẹ proactive.
      if (
        hasMomentum &&
        (stage === "inbody" || stage === "evaluation" || stage === "negotiation")
      ) {
        return (
          `[SALE-SENSE: đã đủ context mà turn này chưa có lời mời hành động — kết bằng 1 CTA NHẸ ` +
          `(mời ${trialWord} HOẶC gợi ghé xem trực tiếp), đừng để hội thoại "chết" sau khi tư vấn xong. 1 câu, không ép.]`
        );
      }
      return "";
  }
}

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
  const m = message.toLowerCase().trim();
  // "thôi" standalone hoặc cụt — KH muốn dừng: "thôi", "thôi nha", "thôi em", "thôi vậy"
  // (KHÔNG match "thôi vẫn tập gym" / "thôi đi" — có cue tiếp tục)
  if (
    /^thôi\s*[.!?]?$/.test(m) ||
    /^thôi\s+(nha|nhé|à|vậy|em|anh|chị|ạ|nhỉ)\s*[.!?]?$/.test(m) ||
    /^(không\s+cần\s+(đâu|nữa)?|không\s+nữa|không\s+rồi)\s*[.!?]?$/.test(m) ||
    /^(nghĩ\s+thêm\s+đã|để\s+(em|anh|chị)\s+suy\s+nghĩ)\s*[.!?]?$/.test(m)
  ) {
    return true;
  }
  return (
    /thôi\s+(để|tham\s?khảo|xem)|tham\s?khảo\s+thêm|cho\s+(em|anh|chị)\s+nghĩ/.test(m) ||
    /chưa\s+(quyết|cần|gấp|liền)|không\s+(cần\s+gấp|gấp)/.test(m) ||
    /(lúc|khi|hôm)\s+khác|sau\s+(hẵng|nha)|để\s+(mai|sau)/.test(m)
  );
}

/**
 * Khách phản đối giá / xin giảm / chê đắt / so đối thủ.
 *
 * Lưới TẤT ĐỊNH cho GATE objection (buildLogicGate) — fire kể cả khi classifier LLM
 * miss/mis-label, để bot luôn reframe VALUE thay vì tụt giá.
 *
 * Siết để TRÁNH false-positive:
 *   - "thắc mắc" (không phải "mắc tiền"), "giảm cân" (goal, không phải giảm giá)
 *   - hỏi ưu đãi theo NHÓM (SV/HS/gia đình/công ty) — đó là hỏi gói ưu đãi, có template riêng,
 *     KHÔNG phải chê đắt → return false để pricing/template tương ứng xử lý.
 *   - "ưu đãi/khuyến mãi" suông — là hỏi promo, không phải objection.
 */
export function detectPriceObjection(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // Loại trừ hỏi ưu đãi theo nhóm → không coi là chê đắt.
  if (/(sinh\s*viên|học\s*sinh|\bsv\b|\bhs\b|gia\s*đình|nhân\s*viên|công\s*ty|cả\s*nhóm|đoàn)/.test(m)) {
    return false;
  }
  return (
    /đắt/.test(m) ||                                                         // "đắt", "đắt quá", "đắt đỏ"
    (/(mắc|chát)\s*(quá|lắm|vậy|thế|rồi)/.test(m) && !/thắc\s*mắc/.test(m)) || // "mắc quá" (trừ "thắc mắc")
    /(giá|tiền|phí|gói|thẻ)[^.!?]{0,12}(cao|mắc|chát)\b/.test(m) ||          // "giá hơi cao", "thẻ mắc"
    /giảm\s*giá|bớt\s*(giá|tiền|chút|được|đi|cho|tí)|giảm\s+(được|giá)|rẻ\s+hơn\b|giá\s+(mềm|tốt)\s+hơn/.test(m) ||
    /(shop|chỗ|bên|nơi|trung\s*tâm|phòng)\s+(kia|khác)\s+(rẻ|tốt|hơn|mềm)/.test(m)
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
 * Khách hỏi CÓ/KHÔNG về sự TỒN TẠI của dịch vụ ("có gói gym giảm mỡ không", "có lớp yoga không",
 * "bên em có PT không") — KHÔNG phải hỏi giá. Sale thật phải AFFIRM "Dạ có ạ" trước rồi mới discovery,
 * KHÔNG bổ thẳng giá/teaser "333k" (anchor thấp, mời mặc cả — bug §3).
 *
 * VI-safe: \b KHÔNG match "có"/"không" (ký tự có dấu) → dùng lookaround \p{L} + flag u (bài học Batch 2b/6h).
 * Bảo thủ: yêu cầu ĐỦ 3 phần (có + danh từ dịch vụ + phủ định "không/chứ") để tránh false-positive.
 */
export function detectServiceAvailabilityQuestion(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  const hasCo = /(?<!\p{L})có(?!\p{L})/u.test(m);
  const hasNeg = /(?<!\p{L})(không|ko|khong|hông|hong|chứ)(?!\p{L})/u.test(m);
  const hasServiceNoun =
    /(gói|khoá|khóa|lớp|dịch\s*vụ|gym|yoga|zumba|bơi|pilates|(?<!\p{L})pt(?!\p{L})|hlv|huấn\s*luyện)/u.test(
      m,
    );
  return hasCo && hasNeg && hasServiceNoun;
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

// REMOVED: detectChuongTrinhConsult, detectTrialAsk, detectExplicitPriceList,
// detectFullPackageConfirm, detectChuaBietTapGi, detectThamQuan
// Đã thay thế bằng LLM intent classification (state.intentTopic). Xem questionFlow.ts.

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
      "tang-can": "fitness-gym",
      "suc-khoe": "fitness-gym",
      "giu-dang": "fitness-gym",
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

  // Ảnh before-after (hội viên lột xác) chỉ hợp khi khách có mục tiêu đổi vóc dáng. Khi khách đang
  // NGHI NGỜ kết quả / từng thất bại (đọc emotion từ classifier — frustrated/anxious/hesitant) →
  // before-after là ảnh CHỨNG MINH KẾT QUẢ, hợp hơn ảnh cơ sở → để nó làm key chính.
  const goal = state.knownInfo.fitnessGoal;
  const bodyGoal =
    goal === "giam-mo" || goal === "tang-co" || goal === "tang-can" || goal === "giu-dang";
  const doubtful =
    state.emotion === "frustrated" || state.emotion === "anxious" || state.emotion === "hesitant";

  let primary = key;
  let baNote = "";
  if (bodyGoal && doubtful) {
    primary = "fitness-before-after";
    baNote = ` (khách đang nghi ngờ/từng thất bại → ảnh hội viên lột xác thuyết phục hơn ảnh cơ sở).`;
  } else if (bodyGoal) {
    baNote = ` Nếu khách nghi ngờ kết quả thật, dùng key="fitness-before-after" thay cho ảnh cơ sở.`;
  }

  return (
    `[MEDIA: chưa gửi. suggestedKey="${primary}".${baNote} TỰ QUYẾT gọi get-media nếu khách đang phân vân/build-value/xin xem trực tiếp. KHÔNG gửi khi chào hỏi/đang chốt/đang thăm dò. Max 1 lần/conv.]`
  );
}

// ─────────────────────────────────────────────
// LOGIC GATES
// ─────────────────────────────────────────────

export function buildLogicGate(state: ConversationState, message?: string): string {
  const { stage, intent, flow, knownInfo, mediaShown } = state;
  const mediaShownKeys = state.mediaShownKeys ?? [];
  const hints: string[] = [];

  // ── SAFETY ĐÃ TRẤN AN: tránh LLM nhại lại NGUYÊN VĂN đoạn an toàn dài đã nói lượt trước
  // (T1 đã giải thích postpartum → T3 khách hỏi tiếp cùng chủ đề, LLM hay copy lại y hệt → lộ máy).
  // Tín hiệu từ classifier (intentTopic) + state.safetyTopicsCovered (sticky), KHÔNG regex.
  const SAFETY_TOPIC_BY_INTENT: Record<string, string> = {
    ask_postpartum_safety: "postpartum",
    ask_prenatal_safety: "prenatal",
    ask_senior_safety: "senior",
    ask_post_surgery: "post_surgery",
    ask_teen_safety: "teen",
  };
  const curSafety = SAFETY_TOPIC_BY_INTENT[state.intentTopic ?? ""];
  if (curSafety && (state.safetyTopicsCovered ?? []).includes(curSafety)) {
    hints.push(
      "[GATE safety-đã-trấn-an: chủ đề an toàn này em đã giải thích rồi. TUYỆT ĐỐI KHÔNG lặp lại nguyên đoạn cũ. " +
        "Trả lời NGẮN, xác nhận đúng ý khách vừa hỏi (1-2 câu), rồi tiến funnel (gợi đo InBody/qua thử/hỏi lịch).]",
    );
  }

  // ── CROSS-CUTTING: media đã gửi rồi → cấm gọi lại
  // EXCEPT (a) khách EXPLICIT xin xem hoặc (b) khách mention DỊCH VỤ MỚI chưa gửi media.
  const customerAskingMedia = state.intentTopic === "media_request";
  const mentionedKey = message ? detectMentionedServiceKey(message) : null;
  const isNewServiceKey = mentionedKey !== null && !mediaShownKeys.includes(mentionedKey);
  if (mediaShown && !customerAskingMedia && !isNewServiceKey) {
    hints.push(
      "[GATE media-shown: ĐÃ gửi ảnh. KHÔNG gọi lại get-media. Nếu khách xin thêm → text 'em đã gửi rồi nha, mời ghé trực tiếp xem'.]",
    );
  }

  // ── RETENTION (SAU CHỐT): concierge + upsell nhẹ ──
  // Đơn đã chốt & ghi Sheets → bot KHÔNG xin lại tên/SĐT/giờ, KHÔNG pitch lại gói đã chốt.
  // Trả lời answer-first, ấm như đã thân. Chỉ gợi mở thêm khi khách lộ tín hiệu quan tâm.
  // Return SỚM để bỏ qua toàn bộ GATE bán hàng phía dưới (done-slots, commitment, chốt-ngày...).
  if (stage === "retention") {
    const heldName = knownInfo.name ? ` ${state.honorific} ${knownInfo.name}` : "";
    const heldTime = knownInfo.preferredTime ? ` (lịch đã giữ: ${knownInfo.preferredTime})` : "";
    hints.push(
      `[GATE retention — ĐƠN ĐÃ CHỐT${heldTime}. KH${heldName} đặt lịch xong, giờ chỉ trò chuyện. ` +
        `Answer-first ngắn ấm như khách quen, KHÔNG mở lại "Dạ em chào... cảm ơn đã quan tâm". ` +
        `TUYỆT ĐỐI KHÔNG xin lại tên/SĐT/giờ đã có, KHÔNG nhắc "giữ slot... DỪNG", KHÔNG pitch lại gói vừa chốt. ` +
        `Chỉ upsell NHẸ 1 ý khi khách lộ tín hiệu quan tâm (hỏi môn khác/giá/khen). Muốn đặt thêm → hỏi gọn info còn thiếu cho đơn mới. ` +
        `Dặn dò hữu ích nếu hợp cảnh (mang đồ tập, đến sớm 10p).]`,
    );
    // Khách lộ cue "đặt thêm" → hướng dẫn thu thập đơn MỚI (hỏi giờ/môn còn thiếu) rồi xác nhận
    // giữ slot mới. KHÔNG nhầm sang xác nhận lại đơn cũ.
    if (message && detectAddBookingIntent(message)) {
      hints.push(
        `[GATE đặt-thêm: khách muốn đặt THÊM đơn mới (ngoài lịch đã có). Hỏi gọn thông tin còn thiếu cho đơn mới ` +
          `(môn/dịch vụ nào, NGÀY-GIỜ nào — chốt ngày cụ thể kiểu chọn 1-trong-2 nếu khách nói mơ hồ). ` +
          `Nếu đặt hộ NGƯỜI THÂN → xin tên + SĐT của người được đặt (có thể khác mình). ` +
          `Khi đủ → xác nhận "em giữ thêm slot [ngày giờ mới] cho mình nha". KHÔNG nhắc lại / xác nhận lại lịch đơn cũ.]`,
      );
    }
    // Khách ĐỔI LỊCH sau chốt → xác nhận lịch MỚI gọn (đơn cũ sẽ được update trên hệ thống).
    if (message && detectRescheduleIntent(message) && !detectAddBookingIntent(message)) {
      hints.push(
        `[GATE đổi-lịch: khách muốn DỜI lịch đã đặt sang giờ khác. Xác nhận 1 câu "Dạ em đổi lịch sang [giờ mới] cho mình rồi nha ${state.honorific}". ` +
          `Nếu giờ mới còn mơ hồ → chốt ngày cụ thể (chọn 1-trong-2). KHÔNG tạo cảm giác đặt 2 lịch.]`,
      );
    }
    // Limitation 4: hỏi giá SAU chốt → inject PRICING block để báo giá CHÍNH XÁC (GATE mode
    // không tự kèm knowledge). Concierge vẫn trả lời tự nhiên, không pitch ép.
    if (message && detectPriceQuestion(message)) {
      hints.push(
        flow === "fitness" ? buildFitnessPricing(knownInfo) : buildGiaiCoPricing(),
      );
      hints.push(
        `[GATE giá-sau-chốt: khách hỏi giá → báo đúng số trong PRICING ở trên, gọn gàng. KHÔNG ép đăng ký, KHÔNG nhắc lại đơn đã chốt.]`,
      );
    }
    // servicesContextHint (đa môn) được buildPrefixWithMeta append ở cấp GATE-mode → không push lại đây (tránh trùng).
    return hints.join("\n");
  }

  // ── ƯU TIÊN TUYỆT ĐỐI: ĐỦ tên+SĐT+NGÀY CỤ THỂ → chỉ confirm rồi DỪNG ──
  // Chỉ confirm khi giờ-muốn đã có ngày cụ thể (DD/MM). Nếu khách mới nói buổi/cửa
  // sổ mơ hồ ("chiều", "đầu tuần sau") → KHÔNG confirm vội, để xuống GATE chốt-ngày
  // ép khách chọn 1 trong 2 ngày cụ thể (sale cần ngày chuẩn để gọi/đón khách).
  if (
    knownInfo.name !== null &&
    knownInfo.phone !== null &&
    hasConcreteDate(knownInfo.preferredTime)
  ) {
    return `[GATE done-slots: ĐỦ tên=${knownInfo.name}, SĐT=${knownInfo.phone}, ngày=${knownInfo.preferredTime}. Reply 1 CÂU "Dạ em giữ slot ${knownInfo.preferredTime} cho mình rồi nha ${state.honorific} ${knownInfo.name}, hẹn gặp ${state.honorific} ạ" rồi DỪNG. KHÔNG pitch/QR/hỏi thêm.]`;
  }

  // ── Khách đổi giờ (compact) ──
  if (
    message &&
    knownInfo.preferredTime &&
    /(thôi|đổi|chuyển|hoặc|hay là|sang)\s/i.test(message)
  ) {
    hints.push(`[GATE đổi giờ: giờ MỚI="${knownInfo.preferredTime}". Reply phải khớp giờ mới, KHÔNG dùng giờ cũ.]`);
  }

  // GHI CHÚ: các GATE cho topic-mapped intents (full_package_confirm, trial_ask_confirm,
  // intro_trai_nghiem, price_explicit_list, opening_chuong_trinh, opening_chua_biet,
  // intro_giam_can, tham_quan) ĐÃ MIGRATE sang questionFlow.ts. questionFlow chạy TRƯỚC
  // buildLogicGate trong buildPrefix — khi LLM classifier output đúng topic, ANSWER_LOCK
  // template được dùng và buildLogicGate không chạy. Xem questionFlow.TEMPLATES.

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
  // Lưu ý: trường hợp classifier hit `ask_open_hours` topic, questionFlow đã short-circuit
  // với ANSWER_LOCK rồi. GATE này chỉ là safety net khi classifier miss.
  if (message && detectHoursQuestion(message)) {
    const hours = flow === "fitness" ? "5h sáng – 20h30" : "9h – 23h";
    hints.push(
      `[GATE giờ mở cửa: trả "bên em mở từ ${hours} hàng ngày" + hỏi sáng/chiều tiện. ❌ TUYỆT ĐỐI KHÔNG list 3 gói/giá. KHÔNG xin tên/SĐT turn này.]`,
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
  const priceObjectionSignal =
    state.intentTopic === "price_objection" ||
    (message ? detectPriceObjection(message) : false);
  if (priceObjectionSignal && flow === "fitness") {
    return (
      "[GATE: khách phản đối giá. KHÔNG hạ giá, KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê. " +
      "Reframe value 3 mũi (cơ sở 700m2 + bể 4 mùa duy nhất / GV Ấn Độ + InBody miễn phí / social proof hội viên gắn bó 2-3 năm). " +
      "Mời thử 1 buổi miễn phí. KHÔNG xin tên/SĐT tin này.]"
    );
  }
  if (priceObjectionSignal && flow === "giai-co") {
    return (
      "[GATE: khách phản đối giá. Reframe: KTV đào tạo giải phẫu cơ bài bản, tác động đúng nhóm cơ kẹt, đỡ rõ trong 1-2 buổi. " +
      "Mời thử 1 buổi không cam kết.]"
    );
  }

  // ── Khách xin xem ảnh/video (compact) ──
  if (customerAskingMedia) {
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

  // GHI CHÚ: GATE cho zumba_vs_aerobic, zumba_weight_loss, pool_audience_ask,
  // pool_child_no_age, pool_child_with_age ĐÃ MIGRATE sang questionFlow.TEMPLATES.
  // questionFlow chạy trước buildLogicGate trong buildPrefix.

  // ── Multi-service: khách nhắc 2+ dịch vụ trong 1 tin (compact) ──
  // Yêu cầu: tư vấn SONG SONG từng môn, KHÔNG tự lái về Full. Chỉ chốt Full khi khách
  // chủ động hỏi giá-cả-gói/combo hoặc muốn tập nhiều môn 1 lúc.
  const wantsComboNow =
    message != null &&
    /(combo|cả\s*(gói|hai|2|ba|3)|trọn\s*gói|tất\s*cả\s*(các\s*)?môn|full|chung\s*1\s*thẻ|dùng\s*chung|bao\s*nhiêu\s*tất)/i.test(
      message,
    );
  if (
    flow === "fitness" &&
    message &&
    /(gym|yoga|zumba|bơi|pilates).{0,30}(và|\+|với)\s*(gym|yoga|zumba|bơi|pilates)/i.test(
      message,
    )
  ) {
    hints.push(
      wantsComboNow
        ? "[GATE multi-service: khách hỏi combo/cả gói → giới thiệu thẻ Full 4 dịch vụ (1.2tr/tháng → 7tr/12 tháng, dùng chung 1 thẻ).]"
        : "[GATE multi-service: khách nhắc 2 môn → trả lời TỪNG môn theo đúng câu hỏi (lợi ích/giá riêng mỗi môn), KHÔNG tự gộp ép thẻ Full. Chỉ khi khách hỏi 'cả gói/combo/tập nhiều môn 1 lúc' mới gợi Full.]",
    );
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

  // ── Gia đình (compact, giá cụ thể) ──
  if (
    flow === "fitness" &&
    knownInfo.memberType === "gia-dinh" &&
    !knownInfo.preferredTime
  ) {
    hints.push(
      "[GATE gia-đình: gói Full gia đình (4 dịch vụ dùng chung 1 thẻ) — 2 người 12 triệu, 3 người 17 triệu, 4 người 20 triệu. Pitch CỤ THỂ với số người, KHÔNG list 4 bộ môn chung chung. Bé < 6 tuổi miễn phí kèm bố mẹ ạ.]",
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

  // ── Khách hỏi CÓ/KHÔNG về dịch vụ ("có gói gym giảm mỡ không") → AFFIRM trước, KHÔNG bổ giá ──
  // Bug §3: bot từng bổ thẳng "ưu đãi chỉ từ 333k/tháng" khi khách MỚI hỏi có/không (anchor thấp,
  // mời mặc cả). Sale thật: "Dạ có ạ" + 1 câu value + 1 câu discovery. Bảo thủ: chỉ early-funnel,
  // KHÔNG phải hỏi giá/lịch/giờ, chưa có tên+SĐT. Return sớm (kèm hint đã có) để chặn inbody/price pitch dưới.
  if (
    flow === "fitness" &&
    message &&
    detectServiceAvailabilityQuestion(message) &&
    !detectPriceQuestion(message) &&
    !detectClassScheduleQuestion(message) &&
    !detectHoursQuestion(message) &&
    !knownInfo.name &&
    !knownInfo.phone &&
    stage !== "retention" &&
    stage !== "commitment"
  ) {
    const svc = knownInfo.serviceType ?? "bộ môn mình quan tâm";
    hints.push(
      `[GATE hỏi-có-không (availability): khách hỏi CÓ/KHÔNG về dịch vụ — TRẢ LỜI THẲNG "Dạ có ạ, bên em có ${svc}" + 1 câu value ngắn (hợp mục tiêu của khách), rồi hỏi 1 câu discovery (đã tập chưa / mục tiêu rõ hơn / tiện lịch nào). ` +
        `TUYỆT ĐỐI KHÔNG bung giá hay "ưu đãi chỉ từ 333k", KHÔNG ép InBody, KHÔNG xin tên/SĐT. Tối đa 1 câu hỏi.]`,
    );
    return hints.join("\n");
  }

  // ── Goal ĐÃ biết + KH cho LỊCH/giờ nhưng chưa chốt bộ môn → recommend value-first, KHÔNG hỏi history lùi ──
  // Bug (real_so_sanh T3): goal=giảm-mỡ đã biết, KH "tập sáng hoặc tối tùy" → bot hỏi LÙI
  // "đã thử tập cách nào chưa" (PITCH tự chọn). Sale thật: ack lịch ngắn + recommend bộ môn hợp goal + mời thử.
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.fitnessGoal !== null &&
    knownInfo.serviceType === null &&
    !knownInfo.name &&
    !knownInfo.phone &&
    message &&
    /(sáng|chiều|tối|trưa|\d+\s*buổi|mỗi\s*tuần|tuần\s*\d|hàng\s*ngày|giờ\s*nào\s*cũng|lúc\s*nào\s*cũng)/iu.test(message) &&
    !detectPriceQuestion(message) &&
    !detectServiceAvailabilityQuestion(message) &&
    !detectClassScheduleQuestion(message) &&
    !detectHoursQuestion(message)
  ) {
    hints.push(
      `[GATE goal-rõ-cho-lịch: đã biết mục tiêu "${knownInfo.fitnessGoal}" + khách vừa cho lịch/giờ → TUYỆT ĐỐI KHÔNG hỏi lại quá khứ/history ("đã tập cách nào chưa"). Ack lịch 1 câu ngắn + RECOMMEND bộ môn hợp mục tiêu (value-first) + mời thử 1 buổi hoặc đo InBody. Tối đa 1 câu hỏi.]`,
    );
    return hints.join("\n");
  }

  // ── Khách hỏi giá (Fami trial-first close style) ──
  if (message && detectPriceQuestion(message) && !knownInfo.name && !knownInfo.phone) {
    if (flow === "fitness") {
      // Theo kịch bản Fami: cần BIẾT BỘ MÔN trước khi bung 3 gói chi tiết.
      //   - Chưa serviceType (kể cả khi có goal) → nói ưu đãi CHUNG 333k/tháng + hỏi bộ môn.
      //   - Đã có serviceType → bung gói theo service+goal (PRICING block lọc).
      // KHÔNG dựa duy nhất vào fitnessGoal — có goal nhưng chưa biết môn vẫn phải hỏi môn trước.
      if (knownInfo.serviceType === null) {
        hints.push(
          "[GATE giá (chưa serviceType): nói ưu đãi CHUNG 'chỉ từ 333k/tháng' + hỏi BỘ MÔN nào. KHÔNG bung 3 gói chi tiết khi chưa biết khách quan tâm bộ môn nào. Vd 'Hiện tại bên em có nhiều ưu đãi chỉ từ 333k/tháng. Không biết " + state.honorific + " đang quan tâm đến bộ môn nào để em tư vấn ưu đãi phù hợp ạ'. KHÔNG xin tên/SĐT, KHÔNG bung PT/Full số cụ thể.]",
        );
      } else {
        hints.push(
          "[GATE giá (đã có service+goal): trả giá CỤ THỂ từ [PRICING] theo service+goal. Vd 'Full 1.2tr/tháng, 3tr/3 tháng, 7tr/12 tháng'. KHÔNG né, KHÔNG xin tên/SĐT.]",
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
  // Dùng flowTurnCount để guard relative trong flow hiện tại (không bị reset count khi switch).
  const fc = state.flowTurnCount ?? state.turnCount;
  if (
    state.stage === "opening" &&
    fc >= 2 &&
    knownInfo.serviceType === null &&
    knownInfo.painArea === null
  ) {
    if (fc >= 3) {
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
      state.intentTopic === "price_ask_generic" ||
      state.intentTopic === "price_explicit_list" ||
      state.intentTopic === "price_with_worry" ||
      state.intentTopic === "price_objection" ||
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
    // Dùng flowTurnCount (per-flow giải cơ) để guard chính xác hơn.
    const ftc = state.flowTurnCount ?? state.turnCount;
    const shouldSkipSpread =
      ftc >= 3 ||
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
    const ftc2 = state.flowTurnCount ?? state.turnCount;
    if (prevAskedMethod || ftc2 >= 3) {
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
      hasConcreteDate(knownInfo.preferredTime)
        ? `[GATE: khách đã xác nhận lịch ${knownInfo.preferredTime}. KHÔNG pitch lại, xin tên+SĐT để giữ slot.]`
        : `[GATE: khách muốn đến (giờ chưa rõ ngày: '${knownInfo.preferredTime}'). KHÔNG pitch lại; xin tên+SĐT + chốt NGÀY cụ thể (xem GATE chốt-ngày).]`,
    );
  }
  // (Removed: giải cơ evaluation pitch GATE — đã có few-shot EXAMPLE với visualize + contrast + invite.)

  // ── DATE-PIN (sớm): khách có Ý ĐỊNH đến nhưng CHƯA chốt NGÀY cụ thể ──
  // Quy trình 2 bước:
  //   BƯỚC 1 — khách mới nói buổi (chỉ "sáng"/"chiều") hoặc chưa nói ngày → HỎI MỞ
  //            "qua hôm nào" để khách tự chọn ngày trước.
  //   BƯỚC 2 — khách nói cửa sổ mơ hồ ("đầu tháng sau"/"tuần sau"/"cuối tuần") hoặc đã
  //            được hỏi mở rồi mà vẫn chung chung → MỚI ÉP CHỌN-1-TRONG-2 ngày cụ thể.
  // Stage commitment có nhánh riêng bên dưới → loại ra đây để tránh 2 GATE trùng.
  if (
    stage !== "commitment" &&
    (intent === "selecting" || intent === "ready") &&
    !hasConcreteDate(knownInfo.preferredTime) &&
    !((state as any).qrShown ?? false)
  ) {
    const prevAskedOpenDay = state.lastBotReply
      ? /hôm nào|ngày nào/i.test(state.lastBotReply)
      : false;
    if (!hasDateWindow(knownInfo.preferredTime) && !prevAskedOpenDay) {
      hints.push(
        `[GATE hỏi-ngày: khách muốn đến nhưng CHƯA nói ngày` +
          (knownInfo.preferredTime ? ` (mới có '${knownInfo.preferredTime}')` : "") +
          `. HỎI MỞ 1 câu 'Anh/chị tiện qua hôm nào ạ' để khách tự chọn ngày. ` +
          `CHƯA ép chọn 1-trong-2 vội. Tối đa 1 câu hỏi.]`,
      );
    } else {
      const { options } = suggestDatePair(knownInfo.preferredTime);
      const prevAskedDate = state.lastBotReply
        ? /tiện hơn|xếp .{0,6}vào/i.test(state.lastBotReply)
        : false;
      hints.push(
        prevAskedDate
          ? `[GATE chốt-ngày (lần 2 — khách còn lưỡng lự): ĐỪNG lặp y nguyên câu trước, NÓI CÁCH KHÁC cho tự nhiên. ` +
              `Dùng giả định chốt ấm áp 'Vậy em xếp anh/chị vào ${options[0]} cho chắc chỗ nha, thích ${options[1]} thì nhắn em đổi'. Gọn, dễ nghe, kích chốt. Tối đa 1 ý.]`
          : `[GATE chốt-ngày: khách đã nói cửa sổ mơ hồ` +
              (knownInfo.preferredTime ? ` ('${knownInfo.preferredTime}')` : "") +
              ` → chốt ngày kiểu CHỌN-1-TRONG-2: hỏi 'Anh/chị qua ${options[0]} hay ${options[1]} tiện hơn ạ?'. ` +
              `Tối đa 1 câu hỏi. (Cửa sổ gần chỉ cần nói thứ, không cần kèm ngày.)]`,
      );
    }
  }

  // ── COMMITMENT: chốt lịch — luôn ÉP ngày cụ thể (chọn 1-trong-2) ──
  if (stage === "commitment") {
    const { name, phone } = knownInfo;
    const concreteDate = hasConcreteDate(knownInfo.preferredTime);
    const qrShown = (state as any).qrShown ?? false;
    const prevAskedContact = state.lastBotReply
      ? /(cho\s+em\s+xin\s+tên|xin\s+tên\s+(với|và)\s+sđt|cho\s+em\s+xin\s+(tên|liên\s+hệ))/i.test(
          state.lastBotReply,
        )
      : false;
    // Đã đưa khách 2 ngày turn trước mà vẫn chưa chốt → ĐỪNG ép lại (tránh làm phiền).
    const prevAskedDate = state.lastBotReply
      ? /tiện hơn ạ|\d{1,2}\/\d{1,2}.*\d{1,2}\/\d{1,2}/i.test(state.lastBotReply)
      : false;
    const prevAskedOpenDay = state.lastBotReply
      ? /hôm nào|ngày nào/i.test(state.lastBotReply)
      : false;
    // Khách chưa nói cửa sổ ngày (null/chỉ buổi) & chưa được hỏi mở → BƯỚC 1: hỏi mở "hôm nào".
    // Có cửa sổ mơ hồ / đã hỏi mở rồi → BƯỚC 2: ép chọn 1-trong-2 ngày.
    const askOpenDayFirst =
      !hasDateWindow(knownInfo.preferredTime) && !prevAskedOpenDay;
    const { options } = suggestDatePair(knownInfo.preferredTime);
    const dayChoice = `${options[0]} hay ${options[1]}`;

    let cmt: string;
    if (!name || !phone) {
      if (prevAskedContact) {
        cmt = "prev đã xin tên/SĐT mà khách chưa cho → answer câu khách hỏi rồi DỪNG, KHÔNG xin lại. Reply ≤150 chars.";
      } else if (!concreteDate) {
        // TÁCH: chốt NGÀY trước (chỉ hỏi ngày), CHƯA xin tên/SĐT turn này — tránh dồn dập.
        // Khi khách chốt được 1 ngày cụ thể → turn sau mới xin tên+SĐT.
        cmt = askOpenDayFirst
          ? `khách CHƯA nói ngày → HỎI MỞ 'anh/chị tiện qua hôm nào ạ'. CHỈ hỏi ngày, CHƯA xin tên/SĐT, CHƯA ép chọn 1-trong-2, KHÔNG nhắc giá/gói.`
          : `khách đã nói cửa sổ mơ hồ → ÉP CHỌN ngày 'anh/chị qua ${dayChoice} tiện hơn ạ'. CHỈ hỏi ngày, CHƯA xin tên/SĐT turn này, KHÔNG nhắc giá/gói.`;
      } else {
        cmt = `đã chốt ngày=${knownInfo.preferredTime} → giờ chỉ xin tên+SĐT (1 câu). KHÔNG hỏi lại ngày.`;
      }
    } else if (!concreteDate) {
      if (prevAskedDate) {
        cmt = `đã có tên/SĐT, turn trước đã đưa 2 ngày mà khách chưa chốt → KHÔNG ép lại: note theo '${knownInfo.preferredTime ?? "ý khách"}', báo 'em giữ slot, sẽ gọi xác nhận ngày giờ cụ thể với mình ạ' rồi DỪNG.`;
      } else if (askOpenDayFirst) {
        cmt = `đã có tên/SĐT nhưng khách CHƯA nói ngày → HỎI MỞ 'Anh/chị tiện qua hôm nào ạ' để khách tự chọn. CHƯA ép chọn 1-trong-2 vội.`;
      } else {
        cmt = `đã có tên/SĐT, khách đã nói cửa sổ mơ hồ → ÉP CHỌN 1-TRONG-2: 'Anh/chị qua ${dayChoice} tiện hơn ạ?'.`;
      }
    } else if (!qrShown) {
      cmt = `ĐỦ INFO (tên=${name}, SĐT=${phone}, ngày=${knownInfo.preferredTime}). Xác nhận 1 câu: 'Em giữ slot ${knownInfo.preferredTime} cho mình rồi nha ${state.honorific} ${name}' rồi DỪNG.`;
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
  //   giam-mo          → Full (cardio+gym) + Gym + PT (đốt mỡ nhanh). Bỏ Pilates/Yoga lẻ trừ khi svc=yoga.
  //   tang-co/tang-can → Gym + PT (xây/tăng cơ). Bỏ Yoga/Zumba/Bơi. (tang-can dùng chung nhánh tang-co.)
  //   thu-gian         → Yoga/Zumba + Pilates. Bỏ Gym/PT trừ khi svc=gym.
  //   hoc-boi          → Học bơi + Bơi NL. Bỏ Gym/Yoga/Pilates.
  //   suc-khoe/giu-dang/null → Full + service đã chọn (nếu có). (giu-dang dùng chung nhánh suc-khoe.)

  const showGym = goal === "giam-mo" || goal === "tang-co" || goal === "tang-can" || goal === "suc-khoe" || goal === "giu-dang" || goal === null
    ? !svc || svc === "gym" || svc === "full"
    : svc === "gym";
  const showPT = goal === "giam-mo" || goal === "tang-co" || goal === "tang-can"
    ? !svc || svc === "gym" || svc === "full"
    : false;
  const showYogaZumba = goal === "thu-gian" || goal === "suc-khoe" || goal === "giu-dang" || goal === null
    ? !svc || svc === "yoga" || svc === "zumba" || svc === "full"
    : svc === "yoga" || svc === "zumba";
  const showBoi = goal === "hoc-boi" || goal === "suc-khoe" || goal === "giu-dang" || goal === null
    ? !svc || svc === "boi" || svc === "full"
    : svc === "boi";
  const showPilates = goal === "thu-gian" || goal === "tang-co" || goal === "tang-can" || goal === null
    ? svc === "pilates"
    : svc === "pilates";

  // Anchor "FULL 4 dịch vụ" — chỉ ưu tiên khi không phải single-service hard-lock.
  const fullIsAnchor =
    goal === "giam-mo" || goal === "suc-khoe" || goal === "giu-dang" || goal === null;
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
  "Đắt quá" → Reframe bằng VALUE: "Full 7tr/12 tháng đi kèm phòng gym 700m2 máy chuẩn QT, bể bơi 4 mùa duy nhất Vĩnh Yên, Yoga & Zumba GV người Ấn Độ, lại có bãi đỗ xe rộng cả ô tô & xe máy đi tập thoải mái ${h}. Hội viên bên em hay gắn bó dài và rủ thêm bạn bè vào tập cùng — anh/chị qua thử 1 buổi cảm nhận thực tế nha". KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG giảm giá. Offer gói ngắn nếu vẫn từ chối.
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
  const askingPrice =
    state.intentTopic === "price_ask_generic" ||
    state.intentTopic === "price_explicit_list" ||
    state.intentTopic === "price_with_worry" ||
    (message ? detectPriceQuestion(message) : false);
  const objectingPrice = state.intentTopic === "price_objection";
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
        `[CENTER: Fami Fitness & Yoga Center Vĩnh Yên | 05:00–20:30 | Thành lập 2014\n` +
        `  Bơi → Bể 4 mùa 350m2 DUY NHẤT Vĩnh Yên, nước nóng quanh năm, lọc ozone\n` +
        `  Gym → 700m2 trong nhà + 300m2 ngoài có mái che, chứa 100 người\n` +
        `  Yoga/Zumba → GV người Ấn Độ chuyên nghiệp, 4 ca/ngày\n` +
        `  Pilates → 13 máy chuẩn quốc tế, GV chứng chỉ QT (từ 12/2024)\n` +
        `  Tiện ích → bãi đỗ xe rộng (cả ô tô & xe máy), không gian thoáng không chen chúc giờ cao điểm]`,
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

  // ── KHÁCH HỎI GIÁ lần đầu (chưa biết bộ môn) — Fami trial-first close ──
  // Phong cách Fami: nói giá "ưu đãi chỉ từ Xk/tháng" → hỏi BỘ MÔN nào (TL kịch bản).
  // Trigger khi serviceType=null — kể cả có goal vẫn phải hỏi bộ môn trước khi bung 3 gói.
  if (
    state.flow === "fitness" &&
    !prevHadPricing &&
    message &&
    detectPriceQuestion(message) &&
    state.knownInfo.serviceType === null
  ) {
    return `[EXAMPLE — KHÁCH HỎI GIÁ lần đầu (chưa biết bộ môn): TRIAL-FIRST CLOSE phong cách Fami]
Khách: "bao nhiêu tiền/tháng" / "giá thế nào" / "có ưu đãi gì không"
ĐÚNG (chọn 1):
  (a) "Dạ hiện tại bên em có rất nhiều ưu đãi chỉ từ 333k/tháng ${h}. Vì ${h} là người mới, em tặng ${h} chương trình trải nghiệm thử để xem có phù hợp không. ${h} có muốn đăng ký trải nghiệm không ạ?"
  (b) "Dạ trung tâm mở từ 5h–20h30, giá ưu đãi chỉ từ 333k/tháng. Không biết ${h} đang quan tâm bộ môn nào để em tư vấn gói phù hợp ạ?"
SAI: bung 3 gói chi tiết ngay (Gym 5tr/PT 6tr/Full 7tr); pitch InBody; hỏi 'tập để làm gì' (quá direct).
NGUYÊN TẮC: nói giá ƯU ĐÃI chung chung → hỏi bộ môn / MỜI trải nghiệm → khách trả lời bộ môn mới bung gói cụ thể.`;
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
    // GUARD: KH hỏi FAQ off-topic → KHÔNG ép pitch InBody — answer câu hỏi trước.
    if (
      message &&
      (detectHoursQuestion(message) ||
        detectClassScheduleQuestion(message) ||
        detectFacilityQuestion(message, flow) ||
        state.intentTopic === "ask_open_hours" ||
        state.intentTopic === "pool_hours" ||
        state.intentTopic === "pool_temperature" ||
        state.intentTopic === "pool_swimwear" ||
        state.intentTopic === "pool_chlorine" ||
        state.intentTopic === "pool_water_change" ||
        state.intentTopic === "pool_lifeguard" ||
        state.intentTopic === "pool_traffic" ||
        state.intentTopic === "pool_limit" ||
        state.intentTopic === "guidance_ask" ||
        state.intentTopic === "combo_service_ask" ||
        state.intentTopic === "maintain_after_goal" ||
        state.intentTopic === "new_class_inquiry" ||
        state.intentTopic === "class_has_newbies")
    ) {
      return null;
    }
    const goal = knownInfo.fitnessGoal ?? "mục tiêu";
    return `[EXAMPLE — INBODY PITCH: text thuần, KHÔNG **bold**, KHÔNG giá/gói]
1 message = xác nhận lịch ngắn + pitch Inbody + câu mời. KHÔNG kèm bất cứ gì khác.

SAI: "Với lịch X, ${h} có thể chọn Full 12 tháng 7tr..."  ← nhảy gói
ĐÚNG: "Dạ, để ${goal} hiệu quả thì cần kết hợp tập luyện đúng hướng ${h}. Bên em đo InBody miễn phí lần đầu, HLV phân tích tỷ lệ mỡ cơ rồi tư vấn lộ trình chuẩn luôn. ${h} qua thử 1 buổi để dễ chọn gói ạ"`;
  }

  // ── FITNESS: đang evaluation → show gói có narrative ──
  if (
    flow === "fitness" &&
    stage === "evaluation" &&
    knownInfo.serviceType !== null
  ) {
    // GUARD: KH hỏi FAQ off-topic (giờ mở cửa, lịch lớp, cơ sở vật chất) → KHÔNG pitch 3 gói.
    // Để GATE/template trả lời câu hỏi cụ thể trước. Sale tự nhiên là answer-first.
    if (
      message &&
      (detectHoursQuestion(message) ||
        detectClassScheduleQuestion(message) ||
        detectFacilityQuestion(message, flow) ||
        state.intentTopic === "ask_open_hours" ||
        state.intentTopic === "pool_hours" ||
        state.intentTopic === "pool_temperature" ||
        state.intentTopic === "pool_swimwear" ||
        state.intentTopic === "pool_chlorine" ||
        state.intentTopic === "pool_water_change" ||
        state.intentTopic === "pool_lifeguard" ||
        state.intentTopic === "pool_traffic" ||
        state.intentTopic === "pool_limit" ||
        state.intentTopic === "guidance_ask" ||
        state.intentTopic === "combo_service_ask" ||
        state.intentTopic === "maintain_after_goal" ||
        state.intentTopic === "new_class_inquiry" ||
        state.intentTopic === "class_has_newbies")
    ) {
      return null;
    }
    const svc = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal ?? "sức khỏe tổng thể";

    // Goal-specific value hint
    const goalHint: Record<string, string> = {
      "tang-co": `Tăng cơ cần tập có hệ thống + kỹ thuật đúng giai đoạn đầu → nhấn PT cá nhân, cộng thêm Yoga/Pilates để phục hồi cơ. KHÔNG chỉ nhấn diện tích phòng.`,
      "tang-can": `Tăng cân khoa học = tăng cơ nạc, KHÔNG tích mỡ bụng/tích nước → nhấn PT lên giáo án tăng khối cơ + thực đơn 5-6 bữa dễ ăn, InBody đo lượng cơ thiếu + chuyển hóa cơ bản để nạp dinh dưỡng chính xác.`,
      "giam-mo": `Giảm mỡ hiệu quả = cardio + weight training kết hợp → nhấn thẻ Full (Gym + Zumba/Bơi dùng chung), bể bơi 4 mùa duy nhất Vĩnh Yên. KHÔNG chỉ nhấn diện tích phòng.`,
      "thu-gian": `Thư giãn → nhấn Yoga GV Ấn Độ 4 ca/ngày linh hoạt lịch + không gian rộng không chen chúc.`,
      "hoc-boi": `Học bơi → nhấn bể 4 mùa duy nhất Vĩnh Yên + cam kết biết bơi sau khóa (học lại miễn phí).`,
      "suc-khoe": `Sức khỏe tổng thể → nhấn thẻ Full 4 dịch vụ trong 1 thẻ, dùng cả năm bảo lưu được khi bận.`,
      "giu-dang": `Giữ dáng = duy trì vóc dáng săn chắc + tinh chỉnh vùng chưa ưng → nhấn thẻ Full đa năng đổi môn cho đỡ chán, InBody theo dõi định kỳ.`,
    };
    const specificHint =
      goalHint[goal] ??
      `Nhấn điểm khác biệt cụ thể của ${svc} phù hợp mục tiêu ${goal}.`;

    // Concrete package examples per goal — correct anchor order: high → mid → light
    const goalPackages: Record<string, string> = {
      "giam-mo":
        `Full 12 tháng 7tr — Gym + Bơi + Yoga + Zumba 1 thẻ, kết hợp cardio + weight + xả stress (giải pháp giảm cân Fami)\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — tự tập, tiết kiệm\n` +
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 kèm sát cho ai muốn đốt mỡ nhanh + đúng kỹ thuật`,
      "tang-co":
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 xây kỹ thuật nền đúng, tránh chấn thương\n` +
        `Full 12 tháng 7tr — Gym + Yoga/Pilates phục hồi cơ trong 1 thẻ\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — tự tập theo lịch dài hơi`,
      "tang-can":
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 lên giáo án tăng khối cơ + thực đơn 5-6 bữa dễ ăn\n` +
        `Full 12 tháng 7tr — Gym + Yoga/Pilates phục hồi cơ trong 1 thẻ\n` +
        `Gym fulltime 12 tháng 5tr — tự tập tập trung nhóm cơ ngực/xô/mông/đùi`,
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
      "giu-dang":
        `Full 12 tháng 7tr — Gym + Bơi + Yoga + Zumba 1 thẻ, đổi môn duy trì vóc dáng đỡ chán\n` +
        `Full 6 tháng 4.5tr — đủ 4 dịch vụ, thử 6 tháng trước\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — giữ form gọn nhẹ nếu muốn đơn giản`,
    };
    const concretePackages =
      goalPackages[goal] ??
      `[gói cao nhất] [giá] — [lý do gắn ${goal}]\n[gói vừa] [giá] — [lý do]\n[gói nhẹ nhất] [giá] — thử trước`;

    // NHỊP TƯ VẤN: chỉ bung bảng giá KHI khách chủ động hỏi giá. Khách mới cho 1 chi tiết
    // ấm (lịch/buổi/kinh nghiệm) mà CHƯA hỏi giá → trial-first, gợi 1 hướng + mời InBody.
    // Đổ cả 3 gói lúc khách chưa hỏi = "tờ rơi", mất tự nhiên (user feedback 2026-05).
    const askedPriceNow = message ? detectPriceQuestion(message) : false;
    if (askedPriceNow) {
      return `[EXAMPLE — KHÁCH HỎI GIÁ ở evaluation: bung DẦN, KHÔNG đổ cả 3 gói thành bảng. Reply ≤ 260 ký tự]
Value 1 câu: ${specificHint}
Gói tham chiếu (anchor cao→nhẹ — CHỌN 1 gói anchor + 1 gói nhẹ hơn để nói, KHÔNG đọc cả 3):
${concretePackages}
Mẫu: "[1 câu value]. Phù hợp nhất với ${h} là [gói anchor + giá] ạ. Nếu muốn nhẹ hơn thì có [1 gói tiết kiệm + giá]. ${h} ghé đo InBody miễn phí 1 buổi rồi HLV tư vấn lộ trình chuẩn nha?"
SAI: liệt kê cả 3 gói thành danh sách khô; lặp giá đã pitch tin trước.`;
    }
    return `[EXAMPLE — TRIAL-FIRST, KHÔNG dump bảng giá. Reply ≤ 220 ký tự, giọng trò chuyện, 1-MOVE]
Khách vừa cho 1 chi tiết ấm (lịch/buổi/kinh nghiệm) và CHƯA hỏi giá → ĐỪNG đổ 3 gói (nghe như tờ rơi). Soi độ dài: khách nhắn cụt → reply NGẮN ấm.
Value theo mục tiêu: ${specificHint}
Cấu trúc: (1) ACK ấm chi tiết khách vừa nói (KHÔNG khen "tốt/hợp lý"). (2) Gợi 1 HƯỚNG phù hợp nhất + lý do ngắn, KHÔNG kèm số giá. (3) Mời đo InBody/thử 1 buổi miễn phí + hỏi nhẹ buổi nào (sáng/chiều).
Mẫu: "Dạ chiều ${h} ghé sau giờ làm cũng tiện ạ. Người mới muốn giảm mỡ thì em gợi bắt đầu Gym kết hợp Zumba cho đỡ chán mà đốt mỡ tốt. ${h} ghé đo InBody miễn phí 1 buổi để HLV xem mỡ cơ rồi lên lộ trình chuẩn nha, ${h} tiện chiều nào ạ?"
SAI: ACK + value + 3 gói + câu hỏi dồn 1 tin; bung giá khi khách chưa hỏi.`;
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

/** Phase 7: prefix metadata cho observability log. */
export interface PrefixResult {
  prefix: string;
  mode: "SCRIPT" | "GATE" | "PITCH";
  /** ID template fired (chỉ có ở SCRIPT mode). */
  templateId: string | null;
}

/**
 * Backward-compat: buildPrefix vẫn return string. Đi kèm buildPrefixWithMeta() cho caller mới.
 */
export function buildPrefix(
  state: ConversationState,
  message?: string,
  prevBotReply?: string,
): string {
  return buildPrefixWithMeta(state, message, prevBotReply).prefix;
}

// ─────────────────────────────────────────────────────────────
// LEGACY prefix builder — GIỮ NGUYÊN cho flow GIAI-CO.
// Fitness đã chuyển sang buildFitnessLeanPrefix (xem cuối file).
// Tên đổi từ buildPrefixWithMeta → buildPrefixLegacy; dispatcher mới ở cuối file
// route fitness → lean brief, giai-co → hàm này (zero-regression cho giai-co).
// ─────────────────────────────────────────────────────────────
function buildPrefixLegacy(
  state: ConversationState,
  message?: string,
  prevBotReply?: string,
): PrefixResult {
  const h = resolveHonorific(state.honorific);

  // ═══════════ PREFIX MODE DISPATCH (giai-co only) ═══════════
  // SCRIPT mode (template engine) đã GỠ — fitness nay đi qua buildFitnessLeanPrefix.
  // Còn lại 2 mode cho giai-co:
  //   GATE    = hard-override logic (done-slots / cold-lead / acute-injury / deposit / objection)
  //             → minimal prefix, GATE là single source of truth
  //   PITCH   = no template, no GATE override → full prefix với TACTIC + KNOWLEDGE + FEW-SHOT
  // ─────────────────────────────────────────────

  // Multi-intent hint + far-context multi-service hint — render 1 lần, append vào cả 3 mode.
  const multiIntentHint = buildMultiIntentHint(state);
  const servicesContextHint = buildServicesContextHint(state);
  // NHỊP hint — KH nhắn cụt → reply ngắn, append vào cả 3 mode (đặt cuối cho salience cao).
  const terseHint = buildTerseHint(state, message);

  // ─── GUARD: RE-GREETING / FILLER GIỮA CHỪNG ───
  // KH chỉ chào lại / nhắn trống ("hiii e", "alo", "ê em ơi") khi cuộc thoại ĐÃ đi xa
  // (stage qua opening, đã có context) mà KHÔNG có thông tin mới → KHÔNG được bung lại
  // PITCH (lặp InBody/gói/giá = lộ máy + nhàm). Sale thật: "Dạ em đây ạ" + 1 câu re-hook nhẹ.
  // Bug thực tế: "hiii e" ở stage=evaluation (gym+giảm-mỡ) → bot pitch lại InBody y PREV.
  // Bỏ qua retention (concierge GATE riêng) & lúc đang chốt (đủ tên+SĐT — câu xác nhận vốn ngắn).
  if (
    message &&
    isBareGreetingOrFiller(message) &&
    state.turnCount > 1 &&
    state.stage !== "opening" &&
    state.stage !== "retention" &&
    state.stage !== "commitment" &&
    !(state.knownInfo.name && state.knownInfo.phone)
  ) {
    console.log(`[prefix] MODE=GATE re-greeting ("${message.trim().slice(0, 16)}") → reply nhẹ, KHÔNG pitch`);
    // Bare greeting giữa cuộc = sale thật chỉ "Dạ em đây ạ" rồi chờ. KHÔNG ép re-hook,
    // KHÔNG nhồi KNOWN/services/PREV (chỉ tổ bloat → model nói thừa, lộ máy).
    // Xưng hô chưa rõ ("anh/chị") → BỎ luôn, "Dạ em đây ạ" không cần hô vẫn tự nhiên.
    const hg = h === "anh/chị" ? "" : h;
    const example = hg ? `"Dạ em đây ${hg} ạ" / "Dạ ${hg} ơi"` : `"Dạ em đây ạ" / "Dạ em nghe ạ"`;
    const lines = [
      `[GATE re-greeting: KH chỉ "ới"/chào trống, CHƯA hỏi gì. Trả lời ĐÚNG 1 câu CỰC NGẮN ` +
        `(≤6 chữ) kiểu nhắn nhanh: ${example}. ` +
        `❌ KHÔNG hỏi thêm, KHÔNG pitch gói/giá/InBody, KHÔNG nhắc nội dung cũ, KHÔNG xin tên/SĐT.]`,
    ];
    return {
      prefix: lines.filter(Boolean).join("\n"),
      mode: "GATE",
      templateId: null,
    };
  }

  // MODE = SCRIPT (template engine) đã GỠ (refactor 2026-06-15) — chỉ giai-co dùng hàm này,
  // và template engine vốn chỉ phục vụ fitness. Fitness nay đi qua buildFitnessLeanPrefix.

  let tactic = getTactic(state.flow, state.stage, state.emotion);
  // Cờ: TACTIC override theo cảm xúc (hesitant/anxious) đã ôm trọn nội dung SALE-SENSE
  // → skip saleSenseHint để KHÔNG inject 2 block trùng (model nhỏ cover cả 2 = reply dài, lặp).
  let emotionTacticApplied = false;

  // (Override TACTIC hesitant/anxious cho FITNESS đã gỡ — fitness dùng buildFitnessLeanPrefix.)

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

  // (Override TACTIC lịch-lớp / discovery (chỉ-tập-X, PT, hỏi-giá, compare) / inbody-skip cho FITNESS
  //  đã gỡ — toàn bộ fitness nay đi qua buildFitnessLeanPrefix. buildPrefixLegacy chỉ còn phục vụ giai-co.)

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

  // Build GATE → detect mode
  const gateOutput = buildLogicGate(state, message);
  const isOverrideGate =
    /chấn thương cấp|done-slots|đang lạnh|phản đối giá|GATE deposit|cold lead|GATE retention/i.test(
      gateOutput,
    );

  // ─── MODE = GATE (override) ───
  if (isOverrideGate) {
    console.log(`[prefix] MODE=GATE`);
    const lines: string[] = [
      `[HON: ${h}] [STAGE: ${state.stage}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
      `[TACTIC: ƯU TIÊN [GATE] ở dưới — viết theo đúng GATE, KHÔNG pitch/list/nhảy chủ đề khác.]`,
      `[RULES: Văn nói NGẮN GỌN, text thuần KHÔNG markdown. Tối đa 1 câu hỏi, kết "?"/"ạ?". CẤM khen đáp án khách, "tuyệt vời/chắc chắn rồi", "nha?".]`,
      antiLoopHint,
      buildKnownSummary(state.knownInfo, state.flow),
      gateOutput,
      servicesContextHint,
      multiIntentHint,
      terseHint,
    ];
    return {
      prefix: lines.filter(Boolean).join("\n"),
      mode: "GATE",
      templateId: null,
    };
  }

  // ─── MODE = PITCH (no template, no GATE override) ───
  console.log(`[prefix] MODE=PITCH stage=${state.stage}`);

  // Slim PITCH: skip Knowledge khi commitment + đủ name/phone (đang chốt slot, không cần pitch nữa).
  const isLateCommitment =
    state.stage === "commitment" &&
    state.knownInfo.name !== null &&
    state.knownInfo.phone !== null;
  // Slim PITCH: skip Few-shot khi commitment đã có slot OR khi stage retention/recovery.
  const skipFewShot =
    isLateCommitment ||
    state.stage === "retention" ||
    state.stage === "recovery";

  const knowledgeBlock = isLateCommitment
    ? ""
    : buildKnowledgeBlock(state, h, message, prevBotReply);
  const fewShotBlock = skipFewShot
    ? ""
    : buildFewShot(state, h, prevBotReply, message) ?? "";
  const missingSlotHint = buildMissingSlotHint(
    state.knownInfo,
    state.flow,
    state.intent,
    state.stage,
  );

  // KH nhắn cụt → KHÔNG chủ động gợi media (trừ khi khách explicit xin xem) — tránh bung dài.
  const customerAskingMedia =
    state.intentTopic === "media_request" ||
    (message ? detectMediaRequest(message) : false);
  const mediaHint =
    isTerseMessage(message) && !customerAskingMedia ? "" : buildMediaHint(state);

  // SALE-SENSE: điều tiết nhịp chốt theo cảm xúc khách — chỉ ở PITCH (bot có tự do diễn đạt).
  // Tin cụt thì terseHint đã ghì độ dài; sale-sense vẫn hữu ích nhưng nhường terse nếu trùng hướng.
  // Skip nếu TACTIC override hesitant/anxious đã fire (cùng nội dung → tránh 2 block trùng).
  const saleSenseHint = emotionTacticApplied ? "" : buildSaleSenseHint(state, message);

  // TƯ VẤN MỤC TIÊU: nội dung funnel 5 bước theo goal (giảm cân/tăng cân/giữ dáng),
  // slice theo stage. Đặt cạnh saleSenseHint (cùng tầng advisory, defer cho GATE/TACTIC).
  const goalConsultHint = buildGoalConsultHint(state);

  const lines: string[] = [
    `[HON: ${h}] [STAGE: ${state.stage}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
    `[TACTIC: ${tactic}]`,
    `[RULES: Nhắn như sale thật đang chat — văn nói, NGẮN GỌN, text thuần KHÔNG markdown. Mặc định 1-2 câu (≤200 chữ); CHỈ khi liệt kê 3+ gói mới xuống dòng "-" mỗi mục (≤350 chữ). Giá viết bằng chữ ("12 tháng 5 triệu", "3 buổi/tuần") — KHÔNG để "12m=5tr","|","=". ACK trung tính ("Dạ vâng ${h}") rồi vào ý chính: CẤM khen đáp án khách (tuyệt vời/tốt quá/hợp lý/chuẩn rồi/lý tưởng...), CẤM đọc lại nguyên văn lời khách, CẤM "em note/ghi nhận", CẤM "em gửi hình" khi không gọi tool. Tối đa 1 câu hỏi, kết "?" hoặc "ạ?" (KHÔNG "nha?"). Đọc TACTIC/GATE/KNOWLEDGE rồi TỰ viết — KHÔNG chép lại.]`,
    antiLoopHint,
    buildKnownSummary(state.knownInfo, state.flow),
    missingSlotHint,
    knowledgeBlock,
    mediaHint,
    gateOutput,
    fewShotBlock,
    saleSenseHint,
    goalConsultHint,
    servicesContextHint,
    multiIntentHint,
    terseHint,
  ];

  return {
    prefix: lines.filter(Boolean).join("\n"),
    mode: "PITCH",
    templateId: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEAN BRIEF (fitness) — REFACTOR 2026-06-15
// ───────────────────────────────────────────────────────────────────────────
// Bỏ toàn bộ máy SCRIPT/GATE/PITCH nhồi lời thoại mẫu ("đo InBody… sáng hay
// chiều"). Thay bằng 1 "bản tin tình huống" gọn: nói cho model BIẾT đang ở đâu
// trong funnel + cần KHAI THÁC gì tiếp — KHÔNG đưa câu mẫu để chép.
// Văn phong + funnel chi tiết đã nằm ở system prompt (agents/fitness.ts).
//
// NGUYÊN TẮC:
//   • "Rule" = stage focus của funnel (deterministic, từ FSM). LLM tự viết lời.
//   • Mọi quyết-định-hiểu-ý đọc classifier (intentSignal.domain) — KHÔNG regex.
//   • Discovery + body-goal: CẤM mời InBody/đặt lịch/báo giá → ép khai thác nỗi đau.
//   • Fact an toàn (giá thật, lịch, địa chỉ) vẫn bơm để model khỏi bịa.
// ═══════════════════════════════════════════════════════════════════════════

const BODY_GOAL_SET = new Set(["giam-mo", "tang-can", "tang-co", "giu-dang"]);

function goalLabelVi(goal: string | null): string {
  switch (goal) {
    case "giam-mo": return "giảm cân/giảm mỡ";
    case "tang-can": return "tăng cân";
    case "tang-co": return "tăng cơ";
    case "giu-dang": return "giữ dáng/săn chắc";
    case "thu-gian": return "thư giãn/giảm stress";
    case "hoc-boi": return "học bơi";
    default: return "tập luyện";
  }
}

/**
 * VIỆC CẦN LÀM theo bước funnel hiện tại (state.stage do FSM tính).
 * Đây là "luật" mềm: hướng model làm đúng nhịp, KHÔNG ép lời.
 */
function buildFitnessStageFocus(state: ConversationState): string {
  const { stage, knownInfo: ki } = state;
  const goal = ki.fitnessGoal;
  const svc = ki.serviceType;

  if (stage === "opening") {
    return "[VIỆC CẦN LÀM — MỞ ĐẦU] Chào ấm 1 câu rồi hỏi khách quan tâm bộ môn nào / mục tiêu gì. Mỗi tin 1 ý, chưa pitch gì vội.";
  }

  if (stage === "discovery") {
    // CRUX FIX: body-goal → khai thác nỗi đau, CẤM chốt sớm.
    if (goal && BODY_GOAL_SET.has(goal)) {
      const dir =
        goal === "tang-can" || goal === "tang-co"
          ? "tăng"
          : goal === "giu-dang"
            ? "muốn săn chắc/gọn"
            : "giảm";
      return (
        `[BƯỚC: KHAI THÁC] Khách muốn ${goalLabelVi(goal)}. Đang HIỂU khách, chưa chốt. ` +
        `Hỏi gọn từng ý (1 câu/tin), khai thác dần: cao–nặng & số kg muốn ${dir}; vùng tự ti; thói quen sinh hoạt; đã thử cách nào chưa hiệu quả. ` +
        `⛔ KHÔNG InBody, KHÔNG đặt lịch/"sáng hay chiều", KHÔNG báo giá, KHÔNG recommend gói.`
      );
    }
    if (svc && !goal) {
      return `[BƯỚC: KHAI THÁC] Khách quan tâm ${svc}. Hỏi đã tập ${svc} chưa + mục tiêu (1 ý/tin). Chưa báo giá/đặt lịch.`;
    }
    return `[BƯỚC: KHAI THÁC] Hỏi mục tiêu / bộ môn khách quan tâm (1 ý/tin). Chưa báo giá/đặt lịch.`;
  }

  if (stage === "inbody") {
    return (
      `[VIỆC CẦN LÀM — CAM KẾT BẰNG SỐ LIỆU] Đã khai thác đủ → GIỜ giới thiệu đo InBody MIỄN PHÍ như GIÁ TRỊ tự nhiên ` +
      `(máy bóc tách mỡ/cơ thật, HLV lên lộ trình chuẩn thay vì tập mù). Nói value 1-2 câu rồi hỏi 1 câu MỞ bám mục tiêu/động lực của khách. ` +
      `Cá nhân hóa theo trải nghiệm khách (đọc lịch sử chat, đừng hỏi lại nếu đã rõ): khách CHƯA biết tập → nhấn cần HLV/PT lên giáo án + thực đơn cho đúng, tránh tập mù; khách ĐÃ biết tập → nhấn tối ưu chi phí bằng thẻ hội viên + tự dựa chỉ số InBody chọn máy/vùng tập. ` +
      `⛔ KHÔNG hỏi "sáng hay chiều", KHÔNG rủ đặt lịch / chọn buổi, CHƯA báo giá — đặt lịch là việc của bước CHỐT khi khách đã muốn đến.`
    );
  }

  if (stage === "evaluation" || stage === "negotiation") {
    return (
      `[VIỆC CẦN LÀM — TƯ VẤN & TẠO ĐỘNG LỰC] CHỦ ĐỘNG dẫn dắt, đừng trả lời xong để lửng. Recommend DỨT KHOÁT 1 hướng hợp mục tiêu (value-first, không "cả 2 đều tốt"). ` +
      `Tạo động lực bằng KẾT QUẢ khách sẽ đạt + ưu đãi nhẹ. Gợi đo InBody / thử 1 buổi như bước trải nghiệm value. ` +
      `Có thể thúc nhẹ bằng 2 đòn (chỉ khi tự nhiên, KHÔNG ép, KHÔNG mỗi tin một lần): suất trải nghiệm miễn phí có GIỚI HẠN theo tuần (tạo lý do hành động sớm); rủ thêm bạn/người thân tập cùng có ƯU ĐÃI nhóm + đỡ ngại, dễ duy trì. ⛔ KHÔNG bịa con số cụ thể (còn mấy suất, giảm bao nhiêu %) — nói chung "đang giới hạn suất" / "có ưu đãi nhóm" thôi. ` +
      `Khi mời chốt buổi: DẪN bằng 1 lý do cụ thể (em giữ chỗ trước / HLV chuẩn bị lộ trình + InBody cho mình) rồi mới hỏi giờ — ĐỪNG hỏi trống "tiện qua hôm nào". ` +
      `⛔ CHỈ chốt buổi khi khách đã GẬT muốn đến. CHỈ bung giá/gói khi khách HỎI giá. KHÔNG ép.`
    );
  }

  if (stage === "commitment") {
    if (ki.name && ki.phone && ki.preferredTime) {
      return `[VIỆC CẦN LÀM — CHỐT XONG] Đã đủ tên+SĐT+giờ → xác nhận giữ slot 1 câu NGẮN rồi DỪNG. KHÔNG hỏi lại thông tin đã có.`;
    }
    return (
      `[VIỆC CẦN LÀM — CHỐT HẸN] Khách sẵn sàng → CHỦ ĐỘNG dẫn: nêu 1 lý do giá trị ngắn cho việc ghé (em giữ slot / HLV chuẩn bị lộ trình & InBody) rồi mới xin thông tin còn thiếu (tên/SĐT/buổi tiện). ` +
      `ĐỪNG hỏi trống "tiện hôm nào". Tách ngày khỏi tên+SĐT, KHÔNG dồn dập.`
    );
  }

  if (stage === "retention") {
    return `[VIỆC CẦN LÀM — SAU CHỐT] Đơn đã đặt → chăm khách như khách quen, answer-first mọi câu hỏi. KHÔNG xin lại thông tin đã có, KHÔNG pitch lại gói vừa chốt.`;
  }
  if (stage === "recovery" || stage === "objection") {
    return `[VIỆC CẦN LÀM — GỠ BĂN KHOĂN] Khách đang chững/lưỡng lự → gãi đúng điều khách lăn tăn, lùi nhẹ. KHÔNG ép xin info/đặt lịch ở tin này.`;
  }
  return "";
}

/**
 * ANSWER-FIRST theo intent của khách (đọc classifier domain — KHÔNG regex).
 * Khách hỏi thẳng cái gì thì trả thẳng cái đó trước, rồi mới dẫn funnel.
 */
function buildFitnessAnswerFirst(state: ConversationState): string {
  const sig = state.intentSignal;
  const domain = sig?.domain ?? null;
  const attr = sig?.attribute ? ` (${sig.attribute})` : "";
  switch (domain) {
    case "pricing":
      return `[KHÁCH ĐANG HỎI GIÁ: trả thẳng vào giá theo bảng PRICING dưới — gói phù hợp NHẤT trước (1 anchor + giá) rồi mới hé gói nhẹ hơn. KHÔNG hỏi lại "muốn tập gì", KHÔNG né sang InBody.]`;
    case "scheduling":
      return `[KHÁCH HỎI LỊCH/GIỜ: trả lịch sơ bộ (Yoga/Zumba 4 ca/ngày sáng-trưa-chiều-tối; Gym & Bơi mở 5h–20h30) — KHÔNG trả bằng bảng giá.]`;
    case "safety_concern":
      return `[KHÁCH LO AN TOÀN${attr}: trấn an cụ thể + lưu ý an toàn (có HLV kèm chỉnh động tác/điều chỉnh theo sức; bệnh nền thì khuyên giấy khám/hỏi HLV trước). KHÔNG ép gói.]`;
    case "objection":
      return `[KHÁCH PHÂN VÂN/CHÊ GIÁ: ghi nhận ngắn → reframe bằng GIÁ TRỊ (cơ sở 700m2 + bể 4 mùa duy nhất + GV Ấn Độ + hội viên gắn bó) + mời thử 1 buổi. KHÔNG hạ giá, KHÔNG chia nhỏ giá/ví dụ ly cà phê.]`;
    case "service_inquiry":
      return `[KHÁCH HỎI VỀ DỊCH VỤ/CƠ SỞ${attr}: trả THẲNG đúng câu hỏi (địa chỉ, giờ mở, cơ sở vật chất, có/không bộ môn, bảo lưu/đổi gói…) rồi mới dẫn tiếp. ĐỪNG pivot sang "quan tâm bộ môn nào" khi khách chưa hỏi.]`;
    case "media_request":
      return `[KHÁCH XIN XEM ẢNH: gọi tool get-media rồi 1 câu dẫn ngắn.]`;
    case "commitment":
      return `[KHÁCH MUỐN ĐĂNG KÝ/CHỐT: xin thông tin còn thiếu gọn gàng, KHÔNG pitch lại gói nữa.]`;
    default:
      return "";
  }
}

/** Nhắc tin trước để khỏi lặp — KHÔNG regex, chỉ cắt chuỗi. */
function buildAntiRepeatHint(prevBotReply?: string): string {
  if (!prevBotReply) return "";
  const trim = prevBotReply.slice(0, 90).split("\n").join(" ");
  return `[TIN TRƯỚC EM ĐÃ NHẮN: "${trim}…" — đừng lặp lại ý này; khách trả lời rồi thì ack 1 câu rồi đi bước tiếp.]`;
}

/**
 * Bản tin tình huống GỌN cho fitness. Thay buildPrefixLegacy ở flow fitness.
 */
function buildFitnessLeanPrefix(
  state: ConversationState,
  message?: string,
  prevBotReply?: string,
): PrefixResult {
  const h = resolveHonorific(state.honorific);
  const ki = state.knownInfo;
  const domain = state.intentSignal?.domain ?? null;

  // ── Re-greeting giữa chừng (classifier domain="greeting") → "Dạ em đây ạ", KHÔNG pitch lại.
  if (
    domain === "greeting" &&
    state.turnCount > 1 &&
    state.stage !== "opening" &&
    state.stage !== "retention" &&
    state.stage !== "commitment" &&
    !(ki.name && ki.phone)
  ) {
    const hg = h === "anh/chị" ? "" : h;
    const example = hg ? `"Dạ em đây ${hg} ạ" / "Dạ ${hg} ơi"` : `"Dạ em đây ạ" / "Dạ em nghe ạ"`;
    return {
      prefix:
        `[GATE re-greeting: KH chỉ chào trống, CHƯA hỏi gì. Trả ĐÚNG 1 câu CỰC NGẮN (≤6 chữ): ${example}. ` +
        `❌ KHÔNG hỏi thêm, KHÔNG pitch gói/giá/InBody, KHÔNG nhắc nội dung cũ, KHÔNG xin tên/SĐT.]`,
      mode: "GATE",
      templateId: null,
    };
  }

  // Pricing facts: chỉ bơm khi khách hỏi giá / chê giá → tránh nhồi bảng giá lúc đang khai thác.
  const pricingBlock =
    domain === "pricing" || domain === "objection" ? buildFitnessPricing(ki) : "";

  // Media: helper đã tự chặn ở opening/discovery/commitment; chỉ gợi khi đúng moment + khách không nhắn cụt.
  const customerAskingMedia =
    domain === "media_request" || (message ? detectMediaRequest(message) : false);
  const mediaHint =
    isTerseMessage(message) && !customerAskingMedia ? "" : buildMediaHint(state);

  // Giới tính SUY TỪ xưng hô đã biết (anh=nam, chị=nữ) — surface để model KHỎI hỏi lại "nam hay nữ".
  const genderKnown =
    state.honorific === "anh" ? "nam" : state.honorific === "chị" ? "nữ" : null;

  const lines: string[] = [
    `[HON: ${h}] [BƯỚC FUNNEL: ${state.stage}] [CẢM XÚC KHÁCH: ${state.emotion}]`,
    genderKnown
      ? `[ĐÃ BIẾT: khách là ${genderKnown} (xưng ${h}) → TUYỆT ĐỐI KHÔNG hỏi lại giới tính nam/nữ.]`
      : "",
    buildKnownSummary(ki, state.flow),
    buildFitnessStageFocus(state),
    buildFitnessAnswerFirst(state),
    pricingBlock,
    buildAntiRepeatHint(prevBotReply),
    mediaHint,
    buildServicesContextHint(state),
    buildMultiIntentHint(state),
    buildTerseHint(state, message),
    `[CÁCH VIẾT: nói như sale Việt thật chat Zalo. Mỗi tin = 1 ack ngắn (nếu cần) + đúng việc cần làm + tối đa 1 câu hỏi, kết "ạ" (KHÔNG dấu "?"). ` +
      `Ngắn, ấm, đi thẳng vào việc — KHÔNG độn câu xã giao/quảng cáo sáo rỗng, đừng dài dòng, đừng chép câu mẫu, đừng dồn nhiều ý 1 tin.]`,
  ];

  // mode: GATE khi đang khóa theo intent cụ thể (giá/chốt) — chỉ để telemetry, không đổi hành vi.
  const mode: PrefixResult["mode"] =
    domain === "pricing" || domain === "commitment" ? "GATE" : "PITCH";

  return {
    prefix: lines.filter(Boolean).join("\n"),
    mode,
    templateId: null,
  };
}

// ─────────────────────────────────────────────────────────────
// DISPATCHER — fitness → lean brief, giai-co → legacy (zero-regression).
// ─────────────────────────────────────────────────────────────
export function buildPrefixWithMeta(
  state: ConversationState,
  message?: string,
  prevBotReply?: string,
): PrefixResult {
  if (state.flow === "fitness") {
    return buildFitnessLeanPrefix(state, message, prevBotReply);
  }
  return buildPrefixLegacy(state, message, prevBotReply);
}

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
  MediaMove,
  resolveHonorific,
  KnownInfo,
  Intent,
  Flow,
  Stage,
  detectAddBookingIntent,
  detectRescheduleIntent,
  detectAcuteInjury,
  isPreferredTimeSpecific,
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
  // GUARD TIN ĐẦU: ở tin nhắn ĐẦU (chào + nêu bộ môn/mục tiêu), classifier đôi khi BỊA 1 secondary
  // informational (giờ giấc / bể / cơ sở) KHÔNG có trong tin → agent xổ cơ sở+giờ lúc chưa ai hỏi
  // (lỗi "tự khai cơ sở/giờ khi khách chưa hỏi"). Tin đầu chỉ tập trung intent CHÍNH (mở discovery),
  // KHÔNG cover secondary. Multi-intent THẬT (khách hỏi 2-3 thứ) gần như luôn ở lượt sau → vẫn giữ.
  if ((state.turnCount ?? 1) <= 1) return "";

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

  // Đã đủ tên+SĐT → đang chốt chỗ (GATE commitment lo). retention/recovery có concierge riêng.
  if (knownInfo.name && knownInfo.phone) return "";
  if (stage === "retention" || stage === "recovery") return "";

  const hasMomentum =
    flow === "fitness"
      ? knownInfo.fitnessGoal !== null || knownInfo.serviceType !== null
      : knownInfo.painArea !== null;

  // Giai-co discovery CHƯA khai thác xong (mới có painArea, chưa có tính chất/thời gian đau) →
  // CHƯA mời trial / gợi 'sáng hay chiều' (bug L3 T4: emotion anxious → SALE-SENSE mời thử buổi
  // giữa lúc còn đào nỗi đau). Đủ painArea + (painSpread HOẶC painDuration) mới sang evaluation.
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    !(knownInfo.painArea && (knownInfo.painSpread || knownInfo.painDuration))
  )
    return "";

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
        `Chốt mềm tự nhiên: mời ${trialWord} rồi giữ momentum bằng cách dẫn sang chốt NGÀY khách tiện (việc hỏi lịch để GATE chốt-ngày lo). ` +
        `⚠ Nếu khách vừa HỎI 1 câu cụ thể (giá, ưu đãi SV, lộ trình, rủ bạn…) thì PHẢI trả thẳng câu đó TRƯỚC — đừng lấy lời mời/chốt lịch để né câu hỏi. ` +
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
    return { topic: "parking", fact: "Bên em có chỗ gửi xe rộng: xe máy miễn phí, ô tô có thu phí" };
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
// detectAcuteInjury moved → stateMachine.ts (để buildNextState corroborate cờ acuteInjuryHold
// mà không tạo circular import). prefixBuilder import lại từ đó.

// REMOVED: detectChuongTrinhConsult, detectTrialAsk, detectExplicitPriceList,
// detectFullPackageConfirm, detectChuaBietTapGi, detectThamQuan
// Đã thay thế bằng LLM intent classification (state.intentTopic). Xem questionFlow.ts.

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

/**
 * Moment bung ảnh BEFORE-AFTER (hội viên lột xác): khách có mục tiêu ĐỔI VÓC DÁNG
 * và đang NGHI NGỜ kết quả (emotion frustrated/anxious/hesitant — đọc thẳng từ classifier,
 * KHÔNG regex/keyword). Đây là ảnh CHỨNG MINH KẾT QUẢ, tách khỏi ngân sách ảnh giới thiệu
 * cơ sở — phải bung được kể cả khi đã lỡ gửi ảnh phòng tập trước đó (vũ khí chốt trust).
 */
/** Emotion nghi ngờ kết quả (đọc thẳng classifier — KHÔNG regex). */
function isDoubtfulEmotion(state: ConversationState): boolean {
  return (
    state.emotion === "frustrated" ||
    state.emotion === "anxious" ||
    state.emotion === "hesitant"
  );
}

/**
 * Key media DETERMINISTIC cần bung khi khách nghi ngờ kết quả — cho CẢ 2 flow.
 * Trả `{ key, guardKey }` hoặc null. `guardKey` dùng để chống gửi lại (lưu trong mediaShownKeys):
 *   - fitness: ảnh before-after (key=guardKey="fitness-before-after") — ngân sách RIÊNG với ảnh cơ sở.
 *   - giai-co: media mr-* (theo painArea). guardKey="doubt:<key>" → tách budget khỏi clip giới thiệu
 *     đã lỡ gửi sớm, để doubt-moment vẫn bung được ĐÚNG ca before-after thuyết phục.
 * Quyết định gửi vẫn do classifier (emotion); chỉ thao tác gửi là deterministic.
 */
/**
 * Chọn ảnh before-after ĐÚNG ca theo mục tiêu khách (slot classifier `fitnessGoal`, KHÔNG regex):
 *   - giảm mỡ / giữ dáng → ảnh GIẢM cân (fitness-before-after-loss)
 *   - tăng cân / tăng cơ → ảnh TĂNG cân (fitness-before-after-gain)
 *   - mục tiêu chưa rõ    → ảnh gộp (fitness-before-after)
 * guardKey LUÔN = "fitness-before-after" → vẫn 1 lần/cuộc (không gửi cả 2 loại cho 1 người).
 */
function beforeAfterTarget(state: ConversationState): { key: string; guardKey: string } {
  const g = state.knownInfo.fitnessGoal;
  const key =
    g === "tang-can" || g === "tang-co"
      ? "fitness-before-after-gain"
      : g === "giam-mo" || g === "giu-dang"
        ? "fitness-before-after-loss"
        : "fitness-before-after";
  return { key, guardKey: "fitness-before-after" };
}

export function computeDoubtMediaKey(
  state: ConversationState,
): { key: string; guardKey: string } | null {
  // Tín hiệu NGHI NGỜ đọc TỪ classifier (KHÔNG regex): cảm xúc nghi ngờ (frustrated/anxious/hesitant)
  // HOẶC domain=objection (khách phản biện/lăn tăn kết quả). mediaMove là cửa CHÍNH; đây là LƯỚI ĐỠ
  // cho lúc mini-model để mediaMove=none (flaky ~1/2 lượt) mà khách rõ ràng đang doubt — vd
  // "tập rồi liệu có xuống ko hay lại lên lại như cũ" hay bị classify objection/discovery_answer, emotion=neutral.
  const doubtSignal =
    isDoubtfulEmotion(state) ||
    state.intentSignal?.domain === "objection" ||
    // "giảm xong lại lên như cũ" / "làm xong có hết hẳn ko hay lại đau lại" — nghi ngờ ĐỘ BỀN kết quả.
    // Mini-model hay map nhầm sang topic maintain_after_goal + emotion trusting/neutral → mediaMove rớt.
    // Đây vẫn là DOUBT kết quả → bung ảnh trước-sau là đúng nhịp (đúng ca scenarios GIAMCAN/GIAICO).
    state.intentTopic === "maintain_after_goal";
  if (!doubtSignal) return null;

  if (state.flow === "fitness") {
    // Khách có mục tiêu ĐỔI VÓC DÁNG + đang doubt → bung ảnh trước-sau BẤT KỂ stage (kể cả discovery):
    // khách tự hỏi "liệu có thật không" thì trả bằng BẰNG CHỨNG là đúng nhịp, không phải chen ngang.
    // Mục tiêu chưa rõ (hỏi giá trơ, chưa có body-goal) → không có gì để chứng minh → bỏ.
    const g = state.knownInfo.fitnessGoal;
    const bodyGoal =
      g === "giam-mo" || g === "tang-co" || g === "tang-can" || g === "giu-dang";
    if (!bodyGoal) return null;
    return beforeAfterTarget(state);
  }

  // giai-co: cần đã pitch value (stage evaluation HOẶC đủ painArea+painSpread) + biết painArea.
  // guardKey = key THẬT (chung ngân sách proactive): các mr-* hiện cùng 1 folder content,
  // nên nếu đã gửi clip giới thiệu rồi thì KHÔNG bung lại — tránh khách thấy trùng video.
  const k = state.knownInfo;
  const allPainSlots = k.painArea !== null && k.painSpread !== null;
  if (state.stage !== "evaluation" && !allPainSlots) return null;
  const key = computeSuggestedMediaKey(state);
  if (!key) return null;
  return { key, guardKey: key };
}

/**
 * Key media CHỦ ĐỘNG cần bung turn này — như một sale khôn khéo, gửi đúng lúc đúng bộ môn.
 * QUYẾT ĐỊNH gửi nằm ở classifier (state.mediaMove); THAO TÁC gửi là deterministic (routerWorkflow
 * fetchMedia thẳng — chống flaky tool-call gpt-5.4-mini phớt lệnh ~50%). Trả { key, guardKey } hoặc null.
 *   - show_results → ảnh kết quả: fitness=before-after, giai-co=mr-* theo painArea.
 *   - show_service → ảnh/video ĐÚNG bộ môn classifier vừa nhận (intentSignal.service) → fallback
 *     serviceType/goal (computeSuggestedMediaKey) → mặc định fitness-gym (CSVC chung) / mr-general.
 * Safety net: domain=media_request (khách XIN xem trực tiếp) luôn coi như show_service — dùng output
 * classifier, KHÔNG regex — để lệnh xin ảnh không bao giờ rớt kể cả khi mediaMove parse trượt.
 * guardKey = key thật → chống gửi lại cùng bộ môn (lưu ở mediaShownKeys, 1 lần/key).
 */
export function computeProactiveMediaKey(
  state: ConversationState,
): { key: string; guardKey: string } | null {
  let move: MediaMove = state.mediaMove ?? "none";
  if (move === "none" && state.intentSignal?.domain === "media_request") {
    move = "show_service";
  }
  if (move === "none") return null;

  if (move === "show_results") {
    if (state.flow === "fitness") {
      return beforeAfterTarget(state);
    }
    const k = computeSuggestedMediaKey(state);
    return k ? { key: k, guardKey: k } : null;
  }

  // show_service — gửi ĐÚNG bộ môn khách đang soi.
  // ⛔ KHÔNG bung ảnh CHỦ ĐỘNG ở tin đầu / lúc còn chào-thăm dò (turnCount<=1 hoặc stage opening) —
  //    trừ khi khách XIN xem trực tiếp (domain=media_request). Gửi sớm = chen ngang, sai nhịp.
  const explicitAsk = state.intentSignal?.domain === "media_request";
  if (!explicitAsk && (state.stage === "opening" || state.turnCount <= 1)) return null;

  if (state.flow === "fitness") {
    const svc = state.intentSignal?.service ?? null;
    const mapSvc: Record<string, string> = {
      gym: "fitness-gym",
      full: "fitness-gym",
      pilates: "fitness-gym",
      yoga: "fitness-yoga",
      zumba: "fitness-zumba",
      boi: "fitness-pool",
    };
    // ⛔ KHÔNG default "fitness-gym" khi không rõ bộ môn — hỏi tiện ích chung ("có sauna/điều hòa
    //    không") KHÔNG được phọt ảnh phòng gym bừa. Không có bộ môn rõ → KHÔNG gửi.
    const key = (svc && mapSvc[svc]) || computeSuggestedMediaKey(state);
    return key ? { key, guardKey: key } : null;
  }

  // giai-co show_service — không rõ ca → KHÔNG gửi ảnh mặc định
  const k = computeSuggestedMediaKey(state);
  return k ? { key: k, guardKey: k } : null;
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

  // (before-after nghi-ngờ-kết-quả cho fitness giờ do router computeDoubtMediaKey lo — deterministic
  //  fetch, không qua GATE prompt. buildLogicGate CHỈ chạy giai-co nên không cần block đó ở đây.)

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
        `TUYỆT ĐỐI KHÔNG xin lại tên/SĐT/giờ đã có, KHÔNG nhắc "giữ chỗ... DỪNG", KHÔNG pitch lại gói vừa chốt. ` +
        `Chỉ upsell NHẸ 1 ý khi khách lộ tín hiệu quan tâm (hỏi môn khác/giá/khen). Muốn đặt thêm → hỏi gọn info còn thiếu cho đơn mới. ` +
        `Dặn dò hữu ích nếu hợp cảnh (mang đồ tập, đến sớm 10p).]`,
    );
    // Khách lộ cue "đặt thêm" → hướng dẫn thu thập đơn MỚI (hỏi giờ/môn còn thiếu) rồi xác nhận
    // giữ chỗ mới. KHÔNG nhầm sang xác nhận lại đơn cũ.
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
      hints.push(buildGiaiCoPricing());
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
    return `[GATE done-slots: ĐỦ tên=${knownInfo.name}, SĐT=${knownInfo.phone}, ngày=${knownInfo.preferredTime}. Reply 1 CÂU "Dạ em giữ chỗ ${knownInfo.preferredTime} cho mình rồi nha ${state.honorific} ${knownInfo.name}, hẹn gặp ${state.honorific} ạ" rồi DỪNG. KHÔNG pitch/QR/hỏi thêm.]`;
  }

  // ── ƯU TIÊN: bot VỪA hỏi "qua hôm nào" + khách đáp bằng CỬA SỔ MƠ HỒ → ép CHỌN-1-TRONG-2 ──
  // Robust trước nhiễu classifier: bug L4 T10 — date "đầu tuần sau" lọt slot 'schedule' (không phải
  // 'preferredTime') + flow lật fitness → gate discovery bắn trước, DATE-PIN dưới không tới. Ở đây
  // đọc window THẲNG từ message (date-parse THUẦN, không phân loại intent) ngay sau câu hỏi-ngày →
  // ưu tiên chốt NGÀY. Chỉ fire đúng nhịp này (lastBotReply vừa hỏi "hôm nào/ngày nào").
  if (
    !(knownInfo.name && knownInfo.phone) &&
    !hasConcreteDate(knownInfo.preferredTime) &&
    !((state as any).qrShown ?? false) &&
    state.lastBotReply &&
    /hôm nào|ngày nào/i.test(state.lastBotReply) &&
    ((message && hasDateWindow(message)) || hasDateWindow(knownInfo.preferredTime))
  ) {
    const windowSrc =
      message && hasDateWindow(message) ? message : knownInfo.preferredTime;
    const { options } = suggestDatePair(windowSrc);
    return (
      `[GATE chốt-ngày (ưu tiên): khách vừa nói cửa sổ mơ hồ ('${(windowSrc || "").trim()}') ngay sau khi em hỏi ngày → ` +
      `chốt kiểu CHỌN-1-TRONG-2: hỏi '${state.honorific} qua ${options[0]} hay ${options[1]} tiện hơn ạ'. ` +
      `⛔ TUYỆT ĐỐI CHƯA xin tên/SĐT — phải chốt được NGÀY cụ thể trước đã. Tối đa 1 câu hỏi.]`
    );
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
  // Sticky: bắn cả các turn SAU khi đã nhận diện cấp tính (state.acuteInjuryHold) — KH hỏi
  // "khi nào qua được" / cảm ơn không được làm bot rơi lại funnel discovery/pitch (bug E1 t2-t3).
  if (
    flow === "giai-co" &&
    ((message && detectAcuteInjury(message)) || (state as any).acuteInjuryHold === true)
  ) {
    return (
      "[GATE chấn thương cấp (an toàn, ưu tiên cao nhất): KH đang chấn thương CẤP TÍNH (vừa bị, sưng nóng). " +
      "TUYỆT ĐỐI KHÔNG mời giải cơ ngay, KHÔNG pitch gói/giá, KHÔNG hỏi discovery (đau lan hay 1 điểm / đã thử cách gì) — đang giai đoạn cấp, hỏi sâu/chốt đơn lúc này là SAI & vô cảm. " +
      "• Nếu KH kể tình trạng: trấn an + khuyên nghỉ 3-5 ngày, chườm đá 15-20 phút, đau tăng/tê chân tay/không nhấc được → đi khám. " +
      "• Nếu KH hỏi 'khi nào qua giải cơ được': trả THẲNG là qua khi hết sưng nóng cấp, thường sau 3-5 ngày, lúc đó KTV mới đánh giá & xử lý — CHƯA chốt ngày, CHƯA xin tên/SĐT. " +
      "• Nếu KH cảm ơn/chào: chào ấm 1 câu, chúc mau khỏe — KHÔNG hỏi thêm, KHÔNG pitch.]"
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
    const hours = "9h – 23h";
    hints.push(
      `[GATE giờ mở cửa: trả "bên em mở từ ${hours} hàng ngày" + hỏi sáng/chiều tiện. ❌ TUYỆT ĐỐI KHÔNG list 3 gói/giá. KHÔNG xin tên/SĐT turn này.]`,
    );
  }

  // ── ƯU TIÊN: khách answer ngắn → ACK luân phiên (xem ACK MẪU trong instructions) ──
  if (message && detectShortAnswer(message)) {
    hints.push(
      `[GATE: khách answer ngắn → MỞ reply bằng ACK luân phiên (xem ACK MẪU trong system prompt — KHÔNG dùng mãi 'em note rồi ạ'). Sau ACK 1 câu mới chuyển ý.]`,
    );
  }

  // ── ƯU TIÊN: khách phản đối giá → reframe theo VALUE ──
  const priceObjectionSignal =
    state.intentTopic === "price_objection" ||
    (message ? detectPriceObjection(message) : false);
  if (priceObjectionSignal) {
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
  //   - giai-co: evaluation, HOẶC khi ĐỦ painArea + painSpread — ngầm hiểu đã sang
  //     evaluation (pitch value + mời thử), kể cả khi stage transition lag do classifier.
  //     KHÔNG fire khi mới có painArea (chưa hỏi painSpread) — moment đó vẫn đang
  //     khai thác triệu chứng, chưa pitch value, gửi ảnh là chen ngang.
  const giaiCoAllPainSlots =
    knownInfo.painArea !== null && knownInfo.painSpread !== null;
  const stageAllowsProactiveMedia =
    stage === "evaluation" || giaiCoAllPainSlots;
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

  // ── Khách hỏi giá → trả giá NGAY (compact) ──
  if (message && detectPriceQuestion(message) && !knownInfo.name && !knownInfo.phone) {
    if (flow === "giai-co") {
      // Số phút/giá buổi lẻ hay bị model nhỏ đọc lệch từ bảng nén "45p(1-2v)=200k|75p=330k" (từng bịa
      // "45 phút 400k"). Bơm mốc RÕ RÀNG ngay điểm quyết: buổi lẻ chỉ có 2 mức, đúng số, KHÔNG chế.
      hints.push(
        "[GATE giá giải cơ: trả giá NGAY, ĐÚNG bảng — buổi lẻ CHỈ 2 mức: 45 phút = 200k, 75 phút = 330k. " +
          "TUYỆT ĐỐI không chế số khác, không để buổi ngắn đắt hơn buổi dài. Liệu trình từ 3.3tr/10 buổi. Rồi gợi thử 1 buổi.]",
      );
    } else {
      hints.push("[GATE giá: trả giá NGAY. Lẻ 200k-590k, liệu trình từ 3.3tr/10 buổi.]");
    }
  }

  // ── Khách hỏi cọc/thanh toán (compact) ──
  if (message && detectDepositAsk(message)) {
    const qrShown = (state as any).qrShown ?? false;
    if (!qrShown) {
      if (knownInfo.name && knownInfo.phone) {
        return `[GATE deposit: GỌI get-qr flow="muscle-release" NGAY. Reply ngắn xác nhận cọc + gửi QR + hướng dẫn nội dung CK (tên+SĐT). Copy qrUrl, nextStep="show_qr".]`;
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

  // ── Negotiation + khách đã chấp nhận (compact) ──
  // CHỐT NGÀY 2 bước: chưa có preferredTime → HỎI NGÀY trước (KHÔNG xin tên/SĐT vội, tránh dồn dập
  // — bug E3 T5). Có ngày rồi → mới xin tên+SĐT.
  if (stage === "negotiation" && (intent === "selecting" || intent === "ready")) {
    hints.push(
      !knownInfo.preferredTime
        ? "[GATE negotiation-accept (chưa có ngày): khách đã gật muốn thử → KHÔNG pitch thêm, KHÔNG xin tên/SĐT vội. HỎI NGÀY trước 1 câu 'Dạ anh/chị tiện qua hôm nào ạ' (khách mơ hồ thì gợi 2 ngày cụ thể). Chốt được NGÀY rồi turn sau mới xin tên+SĐT.]"
        : "[GATE negotiation-accept (đã có ngày): KHÔNG pitch thêm, xin tên+SĐT 1 câu ngắn để giữ chỗ. KHÔNG hỏi lại ngày/giờ đã có.]",
    );
  }

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
    // Chỉ SKIP câu hỏi tính chất đau khi đã THỰC SỰ hỏi mà khách không đáp rõ (ftc≥3).
    // TUYỆT ĐỐI KHÔNG skip chỉ vì painDuration/pastMethod được auto-extract từ CÂU MỞ của khách
    // (vd "dạo này a đau cổ" → classifier set painDuration). Auto-extract ≠ khách đã engage
    // discovery → vẫn phải ĐỒNG CẢM + hỏi 1 câu ở lượt đầu (nếu không sẽ "đọc bài" ngay tin 1).
    const ftc = state.flowTurnCount ?? state.turnCount;
    const shouldSkipSpread = ftc >= 3;
    if (shouldSkipSpread) {
      hints.push(
        "[GATE: đã hỏi mà khách chưa nói rõ tính chất đau → ĐỪNG hỏi lại 'lan ra hay cố định', ĐỪNG tra khảo 'đã thử gì'. " +
          "Đồng cảm 1 câu rồi giải thích NGẮN cơ chế + mời TRẢI NGHIỆM 1 buổi mềm (không ép giờ). Ấm, không đọc bài như tờ rơi.]",
      );
    } else {
      hints.push(
        `[GATE discovery giải cơ (biết vùng_đau=${knownInfo.painArea}, chưa rõ tính chất): ĐỪNG đọc bài, ĐỪNG chốt. ` +
          `Mở bằng ĐỒNG CẢM ngắn, thật, như người thật (1 câu) cho cơn khó chịu của khách. ` +
          `Rồi hỏi 1 câu để HIỂU tình trạng — chọn 1 góc tự nhiên nhất theo ngữ cảnh: đau lan ra hay chỉ 1 điểm / đau lâu chưa / có phải do ngồi nhiều, sai tư thế. ` +
          `⛔ TIN NÀY CHƯA phán "nút thắt/điểm kẹt", CHƯA pitch "KTV bên em", CHƯA contrast massage-vs-sâu, CHƯA mời thử/chốt giờ. ` +
          `Giải thích cơ chế + giá trị + lời mời để DÀNH cho lượt sau, KHI đã hiểu khách. Tối đa 1 câu hỏi, giọng ấm, không liệt kê.]`,
      );
    }
  }

  // ── GIẢI CƠ: biết painArea + painSpread → KHÔNG tra khảo pastMethod, sang tư vấn ──
  // (Bỏ hẳn GATE hỏi "đã thử massage/dán cao chưa": hỏi nó là tra khảo, không đẩy sale, và
  //  từng lặp lại do anti-loop bằng regex lastBotReply không bền. Sale thật: đủ painArea+
  //  painSpread thì pitch value (KTV/điểm-kẹt) + mời 1 buổi thử — giaiCoReadyForEvaluation đã
  //  cho sang evaluation, EXAMPLE evaluation lo phần value. Nếu khách TỰ kể đã thử cách gì →
  //  classifier vẫn extract pastMethod để làm contrast, nhưng KHÔNG cần hỏi.)


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
        ? `[GATE: khách đã xác nhận lịch ${knownInfo.preferredTime}. KHÔNG pitch lại, xin tên+SĐT để giữ chỗ.]`
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
  // Bắn khi: khách gật (intent selecting/ready) HOẶC đã nói cửa sổ mơ hồ ('đầu tuần sau',
  // 'cuối tuần'...). Bug L4 T10: classifier ra intent=explore cho 'đầu tuần sau' → gate cũ
  // (chỉ nhận selecting/ready) bỏ qua → bot xin thẳng tên/SĐT. hasDateWindow bắt được window.
  // Window có thể nằm ở SLOT (classifier extract) HOẶC ngay trong message khách vừa nhắn.
  // Bug L4 T10: classifier 4o-mini lỡ KHÔNG extract "đầu tuần sau" vào slot (flaky) → slot null.
  // Fallback đọc window từ message (date-parse THUẦN, không phải phân loại intent) khi bot vừa
  // hỏi "qua hôm nào" → vẫn pin được ngày, không lệ thuộc extraction chập chờn.
  const prevAskedOpenDay = state.lastBotReply
    ? /hôm nào|ngày nào/i.test(state.lastBotReply)
    : false;
  const slotWindow = hasDateWindow(knownInfo.preferredTime);
  const msgWindow = message ? hasDateWindow(message) : false;
  const windowSrc = slotWindow
    ? knownInfo.preferredTime
    : msgWindow
      ? message
      : knownInfo.preferredTime;
  if (
    stage !== "commitment" &&
    (intent === "selecting" ||
      intent === "ready" ||
      slotWindow ||
      (prevAskedOpenDay && msgWindow)) &&
    !hasConcreteDate(knownInfo.preferredTime) &&
    !((state as any).qrShown ?? false)
  ) {
    if (!slotWindow && !msgWindow && !prevAskedOpenDay) {
      hints.push(
        `[GATE hỏi-ngày: khách muốn đến nhưng CHƯA nói ngày` +
          (knownInfo.preferredTime ? ` (mới có '${knownInfo.preferredTime}')` : "") +
          `. HỎI MỞ 1 câu 'Anh/chị tiện qua hôm nào ạ' để khách tự chọn ngày. ` +
          `CHƯA ép chọn 1-trong-2 vội. ⛔ CHƯA xin tên/SĐT (phải chốt NGÀY trước). Tối đa 1 câu hỏi.]`,
      );
      // Return sớm: chốt NGÀY là việc DUY NHẤT cần làm lúc này — đừng để hint khác làm model
      // nhảy sang xin tên/SĐT (bug L4 T10 / L5 T14: khách nói cửa sổ mơ hồ mà bot xin luôn info).
      return hints.join("\n");
    } else {
      const { options } = suggestDatePair(windowSrc);
      const prevAskedDate = state.lastBotReply
        ? /tiện hơn|xếp .{0,6}vào/i.test(state.lastBotReply)
        : false;
      hints.push(
        prevAskedDate
          ? `[GATE chốt-ngày (lần 2 — khách còn lưỡng lự): ĐỪNG lặp y nguyên câu trước, NÓI CÁCH KHÁC cho tự nhiên. ` +
              `Dùng giả định chốt ấm áp 'Vậy em xếp anh/chị vào ${options[0]} cho chắc chỗ nha, thích ${options[1]} thì nhắn em đổi'. Gọn, dễ nghe, kích chốt. ⛔ CHƯA xin tên/SĐT turn này. Tối đa 1 ý.]`
          : `[GATE chốt-ngày: khách đã nói cửa sổ mơ hồ` +
              (knownInfo.preferredTime ? ` ('${knownInfo.preferredTime}')` : "") +
              ` → chốt ngày kiểu CHỌN-1-TRONG-2: hỏi 'Anh/chị qua ${options[0]} hay ${options[1]} tiện hơn ạ?'. ` +
              `⛔ TUYỆT ĐỐI CHƯA xin tên/SĐT — phải chốt được NGÀY cụ thể trước đã. Tối đa 1 câu hỏi. (Cửa sổ gần chỉ cần nói thứ, không cần kèm ngày.)]`,
      );
      // Return sớm vì lý do như trên.
      return hints.join("\n");
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
        cmt = `đã có tên/SĐT, turn trước đã đưa 2 ngày mà khách chưa chốt → KHÔNG ép lại: note theo '${knownInfo.preferredTime ?? "ý khách"}', báo 'em giữ chỗ, sẽ gọi xác nhận ngày giờ cụ thể với mình ạ' rồi DỪNG.`;
      } else if (askOpenDayFirst) {
        cmt = `đã có tên/SĐT nhưng khách CHƯA nói ngày → HỎI MỞ 'Anh/chị tiện qua hôm nào ạ' để khách tự chọn. CHƯA ép chọn 1-trong-2 vội.`;
      } else {
        cmt = `đã có tên/SĐT, khách đã nói cửa sổ mơ hồ → ÉP CHỌN 1-TRONG-2: 'Anh/chị qua ${dayChoice} tiện hơn ạ?'.`;
      }
    } else if (!qrShown) {
      cmt = `ĐỦ INFO (tên=${name}, SĐT=${phone}, ngày=${knownInfo.preferredTime}). Xác nhận 1 câu: 'Em giữ chỗ ${knownInfo.preferredTime} cho mình rồi nha ${state.honorific} ${name}' rồi DỪNG.`;
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
    // Viết tháng→giá ĐẦY ĐỦ (KHÔNG "1m=700k|3m=2tr" — model nhỏ hay ghép nhầm "3 tháng↔700k").
    // Đây là THẺ FULL dùng chung cả 4 dịch vụ, KHÔNG phải gym riêng.
    lines.push("  FULL HS/SV (14-22 tuổi, 1 thẻ dùng cả Gym+Bơi+Yoga+Zumba): 1 tháng 500k · 3 tháng 1.2 triệu · 6 tháng 2.1 triệu · 12 tháng 3.6 triệu ← anchor chính (báo 1 gói hợp nhất trước, vd '3 tháng 1.2 triệu', rồi hé gói ngắn '1 tháng 500k')");
    if (!svc || svc === "gym") {
      lines.push("  PT: 10b=3tr|20b(2m)=6tr (HLV 1-1)");
    }
    return `[PRICING:\n${lines.join("\n")}\n]`;
  }
  if (mt === "gia-dinh") {
    lines.push("  FULL gia đình (4 dịch vụ, 12 tháng): 2ng=12tr|3ng=14tr (gói 3 người tặng thêm 1 người → tối đa 4 người vẫn 14tr) ← anchor chính");
    lines.push("  FULL cá nhân: 1m=800k|3m=2.1tr|6m=3.8tr|12m=7tr");
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

  // Anchor "FULL 4 dịch vụ" cho body/health goal → LUÔN bơm số Full.
  // BUG cũ: gate (!svc || full || gym) làm khách giảm-cân lỡ hỏi "bơi" (svc khóa = boi) rồi hỏi
  // "gói full bao nhiêu" → block CHỈ có bảng Bơi, KHÔNG có số Full → model BỊA giá (vd "Full 700k",
  // thực tế 1.2tr/tháng). Với các goal mà Full là anchor, hiện Full bất kể đang khóa môn lẻ nào.
  const fullIsAnchor =
    goal === "giam-mo" || goal === "suc-khoe" || goal === "giu-dang" || goal === null;
  if (fullIsAnchor) {
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=800k|3m=2.1tr|6m=3.8tr|12m=7tr ← anchor chính");
  }
  if (showGym) {
    lines.push("  Gym: 1m=500k|3m=1.5tr|6m=2.5tr|12m=4.5tr (gói 3b/t nhân 0.6, 4b/t nhân 0.8 giá công bố)");
  }
  if (showPT) {
    lines.push("  PT: 10b=3tr|15b=4tr|20b(2m)=6tr|30b(2m)=8tr|40b(2m)=10tr | 50b(3m)=12tr");
  }
  if (showYogaZumba) {
    lines.push("  Yoga: 1m=650k|3m=1.8tr|6m=3.3tr|12m=5.8tr | Zumba: 1m=500k|3m=1.8tr|6m=3.3tr|12m=5.8tr (GV Ấn Độ, 4 ca/ngày)");
  }
  if (showBoi) {
    lines.push("  Bơi NL: 1m=700k|3m=1.8tr|6m=2.5tr|12m=4.5tr");
    if (goal === "hoc-boi" || svc === "boi") {
      lines.push("  Bơi TE: 1m=600k|3m=1.5tr|6m=2tr|12m=3.6tr");
      lines.push("  Vé bơi lẻ (theo chiều cao): <1m=20k/lượt | 1m-1m5=30k/lượt | >1m5=40k/lượt");
      lines.push("  Học bơi (mọi gói tặng 1 tháng bơi + cam kết biết bơi): lớp(12b/20 ngày)=1.5tr | 1-1(12b)=3tr | nhóm≥2=5tr/cặp | 1-1 2 kiểu(20b/40 ngày)=5tr.");
    }
  }
  if (showPilates) {
    lines.push("  Pilates thảm(1:7): 10b=1.5tr|20b=2.4tr|30b=3tr");
    lines.push("  Pilates máy(1:6): 10b=1.9tr|20b=3.6tr|30b=5.1tr");
    lines.push("  Pilates nhóm(1:3): 10b=3tr|20b=5.8tr|30b=8.1tr | Cá nhân(1:1): 10b=4.5tr|20b=8.6tr");
    lines.push("  Thuê HLV theo giờ: HLV Gym=50k/giờ | HLV Pilates thuê dạy=80k/giờ (tự tập máy=50k/giờ). Thuê phòng trọn gói: thoả thuận.");
  }
  // Anchor "FULL" cho thư giãn / non-anchor case khi user vẫn cần thấy combo.
  if (!fullIsAnchor && (!svc || svc === "full") && lines.length === 0) {
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=800k|3m=2.1tr|6m=3.8tr|12m=7tr");
  }
  if (lines.length === 0) {
    // Safety fallback — nếu filter quá khắt → show Full default
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=800k|3m=2.1tr|6m=3.8tr|12m=7tr ← anchor chính");
  }
  return `[PRICING:\n${lines.join("\n")}\n]`;
}

function buildFitnessObjections(h: string): string {
  return `[OBJECTIONS:
  "Đắt quá" → Reframe bằng VALUE: "Full 7tr/12 tháng đi kèm phòng gym 700m2 máy chuẩn QT, bể bơi 4 mùa duy nhất Vĩnh Yên, Yoga & Zumba GV người Ấn Độ, lại có bãi đỗ xe rộng cả ô tô & xe máy đi tập thoải mái ${h}. Hội viên bên em hay gắn bó dài và rủ thêm bạn bè vào tập cùng — anh/chị qua thử 1 buổi cảm nhận thực tế nha". KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG giảm giá. Offer gói ngắn nếu vẫn từ chối.
  "Tập 1 môn" → "Thẻ Full chỉ hơn chút mà dùng cả 4 ${h} — tập 1 môn lâu chán, thêm Yoga/Bơi duy trì động lực"
  "Tháng lẻ thôi" → "Tháng lẻ 800k ${h}, mà gói năm 7tr lại bảo lưu được khi bận và chuyển nhượng được trong gia đình — đa số chọn năm để chủ động hơn"
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
        `[CENTER (KIẾN THỨC THAM CHIẾU — chỉ để trả ĐÚNG khi khách HỎI; khách CHƯA hỏi địa chỉ/giờ/cơ sở vật chất thì ⛔ KHÔNG tự khai, chỉ ACK ngắn + hỏi 1 câu):\n` +
        `  Fami Fitness & Yoga Center Vĩnh Yên | 32A Nguyễn Chí Thanh, Vĩnh Yên | 05:00–20:30 | Thành lập 2014\n` +
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

  const { stage, flow, knownInfo } = state;

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
    // Tín hiệu khách MUỐN đến (đã chọn/sẵn sàng, hoặc tự nêu giờ) → mới được HARD-CLOSE hỏi giờ.
    // Mới than đau, chưa có tín hiệu → MỀM: mời trải nghiệm, KHÔNG hỏi 'sáng hay chiều' (giục = pushy).
    const buyingSignal =
      state.intent === "selecting" || state.intent === "ready" || preferredTime !== null;
    // Tách thành 2 bước để không gộp giờ + tên + SĐT trong cùng 1 câu (dồn dập, dễ scare khách).
    // Bước 1: chỉ hỏi giờ. Bước 2: khi khách chốt giờ rồi, mới xin tên + SĐT.
    const closingLine = hasContact
      ? `Dạ em giữ chỗ ${preferredTime ?? "..."} cho mình rồi nha ${h} ${knownInfo.name}, hẹn gặp ${h} ạ`
      : preferredTime
        ? `Để em giữ chỗ ${preferredTime} cho ${h}, ${h} cho em xin tên với SĐT để em note nha`
        : buyingSignal
          ? `${h} tiện khung sáng hay chiều ạ`
          : `Mình cứ thử trải nghiệm 1 buổi cho KTV kiểm tra trực tiếp rồi tư vấn lộ trình, chưa cần quyết gì đâu ${h}`;

    const timeNote = preferredTime
      ? `ĐÃ BIẾT giờ=${preferredTime} → KHÔNG hỏi giờ lại, kết bằng xin tên/SĐT.`
      : buyingSignal
        ? "Khách đã có ý muốn đến → hỏi giờ (sáng/chiều), KHÔNG xin tên/SĐT cùng lúc — đợi khách chốt giờ rồi turn sau mới xin liên hệ."
        : "Khách MỚI than đau, CHƯA có ý định đến → MỜI TRẢI NGHIỆM mềm (không cam kết), TUYỆT ĐỐI KHÔNG hỏi giờ / chốt lịch lúc này (giục chốt sớm = pushy). Để khách quan tâm rồi mới chốt giờ ở lượt sau.";
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

  // ── GIẢI CƠ / FITNESS: commitment — CHỐT NGÀY trước → xin liên hệ → xác nhận → dừng ──
  if (stage === "commitment") {
    // CHƯA chốt được NGÀY cụ thể (null / chỉ buổi / cửa sổ mơ hồ "cuối tuần") → ưu tiên CHỐT NGÀY,
    // CHƯA xin tên/SĐT. isPreferredTimeSpecific coi "thứ 7"/"chủ nhật" là ĐÃ chốt ngày (khác hasConcreteDate ngặt DD/MM).
    if (!isPreferredTimeSpecific(knownInfo.preferredTime)) {
      const { options } = suggestDatePair(knownInfo.preferredTime);
      return `[EXAMPLE — COMMITMENT chưa chốt NGÀY: chốt 1 ngày cụ thể TRƯỚC, CHƯA xin tên/SĐT]
Khách nói cửa sổ mơ hồ ("cuối tuần"/"tuần sau") → ĐÚNG: "Dạ ${h} qua ${options[0]} hay ${options[1]} tiện hơn ạ"
Khách chưa nói ngày → ĐÚNG: "Dạ ${h} tiện qua hôm nào ạ"
SAI: hỏi "buổi sáng/chiều/tối" thay cho NGÀY; xin tên/SĐT khi chưa chốt được ngày; dồn ngày+tên+SĐT 1 câu.`;
    }
    return `[EXAMPLE — COMMITMENT đã có ngày: xin liên hệ → XÁC NHẬN → DỪNG]
⚠️ Không lặp "KTV đánh giá thực tế / tư vấn lộ trình". Không đẩy QR trừ khi khách hỏi.

CHƯA đủ tên+SĐT (đã có ngày=${knownInfo.preferredTime}):
ĐÚNG: "Dạ ${h} cho em xin tên với SĐT để em giữ chỗ ${knownInfo.preferredTime} cho mình ạ"
SAI:  hỏi lại ngày/buổi đã có; xác nhận khi chưa có tên/SĐT.

ĐÃ đủ tên+SĐT+ngày:
ĐÚNG: "Dạ em giữ chỗ ${knownInfo.preferredTime} cho mình rồi nha ${h} [tên], hẹn gặp ${h} ạ" → DỪNG HẲN.
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
    if (info.gender !== null) parts.push(`giới=${info.gender}`);
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
    // pastMethod KHÔNG còn là slot bắt buộc: hỏi nó là tra khảo, không chặn bước.
    // (Chỉ extract khi khách tự kể, để làm contrast — không liệt vào "missing".)
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
      `Reply NGẮN 1 câu xác nhận: 'Dạ em giữ chỗ [giờ] cho mình rồi nha ${h} ${state.knownInfo.name}, hẹn gặp ${h} ạ' rồi DỪNG HẲN. ` +
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

  // Slim PITCH: skip Knowledge khi commitment + đủ name/phone (đang chốt chỗ, không cần pitch nữa).
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

  // ANSWER-FIRST: khách hỏi thẳng câu cụ thể (giá/giờ/cơ sở/chê giá/xin ảnh) → trả thẳng, đặt ở ĐẦU
  // để đè pitch tactic khi câu hỏi lệch luồng (chống pivot). Rỗng ở discovery/greeting → tactic dẫn như cũ.
  const giaiCoAnswerFirst = buildGiaiCoAnswerFirst(state);

  const lines: string[] = [
    `[HON: ${h}] [STAGE: ${state.stage}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
    giaiCoAnswerFirst,
    `[TACTIC: ${tactic}]`,
    `[RULES: Nhắn như sale thật đang chat — văn nói, NGẮN GỌN, text thuần KHÔNG markdown. Mặc định 1-2 câu (≤200 chữ); CHỈ khi liệt kê 3+ gói mới xuống dòng "-" mỗi mục (≤350 chữ). Giá viết bằng chữ ("12 tháng 5 triệu", "3 buổi/tuần") — KHÔNG để "12m=5tr","|","=". ACK trung tính NGẮN rồi vào ý chính, ĐỔI cách mở mỗi tin (đừng đóng đinh "Dạ vâng ${h}" mọi lượt — lặp opener nghe như máy; có thể vào thẳng nội dung): CẤM khen đáp án khách (tuyệt vời/tốt quá/hợp lý/chuẩn rồi/lý tưởng...), CẤM đọc lại nguyên văn lời khách, CẤM "em note/ghi nhận", CẤM "em gửi hình" khi không gọi tool. Tối đa 1 câu hỏi, kết "?" hoặc "ạ?" (KHÔNG "nha?"). Đọc TACTIC/GATE/KNOWLEDGE rồi TỰ viết — KHÔNG chép lại.]`,
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
        `Cần cao–nặng để tư vấn theo chuẩn: CHƯA có thì hỏi GỌN cao–nặng (1 câu). ĐÃ có cao–nặng → đối chiếu bảng cân chuẩn, nói khách đang lệch tầm mấy kg + gợi hướng tập hợp mục tiêu (muốn ${dir}). ` +
        `⛔ KHÔNG hỏi "vùng nào tự ti / thói quen sinh hoạt / đã thử cách nào" — khách khó trả lời, hỏi dồn làm rớt khách; có cao–nặng là tư vấn được rồi. ` +
        `⛔ KHÔNG InBody, KHÔNG đặt lịch/"sáng hay chiều", KHÔNG báo giá, KHÔNG recommend gói cụ thể.`
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
      `(máy bóc tách mỡ/cơ thật, HLV lên lộ trình chuẩn thay vì tập sai). Nói value 1-2 câu rồi hỏi 1 câu MỞ bám mục tiêu/động lực của khách. ` +
      `Cá nhân hóa theo trải nghiệm khách (đọc lịch sử chat, đừng hỏi lại nếu đã rõ): khách CHƯA biết tập → nhấn cần HLV/PT lên giáo án + thực đơn cho đúng, tránh tập sai; khách ĐÃ biết tập → nhấn tối ưu chi phí bằng thẻ hội viên + tự dựa chỉ số InBody chọn máy/vùng tập. ` +
      `⛔ Khách MỚI / chưa khẳng định biết tập (vd "chưa đi gym bao giờ", "sợ không biết dùng máy") → CHỈ hướng PT kèm, TUYỆT ĐỐI KHÔNG gợi "tự tập cho tiết kiệm" và KHÔNG đưa tự-tập thành 1 lựa chọn — người mới được mời tự tập sẽ càng hoang mang, phản tác dụng. Chỉ nói hướng tự-tập-bằng-thẻ khi khách ĐÃ nói rõ có nền tập rồi. ` +
      `⛔ KHÔNG hỏi "sáng hay chiều", KHÔNG rủ đặt lịch / chọn buổi, CHƯA báo giá — đặt lịch là việc của bước CHỐT khi khách đã muốn đến.`
    );
  }

  if (stage === "evaluation" || stage === "negotiation") {
    return (
      `[VIỆC CẦN LÀM — TƯ VẤN & TẠO ĐỘNG LỰC] CHỦ ĐỘNG dẫn dắt, đừng trả lời xong để lửng. Recommend DỨT KHOÁT 1 hướng hợp mục tiêu (value-first, không "cả 2 đều tốt"). ` +
      `Tạo động lực bằng KẾT QUẢ khách sẽ đạt + ưu đãi nhẹ. NẾU khách CHƯA được mời thử lần nào (đọc lịch sử chat) → gợi đo InBody / thử 1 buổi như bước trải nghiệm value; đã mời ở tin trước mà khách chưa từ chối/chưa gật → ĐỪNG mời lại, tiến thẳng sang chốt NGÀY. ` +
      `Có thể thúc nhẹ (chỉ khi tự nhiên, KHÔNG ép, KHÔNG mỗi tin một lần): suất trải nghiệm miễn phí đang GIỚI HẠN theo tuần (tạo lý do hành động sớm). ⛔ KHÔNG bịa con số cụ thể (còn mấy suất, giảm bao nhiêu %) — nói chung "đang giới hạn suất" thôi. ⛔ ĐỪNG tự chèn "rủ bạn / đi cùng cho đỡ ngại" khi khách KHÔNG nhắc — nudge rủ bạn lạc chỗ nghe rất sượng, lạc câu khách đang hỏi. ` +
      `★ CHỈ khi khách TỰ nhắc rủ bạn / đi cùng người thân / đi 2 người → BÁM NGAY: xác nhận có ƯU ĐÃI NHÓM (đi đông tiết kiệm hơn, đỡ ngại) — đừng để trôi cơ hội này. ` +
      `Khi mời chốt: DẪN bằng 1 lý do cụ thể (em giữ chỗ trước / HLV chuẩn bị lộ trình + InBody cho mình) rồi hỏi NGÀY khách qua (hôm nào; nếu khách mơ hồ thì gợi 2 ngày cụ thể) — ⛔ KHÔNG hỏi "buổi sáng/chiều/tối" khi CHƯA chốt được NGÀY (ngày mới là cái giữ chỗ). ` +
      `⛔ CHỈ chốt khi khách đã GẬT muốn đến. CHỈ bung giá/gói khi khách HỎI giá. KHÔNG ép.`
    );
  }

  if (stage === "commitment") {
    if (ki.name && ki.phone && ki.preferredTime) {
      return `[VIỆC CẦN LÀM — CHỐT XONG] Đã đủ tên+SĐT+giờ → xác nhận giữ chỗ 1 câu NGẮN rồi DỪNG. KHÔNG hỏi lại thông tin đã có.`;
    }
    // CHỐT NGÀY TRƯỚC, rồi mới xin liên hệ — tránh dồn ngày+tên+SĐT 1 câu (dồn dập).
    // Dùng isPreferredTimeSpecific (nhận THỨ-trong-tuần "thứ 7"/"chủ nhật" là ĐÃ chốt ngày);
    // hasConcreteDate quá ngặt (đòi DD/MM) → "thứ 7" bị coi chưa chốt → loop hỏi ngày.
    if (!isPreferredTimeSpecific(ki.preferredTime)) {
      return (
        `[VIỆC CẦN LÀM — CHỐT NGÀY] Khách sẵn sàng nhưng CHƯA chốt được NGÀY cụ thể → nêu 1 lý do giá trị ngắn (em giữ chỗ / HLV chuẩn bị lộ trình & InBody) rồi CHỐT NGÀY: khách nói mơ hồ ("cuối tuần"/"tuần sau") thì gợi 2 NGÀY cụ thể cho chọn; chưa nói ngày thì hỏi qua hôm nào. ` +
        `⛔ CHƯA xin tên/SĐT ở tin này, ⛔ KHÔNG hỏi "buổi sáng/chiều/tối" thay cho ngày — chốt được NGÀY rồi turn sau mới xin liên hệ.`
      );
    }
    return (
      `[VIỆC CẦN LÀM — XIN LIÊN HỆ] Đã chốt ngày (${ki.preferredTime}) → giờ xin tên+SĐT gọn 1 câu để giữ chỗ. ` +
      `KHÔNG hỏi lại ngày/buổi đã có, KHÔNG dồn dập.`
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
  // HỌC SINH / SINH VIÊN: hệ thống CÓ bảng giá HS/SV thật (Full 1m=500k|3m=1.2tr|6m=2.1tr|12m=3.6tr,
  // bơm qua PRICING khi memberType="hoc-sinh"). → BÁO ĐÚNG giá đó (theo lựa chọn user 2026-06-16),
  // KHÔNG né sang "xin SĐT". Doanh nghiệp thì KHÔNG có bảng → mới xin SĐT cho sale.
  if (
    state.intentTopic === "ask_student_pricing" ||
    sig?.attribute === "ask_price_student"
  ) {
    return `[KHÁCH HỎI GIÁ HỌC SINH/SINH VIÊN: bên em CÓ gói Full HS/SV riêng — báo THẲNG theo bảng PRICING (anchor 1 gói hợp nhất + giá, rồi hé gói rẻ hơn). KHÔNG né "xin SĐT để sale báo", KHÔNG bịa số ngoài bảng.]`;
  }
  if (
    state.intentTopic === "ask_corporate" ||
    sig?.attribute === "corporate" ||
    (state as any).corporateHold === true
  ) {
    return `[KHÁCH HỎI GÓI DOANH NGHIỆP/CÔNG TY: hệ thống KHÔNG có bảng giá công ty cố định → nói "bên em có ưu đãi riêng cho nhóm/công ty ạ" rồi xin SĐT để sale báo mức chính xác. KHÔNG báo giá lẻ retail, KHÔNG bịa số. Nếu đã có SĐT → xác nhận sale liên hệ, DỪNG.]`;
  }
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

/**
 * ANSWER-FIRST cho giai-co (đọc classifier domain — KHÔNG regex). Đối xứng buildFitnessAnswerFirst.
 * Khách hỏi thẳng gì thì TRẢ thẳng cái đó; chống rơi về pitch trị liệu khi câu hỏi lệch luồng
 * (đây là điểm giòn cũ: off-vocab không khớp GATE → MODE=PITCH → pivot). Non-empty = ưu tiên cao.
 */
function buildGiaiCoAnswerFirst(state: ConversationState): string {
  const sig = state.intentSignal;
  const domain = sig?.domain ?? null;
  const attr = sig?.attribute ? ` (${sig.attribute})` : "";
  switch (domain) {
    case "pricing":
      return `[KHÁCH HỎI GIÁ: trả THẲNG giá tham chiếu 1 buổi NGAY (answer-first), KHÔNG đổ gói 10 buổi từ đầu, KHÔNG né. KTV đánh giá tại chỗ rồi tư vấn lộ trình.]`;
    case "scheduling":
      return `[KHÁCH HỎI LỊCH/GIỜ: trả giờ mở (9h–23h) — KHÔNG trả bằng bảng giá.]`;
    case "service_inquiry":
      return `[KHÁCH HỎI VỀ DỊCH VỤ/CƠ SỞ${attr}: trả THẲNG đúng câu hỏi (giờ, địa chỉ, buổi 45/75 phút, KTV nam/nữ, đỗ xe, tắm tại chỗ, đặt trước...) rồi mới dẫn tiếp. ĐỪNG lái sang pitch trị liệu khi khách chưa hỏi.]`;
    case "safety_concern":
      return `[KHÁCH LO AN TOÀN${attr}: trấn an nhẹ + trả thật. Có bệnh lý xương khớp/chấn thương thì khuyên hỏi bác sĩ trước, KTV sẽ đánh giá tại chỗ. KHÔNG ép đặt.]`;
    case "objection":
      return `[KHÁCH PHÂN VÂN/CHÊ GIÁ: ghi nhận ngắn → reframe bằng giá trị (xử đúng chỗ gây đau nên đỡ bền hơn massage lặp lại) + mời thử 1 buổi. KHÔNG hạ giá, KHÔNG giục chốt.]`;
    case "media_request":
      return `[KHÁCH XIN XEM ẢNH: gọi tool get-media rồi 1 câu dẫn ngắn.]`;
    case "commitment":
      return `[KHÁCH MUỐN ĐẶT/CHỐT: xin thông tin còn thiếu gọn gàng, KHÔNG pitch lại nữa.]`;
    default:
      return "";
  }
}

/**
 * TACTIC TRỌNG TÂM đặt ĐẦU prefix (mini-model tuân directive ở ĐẦU tốt hơn ở giữa —
 * xem MODEL_NOTES "TACTIC đầu > GATE giữa"). Chỉ fire ở 2 khúc model hay drift:
 *   - inbody  → bot hay nhảy "sáng hay chiều" thay vì pitch InBody.
 *   - objection (chê giá) → bot hay tụt giá / gợi "gói nhẹ hơn" thay vì reframe value.
 * Cùng hướng với buildFitnessStageFocus/AnswerFirst (reinforce, không mâu thuẫn).
 */
function buildFitnessLeadTactic(state: ConversationState): string {
  const domain = state.intentSignal?.domain ?? null;
  const ki = state.knownInfo;

  // Chê giá / phản đối giá → reframe VALUE, cấm tụt giá. (ưu tiên trên cả inbody)
  if (domain === "objection") {
    return (
      `[TRỌNG TÂM TIN NÀY] Khách chê đắt / lăn tăn giá → ghi nhận 1 câu rồi REFRAME bằng GIÁ TRỊ ` +
      `(cơ sở 700m2 + bể bơi 4 mùa + GV Ấn Độ + bãi đỗ xe rộng) + mời thử 1 buổi. ` +
      `⛔ KHÔNG gợi "gói nhẹ hơn / rẻ hơn", KHÔNG hạ giá, KHÔNG chia nhỏ giá kiểu "ly cà phê".`
    );
  }

  // Pitch InBody: chặn "sáng hay chiều" + cá nhân hóa theo đã/chưa biết tập, ngay ở đầu.
  // CHỈ khi đang thực sự ở moment pitch InBody — KHÔNG fire khi KH đã cho liên hệ (name+phone)
  // hoặc đang chốt/đặt lịch (domain=commitment/scheduling): lúc đó việc cần làm là hỏi giờ/giữ chỗ,
  // không phải pitch InBody nữa (tránh đè "xin khung giờ").
  if (
    state.stage === "inbody" &&
    !(ki.name && ki.phone) &&
    domain !== "commitment" &&
    domain !== "scheduling" &&
    // Khách đang HỎI câu cụ thể (FAQ cơ sở/chính sách, lo an toàn, xin ảnh) → answer-first câu đó,
    // ĐỪNG chèn directive pitch InBody ở đầu (nó salience cao sẽ đè, làm bot lơ câu khách hỏi → pivot).
    domain !== "service_inquiry" &&
    domain !== "safety_concern" &&
    domain !== "media_request"
  ) {
    return (
      `[TRỌNG TÂM TIN NÀY] Đây là lúc PITCH đo InBody MIỄN PHÍ (máy bóc tách mỡ/cơ thật) làm bước value. ` +
      `Khách ĐÃ biết tập / tập lâu năm → nhấn tối ưu chi phí bằng THẺ HỘI VIÊN + tự dựa chỉ số InBody chọn máy/vùng tập, KHÔNG ép PT; ` +
      `khách chưa biết tập → nhấn cần HLV lên giáo án cho đúng. ` +
      `⛔ TUYỆT ĐỐI KHÔNG hỏi "sáng hay chiều" / rủ đặt lịch ở tin này.`
    );
  }

  return "";
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
    buildFitnessLeadTactic(state),
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

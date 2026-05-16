/**
 * stateMachine.ts
 *
 * KIẾN TRÚC: FSM kiểm soát flow, LLM chỉ lo ngôn ngữ.
 *
 * Code quyết định:
 *   - Stage transition (dựa trên slots đã fill)
 *   - Temperature (dựa trên slot density + intent)
 *   - Slot trust (store-first, LLM chỉ extract những slot NULL)
 *
 * LLM quyết định:
 *   - Ngôn ngữ / tone của response
 *   - Emotion classification
 *   - Flow detection (fitness vs giai-co) — với keyword pre-check
 *   - Extract slots còn thiếu từ message mới
 */

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type Flow = "fitness" | "giai-co";

export type Stage =
  | "opening"
  | "discovery"
  | "inbody"       // pitch Inbody miễn phí — mandatory funnel trước evaluation
  | "evaluation"
  | "negotiation"
  | "commitment"
  | "objection"
  | "recovery"
  | "retention";

export type Temperature = "cold" | "warm" | "hot";

export type Emotion =
  | "neutral"
  | "excited"
  | "anxious"
  | "frustrated"
  | "hesitant"
  | "trusting";

export type Intent = "explore" | "compare" | "selecting" | "ready";

// ─────────────────────────────────────────────
// INTENT TOPIC — phân loại nội dung KH đang hỏi/nói (semantic intent)
// Khác Intent (explore/compare/selecting/ready) ở scope: Intent là MỨC độ commit;
// IntentTopic là CHỦ ĐỀ tin nhắn. Cả 2 cùng do LLM classifier output.
//
// Topic chính được map sang template trong questionFlow.ts. null = bot fallback
// về reply tự nhiên qua agent prompt (TACTIC/EXAMPLE).
// ─────────────────────────────────────────────

export type IntentTopic =
  // Opening — turn 1 chưa rõ nhu cầu
  | "opening_greeting"            // "Quan tâm", "Hi", chào suông
  | "opening_chuong_trinh"        // "Tư vấn chương trình tập luyện", "có chương trình gì"
  | "opening_chua_biet"           // "chưa biết tập gì", "cho chị tham khảo"
  | "tham_quan"                   // "đi qua tham quan thôi"
  // Intro mục tiêu/môn (có thể fire bất kể turn)
  | "intro_trai_nghiem"           // "muốn tập trải nghiệm", "muốn thử"
  | "intro_giam_can"              // "muốn giảm cân", "giảm mỡ", "giảm béo"
  | "intro_uu_dai"                // "có ưu đãi/khuyến mãi gì không"
  // Trial-related
  | "trial_ask_confirm"           // "có được tập thử không"
  | "trial_register_how"          // "đăng ký trải nghiệm như thế nào"
  // Discovery answers / class structure
  | "no_experience"               // "chưa tập bao giờ", "chưa từng"
  | "has_experience"              // "đã tập rồi", "tập rồi", "có tập", "từng đi rồi"
  | "new_class_inquiry"           // "có lớp cho người mới không em"
  | "class_has_newbies"           // "Lớp bây giờ có người mới không"
  // Logistics — giờ mở cửa / lúc nào qua được (KHÔNG dành riêng cho bể)
  | "ask_open_hours"              // "khi nào qua được", "mấy giờ mở cửa", "qua lúc nào"
  // Bơi
  | "pool_audience_ask"           // "muốn học bơi" — chưa rõ NL/TE
  | "pool_child_no_age"           // bơi cho con/bé — chưa nói tuổi
  | "pool_child_with_age"         // bơi cho con/bé — đã nói tuổi
  | "pool_hours"
  | "pool_temperature"
  | "pool_swimwear"
  | "pool_chlorine"
  | "pool_water_change"
  | "pool_lifeguard"
  | "pool_traffic"
  | "pool_limit"
  // Zumba
  | "zumba_vs_aerobic"            // so sánh Zumba vs Aerobic
  | "zumba_weight_loss"           // "Zumba có giảm cân không"
  // Pricing
  | "price_ask_generic"           // "bao nhiêu tiền/tháng", "giá thế nào"
  | "price_with_worry"            // giá + lo "không theo được"
  | "price_explicit_list"         // "có những gói nào", "gói giá nào em"
  | "price_objection"             // "đắt quá", "cao thế"
  // Goal/package
  | "full_package_confirm"        // "đăng ký gói Full" / "thẻ Full nhỉ"
  | "maintain_after_goal"         // "sau khi giảm cân muốn duy trì", "mất ngủ"
  | "guidance_ask"                // "có ai hướng dẫn không"
  | "combo_service_ask"           // "tập kèm dịch vụ khác không"
  // Media
  | "media_request"               // "cho xem ảnh phòng", "có hình không"
  // Switch service (giữa cuộc thoại) — slot extraction sẽ extract serviceType mới
  | "switch_service"              // "tôi quan tâm tập gym" (khi đang trên service khác)
  // ── EDGE TOPICS — câu hỏi ngoài kịch bản Fami chính thức ──
  | "ask_address"                 // "địa chỉ ở đâu", "trung tâm chỗ nào"
  | "ask_branch"                  // "có cơ sở 2 không", "chi nhánh ở HN"
  | "ask_facility"                // gửi xe, tủ đồ, phòng tắm, điều hòa, wifi, lọc khí
  | "ask_hold_policy"             // "thẻ có bảo lưu được không"
  | "ask_refund_policy"           // "không tập có hoàn tiền không"
  | "ask_change_package"          // "đổi gói giữa chừng được không"
  | "ask_unsupported_service"     // hỏi boxing/dance/aerobic standalone/kickbox/crossfit
  | "complaint_crowded"           // "phòng tập đông quá"
  | "ask_kid_supervision"         // "có chỗ trông trẻ con không"
  | "ask_postpartum_safety"       // "mới sinh / cho con bú tập được không"
  | "ask_prenatal_safety"         // "đang bầu X tháng tập được không"
  | "ask_senior_safety"           // "60+ tuổi / có bệnh nền tập được không"
  | "ask_rapid_weight_loss"       // "giảm 10kg trong 1 tháng" — mục tiêu phi thực tế
  | "ask_post_surgery"            // "vừa phẫu thuật / chấn thương phục hồi"
  | "ask_renewal"                 // "hội viên cũ gia hạn"
  | "ask_combo_pricing"           // "1 tháng combo bao nhiêu", "gym+yoga giá combo"
  | "ask_nutrition"               // "tư vấn ăn uống / chế độ ăn / whey protein"
  | "ask_corporate"               // "công ty / 20 nhân viên / gói doanh nghiệp"
  | "ask_pt_pricing"              // "PT 1-1 bao nhiêu / HLV riêng tháng nào"
  | "ask_hlv_gender"              // "có HLV nữ/nam không"
  | "ask_payment_method"          // "trả góp / thẻ credit / chuyển khoản"
  | "ask_student_pricing"         // "X tuổi tập được không / có gói học sinh"
  | "ask_teen_safety";            // "em 15/16/17 tuổi tập gym tăng cơ được không"

// ─────────────────────────────────────────────
// KNOWN INFO — khác nhau giữa 2 flows
// ─────────────────────────────────────────────

export interface KnownInfo {
  // Chung
  name: string | null;
  phone: string | null;

  // Fitness
  serviceType: string | null;     // gym / yoga / zumba / boi / pilates / full
  memberType: string | null;      // ca-nhan / gia-dinh / hoc-sinh
  durationMonths: number | null;  // 1 / 3 / 6 / 12 / 24 / 36
  schedule: string | null;        // khung giờ / buổi mong muốn
  fitnessGoal: string | null;     // [MỚI] mục tiêu: giam-mo / tang-co / thu-gian / hoc-boi / suc-khoe

  // Giải cơ
  painArea: string | null;        // vùng đau: vai-gay / lung / chan / toan-than / ...
  painSpread: string | null;      // lan tỏa hay điểm cố định: "lan-toa" / "diem-co-dinh" / mô tả cụ thể
  painDuration: string | null;    // đau bao lâu + khi nào nhắc nhở (VD: "vài hôm sáng dậy", "1 tuần ngồi lâu")
  pastMethod: string | null;      // đã thử phương pháp nào: chua-thu / massage / thuoc / vat-ly-tri-lieu / khac
  sessionPackage: string | null;  // le / 5-buoi / 10-buoi / 20-buoi
  preferredTime: string | null;   // giờ muốn đặt lịch
}

export interface ConversationState {
  flow: Flow;
  stage: Stage;
  temperature: Temperature;
  emotion: Emotion;
  intent: Intent;
  // intentTopic: chủ đề ngữ nghĩa của tin nhắn turn hiện tại (LLM classify mỗi turn).
  // Transient — chỉ dùng cho turn này, không persist semantics. State có lưu để các
  // hàm downstream (questionFlow, prefixBuilder GATE) đọc thay vì regex parse lại message.
  intentTopic: IntentTopic | null;
  honorific: "anh" | "chị" | "anh/chị";
  knownInfo: KnownInfo;
  /** Tổng số turn của cuộc thoại — KHÔNG reset khi flow đổi. Dùng cho greeting decision. */
  turnCount: number;
  /** Số turn trong flow HIỆN TẠI — reset về 1 khi flow đổi. Dùng cho anti-loop guards. */
  flowTurnCount: number;
  qrShown: boolean;
  mediaShown: boolean;
  // Track riêng từng key media đã gửi — cho phép gửi media khi khách hỏi DỊCH VỤ MỚI.
  // Vd: đã gửi fitness-pool, khách hỏi zumba → gửi fitness-zumba (key chưa có trong list).
  mediaShownKeys: string[];
  sheetsWritten: boolean;
  lastBotReply?: string;
}

// ─────────────────────────────────────────────
// SLOT MERGE — Store-first
// ─────────────────────────────────────────────

export function mergeSlots(
  existing: KnownInfo,
  extracted: Partial<KnownInfo>
): KnownInfo {
  // Store-first: existing value luôn được giữ nguyên nếu đã có.
  // extracted chỉ được dùng khi existing === null VÀ extracted có giá trị thật (không null/undefined).
  function pick<T>(e: T | null, x: T | null | undefined): T | null {
    if (e !== null) return e;
    if (x !== null && x !== undefined) return x;
    return null;
  }

  // Ngoại lệ: preferredTime có thể refine HOẶC đổi ý.
  //   Refine:   existing="sáng"            extracted="sáng thứ 7 26/04"  → lấy extracted
  //   Đổi ý:    existing="thứ 7 26/04 9h"  extracted="sáng mai"          → lấy extracted
  //                                                                       (khách chủ động đổi)
  // Logic:
  //   1) extracted null/undefined → giữ existing (classifier không thấy tín hiệu thời gian).
  //   2) extracted bằng existing → no-op.
  //   3) extracted có tín hiệu thời gian rõ ràng → trust extracted (refine hoặc đổi ý).
  //   4) còn lại → giữ existing để tránh classifier nhiễu xóa mất giá trị tốt.
  function pickPreferredTime(
    e: string | null,
    x: string | null | undefined
  ): string | null {
    if (x === null || x === undefined) return e;
    if (e === null) return x;
    if (x === e) return e;
    const hasTimeSignal =
      /(sáng|chiều|tối|trưa|thứ|chủ\s?nhật|\bcn\b|\d{1,2}h|\d{1,2}\/\d{1,2}|mai|hôm nay|hôm qua|cuối tuần|ngày kia)/i.test(
        x,
      );
    return hasTimeSignal ? x : e;
  }

  // Slot có thể bị classifier suy diễn sai ngay turn đầu (vd pastMethod="chua-thu"
  // khi khách chưa nói gì). Khi re-extract trả về value mới non-null → trust mới.
  // Classifier chỉ được yêu cầu extract slot này khi có cue rõ ràng → an toàn để override.
  function pickWithReextract<T>(e: T | null, x: T | null | undefined): T | null {
    if (x === null || x === undefined) return e;
    return x;
  }

  // Fami chỉ có 5 service: gym/yoga/zumba/boi/pilates (+ full combo).
  // Reject mọi giá trị khác (vd "aerobic" — khách nhắc để so sánh nhưng KHÔNG phải dịch vụ
  // bên em → không được switch sang).
  function pickServiceType(
    e: string | null,
    x: string | null | undefined,
  ): string | null {
    if (e !== null) return e;
    if (x === null || x === undefined) return null;
    const valid = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
    return valid.includes(x.toLowerCase()) ? x.toLowerCase() : null;
  }

  return {
    name:           pick(existing.name,           extracted.name),
    phone:          pick(existing.phone,          extracted.phone),
    serviceType:    pickServiceType(existing.serviceType, extracted.serviceType),
    memberType:     pick(existing.memberType,     extracted.memberType),
    durationMonths: pick(existing.durationMonths, extracted.durationMonths),
    schedule:       pick(existing.schedule,       extracted.schedule),
    // fitnessGoal: KH có thể bổ sung / đổi mục tiêu giữa cuộc thoại (vd "muốn học bơi" rồi "và muốn giảm cân").
    // Classifier chỉ extract khi có cue rõ ràng nên an toàn để override với value mới.
    fitnessGoal:    pickWithReextract(existing.fitnessGoal, extracted.fitnessGoal),
    painArea:       pickWithReextract(existing.painArea,   extracted.painArea),
    painSpread:     pickWithReextract(existing.painSpread, extracted.painSpread),
    painDuration:   pick(existing.painDuration,   extracted.painDuration),
    pastMethod:     pickWithReextract(existing.pastMethod, extracted.pastMethod),
    sessionPackage: pick(existing.sessionPackage, extracted.sessionPackage),
    preferredTime:  pickPreferredTime(existing.preferredTime, extracted.preferredTime),
  };
}

/**
 * Chấm độ cụ thể của preferredTime để quyết định có override hay không.
 *   +2 = có ngày DD/MM
 *   +2 = có giờ cụ thể (VD "9h", "15h30")
 *   +1 = có buổi (sáng/chiều/tối)
 *   +1 = có thứ trong tuần (thứ 2..7, chủ nhật, CN)
 * Value càng cụ thể → điểm càng cao.
 */
export function preferredTimeScore(s: string | null): number {
  if (s === null) return -1;
  let score = 0;
  if (/\d{1,2}\/\d{1,2}/.test(s)) score += 2;
  if (/\d{1,2}h/i.test(s)) score += 2;
  if (/(sáng|chiều|tối|trưa)/i.test(s)) score += 1;
  if (/(thứ\s?[2-7]|chủ\s?nhật|\bcn\b)/i.test(s)) score += 1;
  return score;
}

/**
 * Kiểm tra preferredTime đã đủ cụ thể chưa (có ngày hoặc thứ).
 * Dùng để quyết định có nên re-extract không.
 */
export function isPreferredTimeSpecific(s: string | null): boolean {
  if (s === null) return false;
  return /\d{1,2}\/\d{1,2}/.test(s) || /(thứ\s?[2-7]|chủ\s?nhật|\bcn\b)/i.test(s);
}

export function nullSlots(info: KnownInfo): (keyof KnownInfo)[] {
  return (Object.keys(info) as (keyof KnownInfo)[]).filter(
    (k) => info[k] === null
  );
}

// ─────────────────────────────────────────────
// FLOW DETECTION — Keyword pre-check
//
// QUYẾT ĐỊNH FLOW theo thứ tự ưu tiên:
//   1. PAIN_PRIORITY (đang đau/nhức/mỏi/cứng + body part) → giai-co
//      kể cả khi tin có "gym/yoga" (vd "tập gym xong đau lưng" → giai-co
//      để xử đau trước, sau đó mới quay lại fitness).
//   2. GIAI_CO_KEYWORDS (massage/giải cơ/spa/...) → giai-co
//   3. FITNESS_KEYWORDS (gym/yoga/swim/tăng cơ/giảm mỡ/...) → fitness
//   4. Cả 2 cùng có / không có gì → null → để LLM classifier quyết
//
// ⚠️ Vietnamese không dùng được `\b` (ả/ơ/đ không phải word char trong regex
// mặc định). Dùng `u` flag + lookaround `(?<!\p{L})` / `(?!\p{L})` cho boundary.
// ─────────────────────────────────────────────

const VI_BOUND_L = "(?<!\\p{L})";
const VI_BOUND_R = "(?!\\p{L})";

const FITNESS_KEYWORDS = new RegExp(
  `${VI_BOUND_L}(?:gym|yoga|zumba|bơi|pilates|thể dục|tập luyện|thể hình|thẻ tập|hội viên|fitness|aerobic|inbody|hlv|huấn luyện viên|pool|bể bơi|thể thao|tăng cơ|giảm mỡ|giảm cân|đốt mỡ|săn chắc|vóc dáng|thân hình)${VI_BOUND_R}`,
  "iu",
);

// Bỏ "spa" và "xông hơi" khỏi giai-co keywords vì gym/fitness center cũng thường
// có khu sauna/xông hơi như amenity. Khách hỏi "có sauna không" KHÔNG phải hỏi
// dịch vụ giải cơ — sẽ được routing đến ask_facility (fitness flow).
const GIAI_CO_KEYWORDS = new RegExp(
  `${VI_BOUND_L}(?:giải cơ|massage|xoa bóp|đau lưng|đau vai|đau cổ|đau gáy|vật lý trị liệu|trigger|fascia|cứng cơ|đau mỏi|nhức mỏi|ngâm bồn|regenix|hoa sen)${VI_BOUND_R}`,
  "iu",
);

// PAIN_PRIORITY: đang đau/nhức/mỏi/cứng + body part. Cho phép filler ngắn
// (tôi/anh/chị/ở/vùng/phần/đang/hơi…) giữa body part và pain word ở cả 2 chiều.
const BODY_PART = "(?:lưng|vai|cổ|gáy|chân|gối|hông|mông|tay|đầu\\s*gối)";
const PAIN_WORD = "(?:đau|nhức|mỏi|cứng)";
const PAIN_PRIORITY = new RegExp(
  `${PAIN_WORD}\\s+(?:[\\p{L}\\s]{0,15}?)?${BODY_PART}` +              // "đau (ở/phần) cổ"
    `|${BODY_PART}\\s+(?:[\\p{L}\\s]{0,15}?)?${PAIN_WORD}` +           // "lưng (tôi đang) đau"
    `|nhức\\s+(?:mỏi|cơ)|cứng\\s+cơ|mỏi\\s+(?:lưng|vai|cổ|gáy|chân|gối|hông|cơ)`,
  "iu",
);

// Detect "tên + sđt cùng dòng" deterministic — backup khi LLM classifier extract sót name.
// Vd: "toàn 0373389191" / "an 0912345678" — tên 1 từ (có thể trùng từ vựng) + sđt 9-11 số.
// LLM classifier (gpt-4o-mini) hay miss khi tên lowercase/ambiguous → cần regex fallback.
//
// Pattern hỗ trợ:
//   "<tên> <sđt>"        → "toàn 0373389191" / "Lan 0912345678"
//   "<tên>, <sđt>"       → "Toàn, 0912345678"
//   "<tên> sđt <sđt>"    → "An sđt 0912345678"
//   "tên <tên> sđt <sđt>" → "tên Toàn sđt 0912345678"
//
// Vietnamese name chars: 1-3 từ, mỗi từ ≤ 12 chars, chỉ chứa Unicode letter (\p{L}).
// Phone: 9-11 chữ số liên tiếp (có thể có dấu cách/gạch nhưng strip trước).
export function detectNamePhoneInline(
  message: string,
): { name: string | null; phone: string | null } {
  if (!message) return { name: null, phone: null };
  const m = message.trim();
  // Strip ký tự không cần (giữ space + chữ + số).
  // Phone candidate: gom 9-11 chữ số liền (bỏ space giữa chừng).
  const phoneNorm = m.replace(/[\s.\-()]/g, "");
  const phoneMatch = phoneNorm.match(/(\d{9,11})/);
  if (!phoneMatch) return { name: null, phone: null };
  const phone = phoneMatch[1];

  // Tìm phần trước số trong message gốc (giữ space để tách word).
  // Cần locate vị trí của số đầu tiên trong message gốc (sau khi normalize space).
  // Đơn giản: match `^([^\d]*?)(\d[\d\s.\-()]*\d)`
  const beforeMatch = m.match(/^([^\d]*?)(?:\b|^)(\d[\d\s.\-()]*\d)/);
  if (!beforeMatch) return { name: null, phone };
  let beforeText = beforeMatch[1].trim();
  // Strip prefixes: "tên", "sđt", "số", "name", "phone", "là", ":" , "-", "anh", "chị", "em"
  beforeText = beforeText
    .replace(/[,:\-–—]/g, " ")
    .replace(/\b(tên|name|sđt|sdt|số|phone|là|của|anh|chị|em|mình|tôi|ok|oki|okay|alo|hi|hello|cũ|mới|mình|cho)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!beforeText) return { name: null, phone };
  // Loại stopwords cuối nếu còn ("ơi", "ạ"...).
  beforeText = beforeText
    .replace(/\s+(ơi|ạ|nha|nhé|à|ừ)$/i, "")
    .trim();
  // Validate: chỉ Unicode letter + space, 1-4 từ, mỗi từ ≤ 12 chars, total ≤ 30 chars.
  if (beforeText.length > 30) return { name: null, phone };
  if (!/^[\p{L}\s]+$/u.test(beforeText)) return { name: null, phone };
  const words = beforeText.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return { name: null, phone };
  if (words.some((w) => w.length > 12)) return { name: null, phone };
  // Capitalize tên (đầu mỗi từ in hoa).
  const name = words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  return { name, phone };
}

// Detect tên ĐỨNG MỘT MÌNH khi context cho phép (bot vừa hỏi tên, KH chỉ gửi 1 cụm ngắn).
// Vd: "Toàn mà" / "tên là Hùng" / "chị Lan đây" — không có sđt cùng dòng.
//
// CHỈ fire khi:
//   - Bot ở turn trước đã hỏi tên (lastBotReply có "tên" / "tên gì")
//   - Hoặc state đã có phone nhưng thiếu name (high-confidence context)
// Validate strict: 1-3 từ, mỗi từ 2-12 chars chỉ Unicode letter, không phải common words.
// Common words filter để né "chiều mai" / "ok thôi" — tránh false positive cao.
// ⚠️ CỐ Ý KHÔNG include time words (mai/nay/sáng/tối/chiều/trưa) vì các từ này
// đồng âm với tên người phổ biến: "Mai", "Sáng", "Lan", "Hà"... Context check
// (bot vừa hỏi tên) đủ để disambiguate.
const COMMON_NON_NAME_WORDS = new Set([
  "có","không","ko","khong","được","duoc","rồi","vâng","dạ","ok","oki","okay",
  "thôi","thế","vậy","ừ","uh","cảm","ơn","tốt","tệ","hay","sao","gì","nào",
  "kia","khác","đây","đó","này","đấy","ấy",
  "đi","đến","qua","lên","xuống","ra","vào","tới","về","lại",
  "ạ","ơi","nha","nhé","mà","à","nè","luôn","ghé","thử","tập","đăng",
  "gym","yoga","zumba","bơi","pilates","full","pt","hlv","inbody",
  "tiền","giá","gói","tháng","tuần","ngày","buổi","giờ","phút",
  "muốn","cần","thích","biết","xem","cho","giúp","hỏi","là",
  "anh","chị","em","mình","tôi","bạn","cô","chú","bác","cháu","con","ông","bà",
]);

// Honorific prefix có thể strip mà KHÔNG mất ý nghĩa (vd "chị Mai đây" → "Mai").
const HONORIFIC_PREFIX_RE =
  /^(?:anh|chị|em|cô|chú|bác|cháu|ông|bà|mình|tôi|tớ)\s+/i;

export function detectNameStandalone(message: string): string | null {
  if (!message) return null;
  let m = message.trim();
  if (!m) return null;
  // Strip explicit "tên là X" / "tên X" / "là X" / "name is X" prefix.
  m = m.replace(
    /^(?:anh\s+|chị\s+|em\s+|mình\s+|tôi\s+|name\s+is\s+)?(?:tên\s+(?:là\s+)?|là\s+)/i,
    "",
  );
  // Strip honorific prefix nếu còn ("chị Mai đây" → "Mai đây").
  // Lặp 1 lần (không strip 2 honorific liên tiếp — quá rare + dễ nhầm).
  m = m.replace(HONORIFIC_PREFIX_RE, "");
  // Strip suffix: "mà", "đây", "nè", "đó", "này", "à", "ạ", "nha", "nhé", "thôi", "ơi"
  m = m.replace(/\s+(mà|đây|nè|đó|này|à|ạ|nha|nhé|thôi|ơi|nhỉ|đấy|ấy)$/i, "");
  m = m.trim();
  if (!m) return null;
  // Validate: ≤30 chars total, 1-3 từ, chỉ Unicode letter + space.
  if (m.length > 30) return null;
  if (!/^[\p{L}\s]+$/u.test(m)) return null;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  // Mỗi từ: 2-12 chars (loại tên 1 chữ cái "A" — ambiguous abbreviation).
  if (words.some((w) => w.length < 2 || w.length > 12)) return null;
  // Reject nếu MỌI từ đều là common (vd "ok thôi", "không gì").
  const allCommon = words.every((w) => COMMON_NON_NAME_WORDS.has(w.toLowerCase()));
  if (allCommon) return null;
  // Reject time-phrase: từ đầu là time-leader VÀ có ≥2 từ → "chiều mai" / "sáng nay" / "tối thứ".
  // Cho phép 1-từ "Mai" / "Sáng" — có thể là tên người, context check ở caller xử lý.
  const TIME_LEADERS = new Set([
    "sáng","chiều","tối","trưa","ngày","buổi","tuần","tháng","năm","giờ","phút","sớm","khuya","đêm",
  ]);
  if (words.length >= 2 && TIME_LEADERS.has(words[0].toLowerCase())) return null;
  // Capitalize đầu mỗi từ.
  return words
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// Detect serviceType từ keyword — backup khi LLM classifier miss extract.
// Vd: "à không, cho anh yoga thôi" — classifier có khi không extract được "yoga".
export function detectServiceByKeyword(message: string): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  // Order: dùng từ ít ambiguity nhất trước
  if (/\bpilates?\b/.test(m)) return "pilates";
  if (/\b(yoga)\b/.test(m)) return "yoga";
  if (/\b(zumba)\b/.test(m)) return "zumba";
  if (/\b(gym|tập\s*gym|đăng\s*kí?\s*gym)\b/.test(m)) return "gym";
  // "bơi" phải có context (học bơi, tập bơi) để tránh false positive
  if (/(học\s*bơi|tập\s*bơi|bộ\s*môn\s*bơi|gói\s*bơi|đi\s*bơi|biết\s*bơi)/.test(m)) return "boi";
  if (/(gói\s*full|thẻ\s*full|combo\s*4|đa\s*dịch\s*vụ)/.test(m)) return "full";
  return null;
}

export function detectFlowByKeyword(
  message: string,
  _previousFlow: Flow | null
): Flow | null {
  // Pain priority: ngay khi có cue đau cụ thể → giải cơ, bất kể fitness keyword
  if (PAIN_PRIORITY.test(message)) return "giai-co";

  const isGiaiCo = GIAI_CO_KEYWORDS.test(message);
  const isFitness = FITNESS_KEYWORDS.test(message);

  if (isGiaiCo && !isFitness) return "giai-co";
  if (isFitness && !isGiaiCo) return "fitness";
  return null;
}

// ─────────────────────────────────────────────
// HONORIFIC DETECTION
// ─────────────────────────────────────────────

export function detectHonorific(
  message: string,
  previous: "anh" | "chị" | "anh/chị"
): "anh" | "chị" | "anh/chị" {
  const msg = message.toLowerCase();

  // Khách viết "anh/chị" → khách dùng dạng generic, giữ nguyên previous
  if (/anh\s*\/\s*ch(ị|i)/.test(msg)) return previous;

  // Boundary an toàn cho Unicode tiếng Việt: dùng start/end, whitespace hoặc dấu câu.
  // KHÔNG match "a" lẻ — quá nhiều false-positive ("a ơi", "a a a", filler).
  const boundary = "(^|[\\s,.!?:;()\\-/])";
  const tail     = "([\\s,.!?:;()\\-/]|$)";

  const isChi = new RegExp(`${boundary}(chị|chj)${tail}`).test(msg);
  if (isChi) return "chị";

  const isAnh = new RegExp(`${boundary}anh${tail}`).test(msg);
  if (isAnh) return "anh";

  return previous;
}

export function resolveHonorific(h: "anh" | "chị" | "anh/chị"): string {
  return h === "anh/chị" ? "anh/chị" : h;
}

// ─────────────────────────────────────────────
// HELPERS — đánh giá độ chín của slot
// ─────────────────────────────────────────────

/**
 * Fitness: coi là "đủ để evaluation" khi biết serviceType VÀ ít nhất 1 trong:
 *   - fitnessGoal (mục tiêu)
 *   - memberType
 *   - schedule
 *   - intent là selecting/ready (khách đã chọn cụ thể hoặc sẵn sàng chốt)
 *
 * Logic: chỉ biết serviceType chưa đủ — cần biết khách muốn gì
 * để tư vấn gói có narrative thay vì liệt kê giá thẳng.
 * NOTE: "compare" KHÔNG còn bypass — khai báo mục tiêu tập không đủ để show gói ngay.
 */
function fitnessReadyForEvaluation(info: KnownInfo, intent: Intent): boolean {
  // Khách đã commit time (preferredTime) → ready bất kể serviceType.
  // Bot có thể recommend service sau khi xin tên/SĐT — không cần stuck hỏi service.
  if (info.preferredTime !== null) return true;

  if (info.serviceType === null) return false;

  // Chỉ khách chủ động chọn gói / sẵn sàng đăng ký → bypass context collection
  if (intent === "selecting" || intent === "ready") {
    return true;
  }

  // explore / compare: cần ít nhất 1 context slot (goal / memberType / schedule)
  // Ngăn bot nhảy vào show gói ngay khi khách chỉ vừa khai báo mục tiêu ("tăng cơ giảm mỡ")
  const hasGoal     = info.fitnessGoal !== null;
  const hasMember   = info.memberType !== null;
  const hasSchedule = info.schedule !== null;

  return hasGoal || hasMember || hasSchedule;
}

/**
 * Giải cơ: coi là "đủ để evaluation" khi biết painArea VÀ pastMethod.
 *
 * Lý do cần pastMethod:
 *   - Đây là bước tạo contrast quan trọng nhất: "Massage chỉ đỡ tạm — giải cơ xử lý tận gốc"
 *   - Nếu khách chưa thử gì → contrast với "không biết cơ thể đang ở đâu"
 *   - Nếu khách đã massage → contrast với "chỉ vuốt bề mặt, không gỡ được nút thắt sâu"
 *   - Chỉ skip nếu khách có intent cao (selecting/ready)
 */
function giaiCoReadyForEvaluation(info: KnownInfo, intent: Intent): boolean {
  if (info.painArea === null) return false;
  
  // Intent cao: khách chủ động chọn
  if (intent === "selecting" || intent === "ready") return true;
  
  // Khách đã đồng ý thử (có giờ cụ thể) → đủ để chuyển sang evaluation rồi commitment
  if (info.preferredTime !== null) return true;
  
  // Bắt buộc đủ 3 bước: painArea → painSpread → pastMethod
  // painSpread cần để hiểu mức độ lan tỏa; pastMethod để tạo contrast tư vấn
  return info.painSpread !== null && info.pastMethod !== null;
}

// ─────────────────────────────────────────────
// STAGE TRANSITION — Hard-coded FSM
// ─────────────────────────────────────────────

export function computeNextStage(
  currentStage: Stage,
  info: KnownInfo,
  intent: Intent,
  flow: Flow,
  llmSuggestedStage: Stage,
  turnCount: number = 0
): Stage {

  // Recovery / retention — giữ nguyên
  if (currentStage === "recovery" || currentStage === "retention") {
    return currentStage;
  }

  // Objection
  if (currentStage === "objection") {
    if (intent === "selecting" || intent === "ready") return "commitment";
    return "objection";
  }

  // Commitment
  if (currentStage === "commitment") {
    return "commitment";
  }

  // Opening → Discovery (hoặc xa hơn nếu slots đã đủ điều kiện)
  // Multi-step: nếu khách cung cấp đủ info ngay tin đầu, nhảy thẳng đến stage phù hợp
  // thay vì buộc phải đi qua discovery một lượt rỗng.
  if (currentStage === "opening") {
    if (
      info.serviceType !== null ||
      info.painArea !== null ||
      info.fitnessGoal !== null ||
      intent !== "explore"
    ) {
      return computeNextStage("discovery", info, intent, flow, llmSuggestedStage, turnCount);
    }
    return "opening";
  }

  // Discovery → Evaluation
  if (currentStage === "discovery") {
    const fitnessReady = flow === "fitness" && fitnessReadyForEvaluation(info, intent);
    const giaiCoReady  = flow === "giai-co" && giaiCoReadyForEvaluation(info, intent);

    if (fitnessReady || giaiCoReady) {
      // GUARD — tin đầu tiên (turnCount <= 1): giữ ở discovery NẾU chưa có thông tin cốt lõi.
      // Bypass guard khi slots cốt lõi đã đầy đủ (khách cung cấp hết 1 lần).
      const coreSlotsFilled =
        (flow === "giai-co" && info.preferredTime !== null) ||
        (flow === "fitness" &&
          info.serviceType !== null &&
          (info.fitnessGoal !== null || info.memberType !== null || info.schedule !== null));

      if (turnCount <= 1 && intent !== "selecting" && intent !== "ready" && !coreSlotsFilled) {
        return "discovery";
      }
      // ANTI-PREMATURE-COMMITMENT GUARD:
      // Khách nói "đăng ký gym" / "lấy yoga" → classifier hay nhầm thành intent=ready,
      // dẫn đến jump thẳng commitment trong khi bot CHƯA hỏi "đã tập X chưa".
      // Yêu cầu ít nhất 1 tín hiệu commit thật: preferredTime, name+phone, hoặc goal+schedule.
      const hasCommitSignal =
        info.preferredTime !== null ||
        (info.name !== null && info.phone !== null) ||
        (info.fitnessGoal !== null && info.schedule !== null);
      if (
        flow === "fitness" &&
        (intent === "selecting" || intent === "ready") &&
        !hasCommitSignal
      ) {
        console.log(`[stateMachine] guard: intent=${intent} nhưng chưa có commit signal → stay discovery`);
        return "discovery";
      }
      // Giải cơ: khách đã báo giờ + chủ động đặt lịch → thẳng commitment, skip evaluation pitch
      if (flow === "giai-co" && (intent === "selecting" || intent === "ready") && info.preferredTime !== null) {
        return "commitment";
      }
      // Fitness: khách chủ động chọn gói / đăng ký → thẳng commitment (đã pass guard)
      if (flow === "fitness" && (intent === "selecting" || intent === "ready")) {
        return "commitment";
      }
      // Fitness: khách báo giờ cụ thể (preferredTime) → skip InBody pitch, vào commitment
      // để xin tên/SĐT giữ slot. InBody là build-value tactic — không cần khi khách đã commit time.
      if (flow === "fitness" && info.preferredTime !== null) {
        console.log(`[stateMachine] fitness discovery → commitment (preferredTime=${info.preferredTime})`);
        return "commitment";
      }
      // Fitness: mandatory Inbody funnel trước khi show gói
      if (flow === "fitness") {
        return "inbody";
      }
      return "evaluation";
    }
    return "discovery";
  }

  // Inbody → Evaluation (hoặc Commitment nếu intent rất cao)
  // Sau khi bot pitch Inbody 1 lần, lượt tiếp theo luôn chuyển sang show gói.
  // Khách nói "không cần đo" hay "cho xem gói" → evaluation
  // Khách nói "ok đăng ký luôn" → commitment
  if (currentStage === "inbody") {
    if (intent === "ready" || intent === "selecting") return "commitment";
    return "evaluation";
  }

  // Evaluation → Negotiation / Commitment
  if (currentStage === "evaluation") {
    // Giải cơ: commit khi khách đã cung cấp tên + SĐT — tức là evaluation pitch đã xảy ra xong
    if (flow === "giai-co" && info.name !== null && info.phone !== null) {
      console.log(`[stateMachine] giai-co evaluation → commitment (name/phone filled)`);
      return "commitment";
    }
    // Giải cơ: intent cao + báo giờ → skip thẳng commitment (khách chủ động đặt lịch)
    if (flow === "giai-co" && (intent === "selecting" || intent === "ready") && info.preferredTime !== null) {
      console.log(`[stateMachine] giai-co evaluation → commitment (high intent + preferredTime=${info.preferredTime})`);
      return "commitment";
    }

    // Fitness: khách đã báo giờ InBody (preferredTime filled) → commitment để hỏi tên/SĐT.
    // Evaluation pitch đã xảy ra ở turn trước — KHÔNG lặp lại. Song song với quy tắc giai-co ở trên.
    if (flow === "fitness" && info.preferredTime !== null) {
      console.log(`[stateMachine] fitness evaluation → commitment (preferredTime=${info.preferredTime})`);
      return "commitment";
    }

    // Fitness: đã có tên/SĐT → commitment
    if (flow === "fitness" && info.name !== null && info.phone !== null) {
      console.log(`[stateMachine] fitness evaluation → commitment (name/phone filled)`);
      return "commitment";
    }

    if (intent === "ready") return "commitment";

    // Fitness: chỉ vào negotiation khi khách chủ động chọn gói cụ thể
    if (intent === "selecting") return "negotiation";

    return "evaluation";
  }

  // Negotiation → Commitment
  if (currentStage === "negotiation") {
    if (intent === "ready" || intent === "selecting") return "commitment";
    // Khách đã báo giờ → commit (tránh lặp pitch). Áp dụng cho cả 2 flow.
    if (info.preferredTime !== null) {
      console.log(`[stateMachine] negotiation → commitment (preferredTime=${info.preferredTime})`);
      return "commitment";
    }
    return "negotiation";
  }

  return llmSuggestedStage;
}

// ─────────────────────────────────────────────
// TEMPERATURE
// ─────────────────────────────────────────────

export function computeTemperature(
  info: KnownInfo,
  intent: Intent,
  stage: Stage
): Temperature {
  if (intent === "ready" || stage === "commitment") return "hot";

  const filledSlots = Object.values(info).filter((v) => v !== null).length;

  if (filledSlots > 0 || intent === "compare" || intent === "selecting") {
    return "warm";
  }

  return "cold";
}

// ─────────────────────────────────────────────
// LLM CLASSIFICATION OUTPUT
// ─────────────────────────────────────────────

export interface LLMClassification {
  flow: Flow | null;
  llmStage: Stage;
  emotion: Emotion;
  intent: Intent;
  intentTopic: IntentTopic | null;
  extractedSlots: Partial<KnownInfo>;
  qrShown: boolean | null;
  mediaShown: boolean | null;
}

// ─────────────────────────────────────────────
// FULL STATE UPDATE
// ─────────────────────────────────────────────

export function buildNextState(
  previous: ConversationState,
  message: string,
  llm: LLMClassification
): ConversationState {
  const honorific = detectHonorific(message, previous.honorific);

  const keywordFlow = detectFlowByKeyword(message, previous.flow);
  let flow = keywordFlow ?? llm.flow ?? previous.flow;

  // HEALTH-SAFETY FLOW LOCK: Nếu turn trước fire safety topic (ask_senior/postpartum/prenatal/post_surgery),
  // turn này dù có mention đau cơ (vd "khớp gối yếu", "cao huyết áp") vẫn STAY fitness flow.
  // Lý do: đang trong context tư vấn tập an toàn, KHÔNG phải đặt giải cơ.
  const wasSafetyContext =
    previous.intentTopic === "ask_senior_safety" ||
    previous.intentTopic === "ask_postpartum_safety" ||
    previous.intentTopic === "ask_prenatal_safety" ||
    previous.intentTopic === "ask_post_surgery";
  if (wasSafetyContext && flow === "giai-co") {
    console.log(`[stateMachine] safety lock: previous=${previous.intentTopic} → giữ flow=fitness`);
    flow = "fitness";
  }

  // POST-SURGERY DETECTION: Tin nhắn có cue "phẫu thuật / mổ / đứt dây chằng / chấn thương phục hồi"
  // → bắt buộc flow=fitness (KHÔNG phải giai-co dù keyword "đau lưng/đầu gối" hit PAIN_PRIORITY).
  // Vì khách hỏi tư vấn TẬP phục hồi, không đặt lịch giải cơ.
  const postSurgeryCue =
    /(phẫu\s*thuật|mới\s*mổ|vừa\s*mổ|đứt\s*dây\s*chằng|chấn\s*thương|đang\s*phục\s*hồi|bác\s*sĩ\s*kêu\s*tập)/i;
  if (postSurgeryCue.test(message) && flow === "giai-co") {
    console.log(`[stateMachine] post-surgery cue → flow=fitness (override giai-co)`);
    flow = "fitness";
  }

  // Detect SERVICE SWITCH: KH đổi bộ môn giữa cuộc thoại.
  // Tín hiệu: LLM classifier extract serviceType MỚI khác serviceType hiện tại trong state.
  // Khi switch:
  //   - lock serviceType vào bộ môn mới (override pick() trong mergeSlots)
  //   - reset slots phụ thuộc service: fitnessGoal, memberType, schedule, durationMonths, sessionPackage
  //   - giữ name/phone/preferredTime (cross-service)
  //   - reset stage về opening để re-chạy discovery (hỏi "đã tập X chưa", mục tiêu...)
  // FALLBACK: nếu LLM classifier không extract serviceType, thử keyword detect (vd "yoga thôi").
  const extractedService =
    llm.extractedSlots.serviceType ?? detectServiceByKeyword(message);
  const FAMI_SERVICES = ["gym", "yoga", "zumba", "boi", "pilates", "full"];
  const normalizedExtracted =
    typeof extractedService === "string" ? extractedService.toLowerCase() : null;
  const switched =
    flow === "fitness" &&
    normalizedExtracted !== null &&
    FAMI_SERVICES.includes(normalizedExtracted) &&
    previous.knownInfo.serviceType !== null &&
    normalizedExtracted !== previous.knownInfo.serviceType
      ? normalizedExtracted
      : null;

  // Deterministic fallback: nếu LLM classifier không extract được name/phone
  // mà message có pattern "<tên> <sđt>" → trust regex (đặc biệt với tên lowercase
  // hoặc trùng từ vựng như "toàn", "an", "vui"... gpt-4o-mini hay miss).
  const inlineExtract = detectNamePhoneInline(message);

  // Context-aware standalone name: nếu inline không bắt được name (vd "Toàn mà")
  // VÀ context cho phép (bot vừa hỏi tên HOẶC state đã có phone nhưng thiếu name) →
  // thử parse message như tên đứng riêng.
  const llmName = llm.extractedSlots.name;
  const llmNameValid = !!(llmName && String(llmName).trim().length > 0);
  const inlineName = inlineExtract.name;
  let standaloneName: string | null = null;
  if (!llmNameValid && !inlineName) {
    const botAskedName = /\b(tên|sđt|name)\b/i.test(previous.lastBotReply ?? "");
    const phoneAlreadySet =
      previous.knownInfo.phone !== null && previous.knownInfo.name === null;
    if (botAskedName || phoneAlreadySet) {
      standaloneName = detectNameStandalone(message);
      if (standaloneName) {
        console.log(
          `[stateMachine] detectNameStandalone: "${message}" → name="${standaloneName}" (botAskedName=${botAskedName} phoneAlreadySet=${phoneAlreadySet})`,
        );
      }
    }
  }

  const extractedSlotsAugmented = {
    ...llm.extractedSlots,
    // Chỉ override khi LLM không cho giá trị (null/undefined/empty).
    name:
      llmNameValid
        ? llmName
        : (inlineName ?? standaloneName),
    phone:
      llm.extractedSlots.phone && String(llm.extractedSlots.phone).trim().length > 0
        ? llm.extractedSlots.phone
        : inlineExtract.phone,
  };
  if (inlineExtract.name || inlineExtract.phone) {
    console.log(
      `[stateMachine] detectNamePhoneInline: name=${inlineExtract.name ?? "—"} phone=${inlineExtract.phone ?? "—"}`,
    );
  }

  let knownInfo = mergeSlots(previous.knownInfo, extractedSlotsAugmented);
  if (switched) {
    knownInfo = {
      ...knownInfo,
      serviceType: switched,
      fitnessGoal: null,
      memberType: null,
      schedule: null,
      durationMonths: null,
      sessionPackage: null,
    };
  }

  const baseStage: Stage =
    flow !== previous.flow ? "opening"
      : switched ? "opening"
      : previous.stage;

  const intent = llm.intent;

  // turnCount: conversation-wide — KHÔNG reset khi flow đổi.
  // Dùng cho greeting decision (đã chào ở turn 1 rồi thì các turn sau dùng "Dạ vâng").
  const turnCount = previous.turnCount + 1;
  // flowTurnCount: per-flow — reset về 1 khi flow đổi.
  // Dùng cho anti-loop guards / discovery guard trong flow hiện tại.
  const flowTurnCount = flow !== previous.flow ? 1 : (previous.flowTurnCount ?? 0) + 1;

  const stage = computeNextStage(
    baseStage,
    knownInfo,
    intent,
    flow,
    llm.llmStage,
    flowTurnCount   // dùng flowTurnCount cho discovery guard (relative đến flow hiện tại)
  );

  const temperature = computeTemperature(knownInfo, intent, stage);
  const emotion = llm.emotion;

  const qrShown    = llm.qrShown    ?? previous.qrShown;
  const mediaShown = llm.mediaShown ?? previous.mediaShown;

  return {
    flow,
    stage,
    temperature,
    emotion,
    intent,
    intentTopic: llm.intentTopic,
    honorific,
    knownInfo,
    turnCount,
    flowTurnCount,
    qrShown,
    mediaShown,
    mediaShownKeys: previous.mediaShownKeys ?? [],
    sheetsWritten: previous.sheetsWritten,
    lastBotReply: previous.lastBotReply,
  };
}

// ─────────────────────────────────────────────
// DEFAULT STATE
// ─────────────────────────────────────────────

export const DEFAULT_STATE: ConversationState = {
  flow: "fitness",
  stage: "opening",
  temperature: "cold",
  emotion: "neutral",
  intent: "explore",
  intentTopic: null,
  honorific: "anh/chị",
  knownInfo: {
    name: null,
    phone: null,
    serviceType: null,
    memberType: null,
    durationMonths: null,
    schedule: null,
    fitnessGoal: null,
    painArea: null,
    painSpread: null,
    painDuration: null,
    pastMethod: null,
    sessionPackage: null,
    preferredTime: null,
  },
  turnCount: 0,
  flowTurnCount: 0,
  qrShown: false,
  mediaShown: false,
  mediaShownKeys: [],
  sheetsWritten: false,
};
/**
 * intent.ts — Hierarchical Intent Classification (Phase 1 refactor)
 *
 * THIẾT KẾ: classify message theo 3 trục độc lập thay vì 1-trong-50 flat enum.
 *   - Domain: nhóm ý định (10 nhóm chính)
 *   - Service: bộ môn được nhắc (nullable)
 *   - Attribute: chi tiết bên trong domain (vd "ask_facility" + "chlorine")
 *
 * Mini classify 3 trục độc lập có accuracy >95% (vs ~80% với 50-flat).
 * Template lookup dùng tuple (domain, service?, attribute?) cộng với stage hiện tại.
 *
 * BACKWARD COMPAT: legacy IntentTopic enum vẫn được duy trì trong stateMachine.ts;
 * hàm `signalToLegacyTopic` map IntentSignal → IntentTopic để questionFlow.ts hiện tại
 * vẫn chạy không phải sửa hàng loạt. Migration ra khỏi legacy sẽ làm ở Phase 2.
 */

import type { IntentTopic } from "./stateMachine";

// ─────────────────────────────────────────────
// CORE TYPES — 3 TRỤC CLASSIFY
// ─────────────────────────────────────────────

/**
 * Domain: nhóm ý định chính của tin nhắn KH.
 * 10 nhóm cover hết flow: opening → discovery → pricing → scheduling → commitment + safety/objection/edge.
 */
export type Domain =
  | "greeting"          // Chào hỏi suông / quan tâm chung
  | "service_inquiry"   // Hỏi về 1 dịch vụ cụ thể (info, facility, features)
  | "pricing"           // Hỏi giá / ưu đãi / gói
  | "scheduling"        // Hỏi giờ mở / lịch lớp / chọn slot / xác nhận giờ
  | "discovery_answer"  // Trả lời discovery question (đã/chưa tập, mục tiêu, số buổi)
  | "safety_concern"    // Bệnh nền / postpartum / prenatal / chấn thương / senior / teen
  | "objection"         // Phản đối giá / lạnh / so sánh / khiếu nại
  | "commitment"        // Đăng ký / chốt / xin cọc / xin QR
  | "media_request"     // Xin xem ảnh / video / tham quan trực tuyến
  | "edge"              // Off-topic / câu hỏi ngoài kịch bản (corporate, refund, branch, ...)
  | "chitchat";         // Tin ngắn "ok"/"ừ"/"dạ" — không ý cụ thể

/**
 * Service: bộ môn được nhắc trong tin nhắn. KHÁC `state.knownInfo.serviceType` —
 * intent service là service trong MESSAGE hiện tại, có thể tạm thời khác state.
 */
export type Service =
  | "gym"
  | "yoga"
  | "zumba"
  | "boi"
  | "pilates"
  | "full"
  | null;

/**
 * Attribute: thuộc tính chi tiết bên trong domain.
 *
 * Mỗi domain có tập attribute riêng (kiểu union string). Mini chỉ pick từ list ngắn
 * (3-8 lựa chọn / domain) → accuracy cao hơn flat 50.
 *
 * Format: prefix theo domain để tránh đụng tên: vd "facility_chlorine" thuộc service_inquiry.
 */
export type Attribute =
  // greeting
  | "general_hi"            // "alo", "chào shop"
  | "show_interest"         // "quan tâm", "có muốn tham khảo"
  | "browsing"              // "đi qua tham quan thôi"
  // service_inquiry — info bộ môn / facility
  | "ask_general_info"      // "yoga thế nào", "zumba ra sao"
  | "ask_new_class"         // "có lớp cho người mới không"
  | "ask_class_composition" // "lớp bây giờ có ai mới không"
  | "ask_pt_guidance"       // "có ai hướng dẫn không", "có HLV không"
  | "ask_hlv_gender"        // "có HLV nữ/nam không"
  | "ask_facility_hours"    // "mở mấy giờ"
  | "ask_facility_traffic"  // "giờ nào vắng / đông"
  | "ask_facility_chlorine" // "bể có clo không"
  | "ask_facility_water_change"
  | "ask_facility_temperature"  // "nước ấm", "bể 4 mùa"
  | "ask_facility_swimwear"
  | "ask_facility_lifeguard"
  | "ask_facility_limit"        // "giới hạn lượt"
  | "ask_facility_size"         // "phòng rộng không"
  | "ask_facility_equipment"
  | "ask_facility_parking"
  | "ask_facility_locker"
  | "ask_facility_shower"
  | "ask_facility_wifi"
  | "ask_facility_kid_supervision"
  | "ask_address"
  | "ask_branch"
  | "ask_history_brand"         // "trung tâm mở bao lâu"
  | "ask_unsupported"           // "có boxing không", "có aerobic riêng không"
  | "ask_combo_with_other"      // "tập kèm dịch vụ khác không"
  | "ask_swim_audience"         // "học bơi cho người lớn hay trẻ em"
  | "ask_child_with_age"        // tuổi đã cho
  | "ask_child_no_age"          // chưa cho tuổi
  | "compare_zumba_aerobic"
  | "ask_zumba_weight_loss"
  // pricing
  | "ask_price_general"         // "bao nhiêu tiền / tháng"
  | "ask_price_list"            // "có những gói nào"
  | "ask_price_with_worry"      // "không biết có theo được không"
  | "ask_price_student"
  | "ask_price_family"
  | "ask_price_combo"
  | "ask_price_pt"
  | "ask_promo"                 // "có ưu đãi không"
  | "ask_payment_method"
  | "ask_payment_traGop"
  // scheduling
  | "register_trial"            // "muốn đăng ký trải nghiệm"
  | "ask_trial_confirm"         // "có được tập thử không"
  | "ask_trial_register_how"    // "đăng ký trải nghiệm thế nào"
  | "ask_class_schedule"        // "lịch lớp khi nào"
  | "give_time_slot"            // KH cho giờ ("9h sáng mai", "chiều thứ 7")
  | "change_time_slot"          // KH đổi giờ ("thôi sáng mai", "dời lại")
  // discovery_answer
  | "has_experience"
  | "no_experience"
  | "goal_lose_weight"          // "muốn giảm cân/mỡ"
  | "goal_gain_muscle"          // "muốn tăng cơ"
  | "goal_relax"                // "muốn thư giãn / giảm stress / ngủ ngon"
  | "goal_learn_swim"           // "muốn học bơi"
  | "goal_health"               // "duy trì sức khỏe"
  | "goal_postpartum_shape"     // "lấy lại dáng sau sinh"
  | "answer_schedule"           // "tập sáng", "3 buổi/tuần"
  | "indecisive_pick_for_me"    // "chưa biết tập gì, chọn giúp em"
  | "answer_history_method"     // "có/chưa thử biện pháp giảm cân"
  | "ask_maintain_after_goal"   // "sau giảm cân muốn duy trì"
  // safety_concern
  | "postpartum"                // mới sinh / cho con bú
  | "prenatal"                  // đang bầu
  | "senior"                    // tuổi cao / bệnh nền
  | "post_surgery"              // chấn thương phục hồi
  | "teen"                      // dưới 18
  | "rapid_weight_loss"         // mục tiêu giảm cân phi thực tế
  | "acute_injury"              // giai-co: vừa bị, sưng nóng
  // objection
  | "price_too_high"            // "đắt quá"
  | "ask_discount"              // "có giảm giá không"
  | "compare_competitor"        // "bên kia rẻ hơn"
  | "cold_lead"                 // "thôi để tham khảo"
  | "complaint_crowded"         // "phòng đông quá"
  | "compare_services"          // "X với Y cái nào tốt hơn"
  | "ask_hold_policy"           // bảo lưu
  | "ask_refund_policy"
  | "ask_change_package"
  | "ask_renewal"
  // commitment
  | "confirm_register"          // "ok đăng ký luôn"
  | "give_contact"              // KH cho tên/SĐT
  | "ask_deposit"               // hỏi cọc
  | "full_package_confirm"
  | "switch_service"            // đổi bộ môn giữa cuộc thoại
  // media
  | "ask_photo"                 // "cho xem hình"
  | "ask_video"
  // edge
  | "corporate"
  | "nutrition"
  | "off_topic"                 // câu hỏi không liên quan
  // chitchat
  | "filler_ok"                 // "ok", "ừ", "dạ"
  | "thanks"
  | "unknown";                  // fallback an toàn

/**
 * IntentSignal — kết quả classify đầy đủ của 1 tin nhắn.
 * Domain BẮT BUỘC; service/attribute optional.
 */
export interface IntentSignal {
  domain: Domain;
  service: Service;
  attribute: Attribute | null;
}

// ─────────────────────────────────────────────
// VALIDATION — runtime check
// ─────────────────────────────────────────────

export const VALID_DOMAINS: readonly Domain[] = [
  "greeting", "service_inquiry", "pricing", "scheduling",
  "discovery_answer", "safety_concern", "objection",
  "commitment", "media_request", "edge", "chitchat",
] as const;

export const VALID_SERVICES: readonly (Service)[] = [
  "gym", "yoga", "zumba", "boi", "pilates", "full", null,
] as const;

export function isValidDomain(s: string): s is Domain {
  return (VALID_DOMAINS as readonly string[]).includes(s);
}

export function isValidService(s: string | null | undefined): s is Service {
  if (s === null || s === undefined) return true;
  return (["gym","yoga","zumba","boi","pilates","full"] as const).includes(s as any);
}

// ─────────────────────────────────────────────
// LEGACY BRIDGE — IntentSignal → IntentTopic
//
// Phase 2 sẽ port hết template sang dùng IntentSignal trực tiếp. Phase 1 vẫn cần
// `intentTopic` cho code hiện tại (questionFlow.TEMPLATES, prefixBuilder gates).
// ─────────────────────────────────────────────

const SIGNAL_TO_TOPIC: Array<{
  match: Partial<IntentSignal>;
  topic: IntentTopic;
}> = [
  // greeting
  { match: { domain: "greeting", attribute: "general_hi" }, topic: "opening_greeting" },
  { match: { domain: "greeting", attribute: "show_interest" }, topic: "opening_greeting" },
  { match: { domain: "greeting", attribute: "browsing" }, topic: "tham_quan" },
  // Fallback domain=greeting → opening_greeting cho an toàn
  { match: { domain: "greeting" }, topic: "opening_greeting" },

  // service_inquiry — facility/info per service
  { match: { domain: "service_inquiry", attribute: "ask_facility_hours", service: "boi" }, topic: "pool_hours" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_hours" }, topic: "ask_open_hours" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_chlorine" }, topic: "pool_chlorine" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_temperature" }, topic: "pool_temperature" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_water_change" }, topic: "pool_water_change" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_swimwear" }, topic: "pool_swimwear" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_lifeguard" }, topic: "pool_lifeguard" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_traffic" }, topic: "pool_traffic" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_limit" }, topic: "pool_limit" },
  { match: { domain: "service_inquiry", attribute: "ask_address" }, topic: "ask_address" },
  { match: { domain: "service_inquiry", attribute: "ask_branch" }, topic: "ask_branch" },
  { match: { domain: "service_inquiry", attribute: "ask_unsupported" }, topic: "ask_unsupported_service" },
  { match: { domain: "service_inquiry", attribute: "ask_combo_with_other" }, topic: "combo_service_ask" },
  { match: { domain: "service_inquiry", attribute: "ask_swim_audience" }, topic: "pool_audience_ask" },
  { match: { domain: "service_inquiry", attribute: "ask_child_no_age" }, topic: "pool_child_no_age" },
  { match: { domain: "service_inquiry", attribute: "ask_child_with_age" }, topic: "pool_child_with_age" },
  { match: { domain: "service_inquiry", attribute: "compare_zumba_aerobic" }, topic: "zumba_vs_aerobic" },
  { match: { domain: "service_inquiry", attribute: "ask_zumba_weight_loss" }, topic: "zumba_weight_loss" },
  { match: { domain: "service_inquiry", attribute: "ask_new_class" }, topic: "new_class_inquiry" },
  { match: { domain: "service_inquiry", attribute: "ask_class_composition" }, topic: "class_has_newbies" },
  { match: { domain: "service_inquiry", attribute: "ask_pt_guidance" }, topic: "guidance_ask" },
  { match: { domain: "service_inquiry", attribute: "ask_hlv_gender" }, topic: "ask_hlv_gender" },
  // facility variants → generic ask_facility (single template handles all)
  { match: { domain: "service_inquiry", attribute: "ask_facility_size" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_equipment" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_parking" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_locker" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_shower" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_wifi" }, topic: "ask_facility" },
  { match: { domain: "service_inquiry", attribute: "ask_facility_kid_supervision" }, topic: "ask_kid_supervision" },
  { match: { domain: "service_inquiry", attribute: "ask_history_brand" }, topic: "ask_facility" },

  // pricing
  { match: { domain: "pricing", attribute: "ask_price_general" }, topic: "price_ask_generic" },
  { match: { domain: "pricing", attribute: "ask_price_list" }, topic: "price_explicit_list" },
  { match: { domain: "pricing", attribute: "ask_price_with_worry" }, topic: "price_with_worry" },
  { match: { domain: "pricing", attribute: "ask_price_student" }, topic: "ask_student_pricing" },
  { match: { domain: "pricing", attribute: "ask_price_combo" }, topic: "ask_combo_pricing" },
  { match: { domain: "pricing", attribute: "ask_price_pt" }, topic: "ask_pt_pricing" },
  { match: { domain: "pricing", attribute: "ask_promo" }, topic: "intro_uu_dai" },
  { match: { domain: "pricing", attribute: "ask_payment_method" }, topic: "ask_payment_method" },
  { match: { domain: "pricing", attribute: "ask_payment_traGop" }, topic: "ask_payment_method" },

  // scheduling
  { match: { domain: "scheduling", attribute: "register_trial" }, topic: "intro_trai_nghiem" },
  { match: { domain: "scheduling", attribute: "ask_trial_confirm" }, topic: "trial_ask_confirm" },
  { match: { domain: "scheduling", attribute: "ask_trial_register_how" }, topic: "trial_register_how" },
  { match: { domain: "scheduling", attribute: "ask_class_schedule" }, topic: "ask_open_hours" },
  // give_time_slot và change_time_slot không có topic legacy tương đương —
  // hiện được handle qua stateMachine.mergeSlots (extract preferredTime) + GATE done-slots / đổi giờ.
  // Để null → fall-through prefix builder bình thường.

  // discovery_answer
  { match: { domain: "discovery_answer", attribute: "has_experience" }, topic: "has_experience" },
  { match: { domain: "discovery_answer", attribute: "no_experience" }, topic: "no_experience" },
  { match: { domain: "discovery_answer", attribute: "goal_lose_weight" }, topic: "intro_giam_can" },
  { match: { domain: "discovery_answer", attribute: "goal_gain_muscle" }, topic: "intro_giam_can" }, // legacy không có topic tăng cơ riêng — fall back giảm cân context
  { match: { domain: "discovery_answer", attribute: "goal_postpartum_shape" }, topic: "ask_postpartum_safety" },
  { match: { domain: "discovery_answer", attribute: "indecisive_pick_for_me" }, topic: "indecisive_pick_for_me" },
  { match: { domain: "discovery_answer", attribute: "ask_maintain_after_goal" }, topic: "maintain_after_goal" },
  // answer_schedule / answer_history_method: không có topic legacy → null (prefix builder xử lý)

  // safety_concern
  { match: { domain: "safety_concern", attribute: "postpartum" }, topic: "ask_postpartum_safety" },
  { match: { domain: "safety_concern", attribute: "prenatal" }, topic: "ask_prenatal_safety" },
  { match: { domain: "safety_concern", attribute: "senior" }, topic: "ask_senior_safety" },
  { match: { domain: "safety_concern", attribute: "post_surgery" }, topic: "ask_post_surgery" },
  { match: { domain: "safety_concern", attribute: "teen" }, topic: "ask_teen_safety" },
  { match: { domain: "safety_concern", attribute: "rapid_weight_loss" }, topic: "ask_rapid_weight_loss" },

  // objection
  { match: { domain: "objection", attribute: "price_too_high" }, topic: "price_objection" },
  { match: { domain: "objection", attribute: "ask_discount" }, topic: "price_objection" },
  { match: { domain: "objection", attribute: "complaint_crowded" }, topic: "complaint_crowded" },
  { match: { domain: "objection", attribute: "ask_hold_policy" }, topic: "ask_hold_policy" },
  { match: { domain: "objection", attribute: "ask_refund_policy" }, topic: "ask_refund_policy" },
  { match: { domain: "objection", attribute: "ask_change_package" }, topic: "ask_change_package" },
  { match: { domain: "objection", attribute: "ask_renewal" }, topic: "ask_renewal" },

  // commitment
  { match: { domain: "commitment", attribute: "full_package_confirm" }, topic: "full_package_confirm" },
  { match: { domain: "commitment", attribute: "switch_service" }, topic: "switch_service" },

  // media
  { match: { domain: "media_request" }, topic: "media_request" },

  // edge
  { match: { domain: "edge", attribute: "corporate" }, topic: "ask_corporate" },
  { match: { domain: "edge", attribute: "nutrition" }, topic: "ask_nutrition" },

  // chitchat — KHÔNG map (return null từ signalToLegacyTopic → prefix builder xử lý)
];

/**
 * Convert IntentSignal sang legacy IntentTopic (cho code hiện tại).
 * Return null nếu không có mapping — caller fall-through xử lý.
 */
export function signalToLegacyTopic(signal: IntentSignal | null): IntentTopic | null {
  if (!signal) return null;
  // Tìm rule match — domain BẮT BUỘC, service/attribute optional.
  // Ưu tiên rule cụ thể hơn (cả service + attribute) trước rule chung.
  let bestMatch: { rule: typeof SIGNAL_TO_TOPIC[number]; score: number } | null = null;
  for (const rule of SIGNAL_TO_TOPIC) {
    if (rule.match.domain && rule.match.domain !== signal.domain) continue;
    if (rule.match.service !== undefined && rule.match.service !== signal.service) continue;
    if (rule.match.attribute !== undefined && rule.match.attribute !== signal.attribute) continue;
    // Score = số field match
    let score = 0;
    if (rule.match.domain) score++;
    if (rule.match.service !== undefined) score++;
    if (rule.match.attribute !== undefined) score++;
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { rule, score };
    }
  }
  return bestMatch?.rule.topic ?? null;
}

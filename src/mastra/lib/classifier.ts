/**
 * classifier.ts
 *
 * LLM Classifier — chỉ xử lý những gì code KHÔNG thể làm deterministic:
 *   1. Emotion
 *   2. Intent
 *   3. Flow (fitness vs giai-co) — chỉ khi keyword pre-check không kết luận
 *   4. Slot extraction — CHỈ những slot đang null
 */

import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import {
  Flow,
  Stage,
  Emotion,
  Intent,
  IntentTopic,
  KnownInfo,
  LLMClassification,
  nullSlots,
} from "./stateMachine";
import {
  Domain,
  Service,
  Attribute,
  IntentSignal,
  VALID_DOMAINS,
  isValidDomain,
  isValidService,
  signalToLegacyTopic,
} from "./intent";
import { buildDateContext, verifyWeekdayInTime } from "./dateHelper";
import { openai } from "../config/openai";

// Single source of truth: list giá trị topic được phép — dùng cho cả zod enum + map output.
const INTENT_TOPICS = [
  "opening_greeting",
  "opening_chuong_trinh",
  "opening_chua_biet",
  "indecisive_pick_for_me",
  "tham_quan",
  "intro_trai_nghiem",
  "intro_giam_can",
  "intro_uu_dai",
  "trial_ask_confirm",
  "trial_register_how",
  "no_experience",
  "has_experience",
  "new_class_inquiry",
  "class_has_newbies",
  "ask_open_hours",
  "pool_audience_ask",
  "pool_child_no_age",
  "pool_child_with_age",
  "pool_hours",
  "pool_temperature",
  "pool_swimwear",
  "pool_chlorine",
  "pool_water_change",
  "pool_lifeguard",
  "pool_traffic",
  "pool_limit",
  "zumba_vs_aerobic",
  "zumba_weight_loss",
  "price_ask_generic",
  "price_with_worry",
  "price_explicit_list",
  "price_objection",
  "full_package_confirm",
  "maintain_after_goal",
  "guidance_ask",
  "combo_service_ask",
  "media_request",
  "switch_service",
  // EDGE TOPICS — ngoài tài liệu Fami chính thức
  "ask_address",
  "ask_branch",
  "ask_facility",
  "ask_hold_policy",
  "ask_refund_policy",
  "ask_change_package",
  "ask_unsupported_service",
  "complaint_crowded",
  "ask_kid_supervision",
  "ask_postpartum_safety",
  "ask_prenatal_safety",
  "ask_senior_safety",
  "ask_rapid_weight_loss",
  "ask_post_surgery",
  "ask_renewal",
  "ask_combo_pricing",
  "ask_nutrition",
  "ask_corporate",
  "ask_pt_pricing",
  "ask_hlv_gender",
  "ask_payment_method",
  "ask_student_pricing",
  "ask_teen_safety",
] as const satisfies readonly IntentTopic[];

const classifierAgent = new Agent({
  name: "classifier",
  id: "val-classifier",
  model: openai("gpt-4o-mini"),
  instructions: `Bạn phân tích tin nhắn khách hàng. Trả JSON theo schema, không markdown, không giải thích.`,
});

// Schema tĩnh: tất cả field nullable. Cho phép gpt-4o-mini bỏ qua slot không cần.
//
// PHASE 1 REFACTOR: classifier giờ output `intentSignal` (3 trục: domain/service/attribute) —
// đây là output CHÍNH. `intentTopic` (legacy flat enum) được DERIVE từ intentSignal trong
// mapToClassification() qua signalToLegacyTopic() — KHÔNG còn ở schema. Mini chỉ classify 3 trục
// (mỗi trục < 12 lựa chọn) → accuracy cao hơn nhiều so với 1-trong-50 flat enum cũ.
const classifierSchema = z.object({
  flow: z.enum(["fitness", "giai-co"]).nullable().optional(),
  emotion: z.enum([
    "neutral", "excited", "anxious", "frustrated", "hesitant", "trusting",
  ]),
  intent: z.enum(["explore", "compare", "selecting", "ready"]),
  intentSignal: z
    .object({
      domain: z.enum([
        "greeting", "service_inquiry", "pricing", "scheduling",
        "discovery_answer", "safety_concern", "objection",
        "commitment", "media_request", "edge", "chitchat",
      ]),
      service: z
        .enum(["gym", "yoga", "zumba", "boi", "pilates", "full"])
        .nullable()
        .optional(),
      attribute: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  slots: z
    .object({
      name:           z.string().nullable().optional(),
      phone:          z.string().nullable().optional(),
      serviceType:    z.string().nullable().optional(),
      memberType:     z.string().nullable().optional(),
      durationMonths: z.number().nullable().optional(),
      schedule:       z.string().nullable().optional(),
      fitnessGoal:    z.string().nullable().optional(),
      painArea:       z.string().nullable().optional(),
      painSpread:     z.string().nullable().optional(),
      painDuration:   z.string().nullable().optional(),
      pastMethod:     z.string().nullable().optional(),
      sessionPackage: z.string().nullable().optional(),
      preferredTime:  z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

// ─────────────────────────────────────────────
// CLASSIFY
// ─────────────────────────────────────────────

export interface ClassifyInput {
  message: string;
  previousFlow: Flow;
  previousStage: Stage;
  currentKnownInfo: KnownInfo;
  needFlowClassification: boolean;
  /** intentTopic của turn trước — dùng cho context-aware classification (follow-up). */
  previousIntentTopic?: IntentTopic | null;
  /** Abort signal — cắt LLM call khi tin mới đến (cancel-and-restart). */
  abortSignal?: AbortSignal;
}

export async function classify(
  input: ClassifyInput
): Promise<LLMClassification> {
  const {
    message,
    previousFlow,
    previousStage,
    currentKnownInfo,
    needFlowClassification,
    previousIntentTopic,
    abortSignal,
  } = input;

  const missingSlots = nullSlots(currentKnownInfo);

  // preferredTime LUÔN có thể re-extract:
  //  - nếu value hiện tại chưa specific (chỉ "sáng", "cuối tuần") → upgrade khi khách bổ sung
  //  - nếu khách ĐỔI Ý ("thôi sáng mai" sau khi đã chốt thứ 7) → cập nhật theo tin mới
  // Việc override an toàn vì mergeSlots dùng score-based: chỉ override khi mới >= cũ về độ cụ thể,
  // hoặc khi khách chủ động nhắc lại thời gian khác.
  const slotsToExtract: (keyof KnownInfo)[] = [...missingSlots];

  // preferredTime: luôn cho re-extract (refine + đổi ý).
  if (!slotsToExtract.includes("preferredTime")) {
    slotsToExtract.push("preferredTime");
  }

  // serviceType: luôn cho re-extract để detect KH đổi bộ môn ("đang nói bơi → quan tâm gym").
  // mergeSlots / buildNextState sẽ so sánh diff để detect switch + reset slots phụ thuộc.
  if (!slotsToExtract.includes("serviceType")) {
    slotsToExtract.push("serviceType");
  }

  // pastMethod: cho re-extract khi tin mới có cue về phương pháp đã thử
  // (vì lần đầu LLM hay suy diễn sai → "chua-thu" mặc dù khách chưa nói).
  const pastMethodCue =
    /(thuốc|massage|xoa\s?bóp|vật\s?lý|châm\s?cứu|cao\s?dán|dán\s?cao|chưa\s?thử|chưa\s?từng|chưa\s?bao\s?giờ|không\s?(thử|từng)|đã\s?thử|đi\s?spa)/i;
  if (
    pastMethodCue.test(message) &&
    !slotsToExtract.includes("pastMethod")
  ) {
    slotsToExtract.push("pastMethod");
  }

  // painArea/painSpread: tương tự — cho re-extract khi khách nhắc cụ thể hơn
  const painAreaCue = /(vai|gáy|cổ|lưng|chân|gối|đầu|hông|mông|tay|cơ)/i;
  if (painAreaCue.test(message) && !slotsToExtract.includes("painArea")) {
    slotsToExtract.push("painArea");
  }
  const painSpreadCue = /(lan|cố\s?định|một\s?(chỗ|điểm)|không\s?lan)/i;
  if (
    painSpreadCue.test(message) &&
    !slotsToExtract.includes("painSpread")
  ) {
    slotsToExtract.push("painSpread");
  }

  // memberType: re-extract khi khách nhắc tới "sinh viên / vợ chồng / gia đình".
  // Cần để bot pitch đúng gói HS/SV hoặc gói gia đình.
  const memberTypeCue =
    /(sinh\s*viên|\bsv\b|học\s*sinh|\bhs\b|vợ\s*chồng|gia\s*đình|cả\s*nhà|với\s+(vợ|chồng|con))/i;
  if (
    memberTypeCue.test(message) &&
    !slotsToExtract.includes("memberType")
  ) {
    slotsToExtract.push("memberType");
  }

  // fitnessGoal: re-extract khi khách bổ sung HOẶC đổi mục tiêu giữa cuộc thoại.
  // Vd: turn 1 "muốn học bơi" → goal=hoc-boi; turn 3 "và mình muốn giảm cân" → cập nhật giam-mo.
  // Slot lock cứng làm bot stuck pitching service cũ → cần update khi có cue mục tiêu rõ.
  const fitnessGoalCue =
    /(giảm\s*(cân|mỡ|béo)|đốt\s*mỡ|tăng\s*(cơ|cân|chiều\s*cao)|to\s*hơn|thư\s*giãn|giảm\s*stress|mất\s*ngủ|chỉnh\s*dáng|cải\s*thiện\s*tư\s*thế|học\s*bơi|biết\s*bơi)/i;
  if (
    fitnessGoalCue.test(message) &&
    !slotsToExtract.includes("fitnessGoal")
  ) {
    slotsToExtract.push("fitnessGoal");
  }

  const prompt = buildPrompt(
    message,
    previousFlow,
    previousStage,
    currentKnownInfo,
    slotsToExtract,
    needFlowClassification,
    previousIntentTopic ?? null
  );

  try {
    const result = await classifierAgent.generate(prompt, {
      // Classifier: temperature thấp để slot extraction deterministic.
      // (Khác fitness agent — agent cần variation, classifier cần ổn định.)
      modelSettings: { temperature: 0.1 },
      abortSignal,
      structuredOutput: {
        schema: classifierSchema,
        instructions:
          "Trả đúng schema JSON. Slot nào không có trong tin → để null. " +
          "Không bao gồm slot không nằm trong yêu cầu extract.",
      },
    });

    const parsed = result.object;
    if (!parsed) {
      console.error("[classifier] structuredOutput trả về null");
      return getDefaultClassification(previousFlow, previousStage);
    }

    return mapToClassification(parsed, needFlowClassification, slotsToExtract);
  } catch (e) {
    console.error("[classifier] LLM error:", e);
    return getDefaultClassification(previousFlow, previousStage);
  }
}

// ─────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────

function buildPrompt(
  message: string,
  previousFlow: Flow,
  previousStage: Stage,
  knownInfo: KnownInfo,
  missingSlots: (keyof KnownInfo)[],
  needFlow: boolean,
  previousIntentTopic: IntentTopic | null
): string {
  const knownParts: string[] = [];
  const dateContext = buildDateContext();
  if (knownInfo.name)           knownParts.push(`tên=${knownInfo.name}`);
  if (knownInfo.phone)          knownParts.push(`sđt=${knownInfo.phone}`);
  if (knownInfo.serviceType)    knownParts.push(`dịch_vụ=${knownInfo.serviceType}`);
  if (knownInfo.fitnessGoal)    knownParts.push(`mục_tiêu=${knownInfo.fitnessGoal}`);
  if (knownInfo.memberType)     knownParts.push(`loại_thành_viên=${knownInfo.memberType}`);
  if (knownInfo.durationMonths) knownParts.push(`thời_hạn=${knownInfo.durationMonths}tháng`);
  if (knownInfo.schedule)       knownParts.push(`lịch=${knownInfo.schedule}`);
  if (knownInfo.painArea)       knownParts.push(`vùng_đau=${knownInfo.painArea}`);
  if (knownInfo.painSpread)     knownParts.push(`lan_toa=${knownInfo.painSpread}`);
  if (knownInfo.painDuration)   knownParts.push(`đau_bao_lâu=${knownInfo.painDuration}`);
  if (knownInfo.pastMethod)     knownParts.push(`đã_thử=${knownInfo.pastMethod}`);
  if (knownInfo.sessionPackage) knownParts.push(`gói=${knownInfo.sessionPackage}`);
  if (knownInfo.preferredTime)  knownParts.push(`giờ_muốn=${knownInfo.preferredTime}`);

  const knownSummary = knownParts.join(", ") || "chưa có gì";

  const slotExtractionFields = missingSlots
    .map((s) => `"${s}": <giá trị hoặc null>`)
    .join(", ");

  const flowInstruction = needFlow
    ? `"flow": "fitness"|"giai-co",  // fitness=tập thể dục/gym/bơi/yoga/zumba | giai-co=massage/đau mỏi/giải cơ/spa`
    : `// flow đã xác định: "${previousFlow}" — không cần classify`;

  const prevTopicLine = previousIntentTopic
    ? `IntentTopic turn TRƯỚC: "${previousIntentTopic}" — nếu KH đang follow-up cùng chủ đề, ưu tiên gán lại topic này (xem mục FOLLOW-UP CONTEXT).`
    : `IntentTopic turn TRƯỚC: null`;

  return `Tin nhắn khách: "${message}"
Đã biết: ${knownSummary}
Flow trước: "${previousFlow}", Stage trước: "${previousStage}"
${prevTopicLine}

NGÀY HIỆN TẠI (múi giờ VN):
${dateContext}

Trả JSON thuần:
{
  ${flowInstruction}
  "emotion": "neutral"|"excited"|"anxious"|"frustrated"|"hesitant"|"trusting",
  "intent": "explore"|"compare"|"selecting"|"ready",
  "intentSignal": {
    "domain": "<1 trong 11 domain bên dưới>",
    "service": "gym"|"yoga"|"zumba"|"boi"|"pilates"|"full"|null,
    "attribute": "<attribute key trong domain — xem mục ATTRIBUTE>"
  },
  ${missingSlots.length > 0 ? `"slots": {${slotExtractionFields}}` : `// slots đã đủ`}
}

EMOTION: suy luận từ cách viết, dấu câu, từ ngữ.

FLOW DISAMBIGUATION:
  - "sauna/xông hơi/spa/jacuzzi" khi hỏi về amenity của trung tâm → flow=fitness (KHÔNG phải giai-co).
  - "phẫu thuật/mổ/đứt dây chằng/chấn thương" → flow=fitness + domain=safety_concern + attribute=post_surgery.
    Giai-co chỉ xử lý đau cơ thông thường — KHÔNG xử lý chấn thương vừa phẫu thuật.

INTENT_SIGNAL: classify message theo 3 trục độc lập. Pick 1 giá trị mỗi trục.

  ─────────────────────────────────────────────
  DOMAIN (11 nhóm — chọn 1):
  ─────────────────────────────────────────────
  greeting          = chào hỏi suông, ngỏ ý quan tâm chung
                      Vd: "alo", "quan tâm", "chào shop", "tư vấn cho tôi", "có gì không"
  service_inquiry   = hỏi VỀ 1 dịch vụ (lịch, cơ sở, FAQ, info, lớp, HLV)
                      Vd: "bể bơi mở mấy giờ", "có lớp cho người mới không", "yoga thế nào", "có HLV nữ không"
  pricing           = hỏi GIÁ, GÓI, ƯU ĐÃI, THANH TOÁN
                      Vd: "bao nhiêu tiền/tháng", "có gói nào", "có khuyến mãi không", "trả góp được không"
  scheduling        = đăng ký trải nghiệm, hỏi lịch lớp, chọn giờ/đổi giờ
                      Vd: "muốn đăng ký trải nghiệm", "có được tập thử không", "9h sáng mai nhé", "thôi dời sang chiều"
  discovery_answer  = trả lời câu hỏi discovery của bot (đã/chưa tập, mục tiêu, lịch tập)
                      Vd: "chưa tập bao giờ", "muốn giảm cân", "tập 3 buổi/tuần", "chị chọn giúp em"
  safety_concern    = bệnh nền, postpartum, prenatal, chấn thương, teen, senior
                      Vd: "mới sinh tập được không", "60 tuổi có sao không", "đang bầu", "đứt dây chằng"
  objection         = phản đối giá / so sánh / khiếu nại / lạnh / bảo lưu
                      Vd: "đắt quá", "bên kia rẻ hơn", "gym hay yoga tốt hơn", "thôi để chị xem thêm"
  commitment        = ok đăng ký, xác nhận chọn gói, cho tên/SĐT, hỏi cọc
                      Vd: "ok đăng ký", "tên anh Hùng", "lấy gói Full", "có cọc trước được không"
  media_request     = xin xem ảnh/video phòng tập/bể bơi
                      Vd: "cho xem hình bể bơi", "có video không", "gửi ảnh phòng tập"
  edge              = câu hỏi NGOÀI kịch bản (corporate, nutrition, chi nhánh khác, off-topic)
                      Vd: "công ty đặt cho 20 nhân viên", "có whey protein không", "có chi nhánh HN không"
  chitchat          = filler không ý cụ thể: "ok", "ừ", "dạ", "cảm ơn"

  ─────────────────────────────────────────────
  SERVICE (mention bộ môn trong tin nhắn — null nếu không nhắc):
  ─────────────────────────────────────────────
  gym | yoga | zumba | boi | pilates | full | null
  - "gym", "tập tạ" → gym
  - "yoga" → yoga
  - "zumba" → zumba
  - "bơi", "học bơi", "bể bơi", "hồ bơi" → boi
  - "pilates" → pilates
  - 2+ dịch vụ ("gym + bơi", "yoga và zumba") khi KH muốn TẬP CẢ HAI → full
  - "gym với yoga cái nào tốt" (SO SÁNH) → null (không phải full)
  - Không nhắc dịch vụ cụ thể → null

  ─────────────────────────────────────────────
  ATTRIBUTE (chi tiết bên trong domain — chọn 1 trong các giá trị tương ứng):
  ─────────────────────────────────────────────
  greeting:
    - general_hi             "alo", "chào shop"
    - show_interest          "quan tâm", "tư vấn cho tôi", "có gì hot"
    - browsing               "đi qua tham quan thôi"

  service_inquiry:
    - ask_general_info       "yoga thế nào", "zumba ra sao", "gym có gì hay"
    - ask_new_class          "có lớp cho người mới không"
    - ask_class_composition  "lớp bây giờ có người mới không"
    - ask_pt_guidance        "có ai hướng dẫn không", "có HLV kèm không"
    - ask_hlv_gender         "có HLV nữ/nam không"
    - ask_facility_hours     "mở mấy giờ", "trung tâm hoạt động giờ nào"
    - ask_facility_traffic   "giờ nào vắng/đông"
    - ask_facility_chlorine  "bể có clo không"
    - ask_facility_water_change "có thay nước không"
    - ask_facility_temperature "bể có ấm không", "4 mùa hay 1 mùa"
    - ask_facility_swimwear  "có cần đồ bơi không"
    - ask_facility_lifeguard "có cứu hộ không"
    - ask_facility_limit     "có giới hạn lượt bơi không"
    - ask_facility_size      "phòng rộng không", "bể bơi to không"
    - ask_facility_equipment "máy tập có những gì"
    - ask_facility_parking   "có chỗ gửi xe không"
    - ask_facility_locker    "có tủ đồ không"
    - ask_facility_shower    "có phòng tắm không"
    - ask_facility_wifi      "có wifi không"
    - ask_facility_kid_supervision "có trông trẻ khi mẹ tập không"
    - ask_address            "địa chỉ ở đâu", "đến chỗ nào"
    - ask_branch             "có chi nhánh không", "cơ sở 2"
    - ask_history_brand      "trung tâm mở bao lâu", "thành lập năm nào"
    - ask_unsupported        "có boxing/aerobic riêng/crossfit không"
    - ask_combo_with_other   "tập kèm dịch vụ khác không"
    - ask_swim_audience      "học bơi cho người lớn hay trẻ em" (chưa specify)
    - ask_child_no_age       "cho con/bé/cháu học bơi" — KHÔNG có số tuổi
    - ask_child_with_age     có số tuổi cụ thể ("bé 6 tuổi", "cháu 7t")
    - compare_zumba_aerobic  "Zumba khác Aerobic chỗ nào"
    - ask_zumba_weight_loss  "Zumba có giảm cân không"

  pricing:
    - ask_price_general      "bao nhiêu tiền/tháng", "giá thế nào"
    - ask_price_list         "có những gói nào"
    - ask_price_with_worry   "giá bao nhiêu, không biết có theo được không"
    - ask_price_student      "có gói cho học sinh/sinh viên không"
    - ask_price_family       "vợ chồng đăng ký giá thế nào"
    - ask_price_combo        "gym+yoga combo bao nhiêu"
    - ask_price_pt           "PT 1-1 bao nhiêu"
    - ask_promo              "có ưu đãi gì không"
    - ask_payment_method     "có chuyển khoản không"
    - ask_payment_traGop     "có trả góp không"

  scheduling:
    - register_trial         "muốn đăng ký trải nghiệm"
    - ask_trial_confirm      "có được tập thử không"
    - ask_trial_register_how "đăng ký trải nghiệm thế nào"
    - ask_class_schedule     "lịch lớp yoga khi nào"
    - give_time_slot         KH cho giờ ("9h sáng mai", "chiều thứ 7")
    - change_time_slot       "thôi sáng mai", "dời sang chiều"

  discovery_answer:
    - has_experience         "tập rồi", "đã từng tập"
    - no_experience          "chưa tập bao giờ", "mới"
    - goal_lose_weight       "muốn giảm cân/mỡ/béo"
    - goal_gain_muscle       "muốn tăng cơ", "to hơn"
    - goal_relax             "muốn thư giãn, giảm stress, ngủ ngon"
    - goal_learn_swim        "muốn học bơi", "biết bơi"
    - goal_health            "duy trì sức khỏe"
    - goal_postpartum_shape  "mới sinh muốn lấy lại dáng"
    - answer_schedule        "tập sáng", "3 buổi/tuần", "chiều tối"
    - indecisive_pick_for_me "chọn giúp em", "tư vấn cho em", "chưa biết, gợi ý"
    - answer_history_method  "đã thử massage", "có uống thuốc", "chưa thử gì"
    - ask_maintain_after_goal "sau giảm cân muốn duy trì"

  safety_concern:
    - postpartum             "mới sinh / sau sinh / cho con bú"
    - prenatal               "đang bầu / có thai"
    - senior                 "60-70 tuổi / có bệnh nền / huyết áp / tiểu đường / khớp"
    - post_surgery           "vừa phẫu thuật / mổ / đứt dây chằng / chấn thương phục hồi"
    - teen                   "em 13-17 tuổi tập gym có sao không"
    - rapid_weight_loss      "giảm 10kg trong 1 tháng"
    - acute_injury           "hôm qua đau / vừa bị / sưng nóng / không nhúc nhích"

  objection:
    - price_too_high         "đắt quá", "chi phí cao quá"
    - ask_discount           "có giảm giá không", "có gói rẻ hơn không"
    - compare_competitor     "bên kia rẻ/tốt hơn"
    - cold_lead              "thôi để chị tham khảo", "chưa quyết"
    - complaint_crowded      "phòng đông quá", "không có máy"
    - compare_services       "gym với yoga cái nào", "X hay Y tốt hơn"
    - ask_hold_policy        "có bảo lưu không"
    - ask_refund_policy      "có hoàn tiền không"
    - ask_change_package     "đổi gói giữa chừng được không"
    - ask_renewal            "hội viên cũ gia hạn"

  commitment:
    - confirm_register       "ok đăng ký luôn", "lấy gói đó"
    - give_contact           KH cho tên/SĐT
    - ask_deposit            "có cọc trước được không", "QR đâu"
    - full_package_confirm   "đăng ký gói Full nhỉ"
    - switch_service         KH đổi bộ môn giữa cuộc thoại

  media_request:
    - ask_photo              "cho xem hình"
    - ask_video              "có video không"

  edge:
    - corporate              "công ty đặt cho 20 nhân viên"
    - nutrition              "tư vấn chế độ ăn", "có whey protein không"
    - off_topic              câu hỏi hoàn toàn không liên quan (vd "thời tiết hôm nay")

  chitchat:
    - filler_ok              "ok", "ừ", "được", "dạ"
    - thanks                 "cảm ơn", "thanks"
    - unknown                không phân loại được

  ─────────────────────────────────────────────
  ⚠️ NẾU không chắc attribute → để null. Domain bắt buộc.
  ⚠️ Chỉ pick attribute từ list TƯƠNG ỨNG domain đã chọn (vd domain=pricing thì attribute phải là ask_price_*).

INTENT:
  explore   = hỏi chung chung, khai báo mục tiêu, hoặc trả lời đơn giản chưa rõ ý định mua
            ("cho hỏi", "bên mình có gì", "tôi muốn tăng cơ", "giảm mỡ nhé", "cảm ơn", "ừ", "ok" - KHI CHƯA CÓ NGỮ CẢNH CHỌN GÓI)
  
  compare   = HỎI CỤ THỂ về gói/giá/dịch vụ ("giá bao nhiêu", "có gói nào", "thẻ mấy tháng", "so sánh giữa...")
  
  selecting = đang CHỌN CỤ THỂ hoặc XÁC NHẬN ĐỒNG Ý:
            - Chọn gói: "muốn đăng ký bơi", "cho chị gói 6 tháng", "lấy gói đó"
            - Xác nhận thử dịch vụ: "ok thử 1 buổi", "thử đi", "đồng ý"
            - Báo giờ/ngày: "chiều được", "sáng nha", "tối nay", "9h sáng mai", "thứ 4 đi", "ngày mai"
            - Xác nhận đơn giản có ngữ cảnh chọn lịch: "ừ", "ok", "được" - KHI ĐANG TRONG BỐI CẢNH HỎI GIỜ
  
  ready     = muốn đăng ký / thanh toán / chốt luôn ("ok đăng ký luôn", "chị lấy gói đó", "cho tôi đặt cọc", "chuyển khoản")

⚠️ QUAN TRỌNG:
  - "ok", "ừ", "được" có thể là selecting hoặc explore - dựa vào ngữ cảnh:
    * Nếu tin trước bot hỏi "sáng hay chiều" → khách nói "sáng" = selecting
    * Nếu tin trước bot hỏi "có muốn thử không" → khách nói "ok" = selecting
    * Nếu Stage=inbody và khách đồng ý ("ok", "được", "e cũng được", "thử đi", "ok thử") → selecting (đồng ý đến đo InBody)
    * Nếu không có ngữ cảnh chọn lịch/dịch vụ → explore
  - "đăng ký X" (X là bộ môn: gym/yoga/zumba/...) — chỉ là EXPLORE khi KH mới bắt đầu, KHÔNG phải READY:
    * "chị đăng ký tập gym" / "anh muốn đăng ký yoga" / "đk tập zumba" → intent=explore (KH mới ngỏ ý, chưa chốt gói/giờ)
    * "ok đăng ký luôn" / "đăng ký gói đó nha" / "chốt đi" → intent=ready (đã có gói/giờ trước đó)

FOLLOW-UP CONTEXT — dùng intentTopic turn TRƯỚC (đã derive từ intentSignal) để giữ chủ đề khi KH follow-up:
  - Trước = complaint_crowded → KH hỏi giờ vắng/cao điểm → giữ domain=objection + attribute=complaint_crowded (không nhầm pool_traffic).
  - Trước = ask_renewal → KH hỏi "có ưu đãi gì cho khách cũ" → giữ domain=objection + attribute=ask_renewal.
  - Trước = ask_postpartum_safety / ask_senior_safety → KH mô tả triệu chứng thêm → giữ domain=safety_concern (KHÔNG nhầm flow giai-co).
  - Trước = ask_facility / ask_address / ask_branch → KH hỏi tiếp CSVC → giữ domain=service_inquiry.

SLOTS cho fitness:
  serviceType   = gym/yoga/zumba/boi/pilates/full — extract khi khách nhắc dịch vụ cụ thể.
                  ⚠️ Multi-service ONLY khi KH muốn TẬP 2+ dịch vụ ("gym và bơi cả 2", "yoga + zumba luôn", "đăng ký gym + yoga", "cả gym lẫn bơi") → trả "full" (combo).
                  ⚠️ COMPARISON ("gym với yoga cái nào tốt hơn", "gym hay yoga", "X so với Y", "X vs Y") → KHÔNG extract serviceType (để null). Đây là hỏi tư vấn, không phải chọn cả 2.
                  TUYỆT ĐỐI KHÔNG trả "gym và bơi" / "gym + bơi" / "gym, bơi" — phải là 1 trong 6 enum.
  memberType    = ca-nhan/gia-dinh/hoc-sinh — extract khi có cue:
                  "sinh viên" / "sv" / "học sinh" / "hs" / "đang học" → "hoc-sinh"
                  "vợ chồng" / "gia đình" / "cả nhà" / "2 vợ chồng" / "với vợ/chồng/con" → "gia-dinh"
                  không có cue → null (đừng đoán "ca-nhan")
  durationMonths = số tháng muốn đăng ký
  schedule      = khung giờ / số buổi mỗi tuần (VD: "sáng" → "sáng", "chiều tối" → "chiều-tối", "3 buổi/tuần" → "3-buoi-tuan")
  fitnessGoal   = giam-mo/tang-co/thu-gian/hoc-boi/suc-khoe/linh-hoat
                  PHẢI extract ngay khi khách đề cập mục tiêu, dù ngầm hiểu:
                  "giảm mỡ" / "giảm cân" / "đốt mỡ" → "giam-mo"
                  "tăng cơ" / "tăng cơ bắp" / "to hơn" → "tang-co"
                  "thư giãn" / "giải stress" / "cho khỏe" → "thu-gian"
                  "học bơi" / "muốn biết bơi" → "hoc-boi"
                  VD: "muốn tập gym giảm mỡ" → serviceType="gym", fitnessGoal="giam-mo"

SLOTS cho giai-co:
  painArea      = vai-gay/lung/chan/toan-than/... — extract vùng đau
  painSpread    = tính chất lan tỏa — extract khi khách mô tả cơn đau:
                  "lan ra" / "lan xuống" / "kéo dài" → "lan-toa"
                  "một chỗ" / "điểm cố định" / "không lan" → "diem-co-dinh"
                  mô tả cụ thể khác → ghi nguyên văn ngắn gọn
  painDuration  = đau bao lâu (VD: "mấy hôm", "1 tuần", "vài tháng")
  pastMethod    = phương pháp đã thử — CHỈ extract khi khách EXPLICITLY nói về phương pháp đã/đang dùng:
                  "chưa thử gì" / "chưa thử cách nào" / "chưa từng" / "chưa bao giờ" / "không thử" → "chua-thu"
                  "có massage" / "đã đi massage" / "xoa bóp" → "massage"
                  "uống thuốc" / "có thuốc" / "dùng thuốc" / "dán cao" → "thuoc"
                  "vật lý trị liệu" / "châm cứu" / "trị liệu" → "vat-ly-tri-lieu"
                  khác → "khac"
                  ⚠️ TUYỆT ĐỐI KHÔNG suy diễn "chua-thu" chỉ vì khách chưa nói. Nếu khách chưa nhắc gì về phương pháp → để null.
                  ⚠️ Khi khách bổ sung sau ("chị có uống thuốc giảm đau") dù slot cũ đã có giá trị → phải UPDATE thành value mới.
  sessionPackage = le/5-buoi/10-buoi/20-buoi

SLOTS chung (áp dụng cả fitness và giai-co):
  name  = tên khách (tên đơn như "trung", "Lan" hoặc họ tên đầy đủ đều được — chấp nhận bất kỳ dạng tên nào)
  phone = số điện thoại
  preferredTime = thời gian khách muốn đến — RESOLVE dựa vào NGÀY HIỆN TẠI ở trên.
    ⚠️ Viết có dấu tiếng Việt, KHÔNG slugify (KHÔNG viết "cuoi tuan", "sang", "chieu" — phải là "cuối tuần", "sáng", "chiều").
    ⚠️ Format: "[giờ] [buổi] [thứ] DD/MM" — gom đủ thành phần khách cho, bỏ qua phần khách không đề cập.

    A) CỤ THỂ (khách có ngày/thứ/giờ rõ):
      "9h sáng mai"       → "9h sáng DD/MM"      (DD/MM = ngày mai)
      "15h thứ 7"         → "15h chiều thứ 7 DD/MM"   (thứ 7 gần nhất chưa qua, buổi suy từ giờ: <12=sáng, 12-17=chiều, ≥18=tối)
      "tối mai 7h"        → "19h tối DD/MM"
      "3h chiều cn"       → "15h chiều chủ nhật DD/MM"
      "tối nay"           → "tối DD/MM"          (= hôm nay)
      "chiều mai"         → "chiều DD/MM"
      "thứ 4 tuần sau"    → "thứ 4 DD/MM"
      "cuối tuần"         → "thứ 7 DD/MM"        (chọn thứ 7 gần nhất — nếu khách bổ sung "chủ nhật" sau thì đổi sang CN)
      "sáng cuối tuần"    → "sáng thứ 7 DD/MM"
      "ngày kia"          → "DD/MM"              (hôm nay + 2)

    B) CHỈ CÓ GIỜ (không kèm ngày):
      "9h"              → "9h sáng DD/MM"        — nếu giờ hiện tại < 9h hôm nay thì lấy hôm nay, không thì ngày mai
      "19h" / "7h tối"  → "19h tối DD/MM"        theo cùng logic
      Tự suy buổi từ giờ (sáng <12, chiều 12-17, tối ≥18).

    C) MƠ HỒ / KHÔNG CHẮC (cue: "tầm", "khoảng", "chắc", "cỡ", "đại khái" — HOẶC chỉ nói buổi trơ):
      "tầm chiều"         → "chiều"               (KHÔNG gán ngày)
      "khoảng sáng"       → "sáng"
      "chắc là tối"       → "tối"
      "sáng" (đứng 1 mình, không ngữ cảnh) → "sáng"
      "lúc nào rảnh em báo" / "chưa biết"  → null

    D) REFINE — khi đã có preferredTime cũ và tin mới BỔ SUNG (cùng hướng, không trái):
      Nếu tin mới của khách BỔ SUNG thông tin (buổi mới, ngày mới, giờ mới) →
      GỘP với value cũ thành value mới CỤ THỂ HƠN.
      Ví dụ:
        Cũ="cuối tuần",  tin mới="sáng nha"              → "sáng thứ 7 DD/MM"
        Cũ="sáng",       tin mới="chủ nhật"              → "sáng chủ nhật DD/MM"
        Cũ="thứ 7 25/04", tin mới="9h nha"               → "9h sáng thứ 7 25/04"
        Cũ="chiều",      tin mới="mai"                   → "chiều DD/MM" (ngày mai)
      Nếu tin mới KHÔNG nói gì về thời gian → giữ nguyên value cũ (trả value cũ y hệt).

    E) ĐỔI Ý — khi khách CHỦ ĐỘNG đổi sang giờ khác (cue: "thôi", "đổi", "chuyển", "dời", "không", "ko"):
      THAY THẾ HOÀN TOÀN value cũ bằng tin mới. KHÔNG gộp với cũ.
      ⚠️ TUYỆT ĐỐI phải extract preferredTime mới — KHÔNG được để null khi message có cue đổi ý + có từ thời gian.
      Ví dụ:
        Cũ="9h sáng thứ 7 02/05",   tin mới="thôi sáng mai luôn nha"   → "sáng DD/MM" (ngày mai)
        Cũ="sáng thứ 7 16/05",      tin mới="à mà thôi dời sang chiều mai được không" → "chiều DD/MM" (ngày mai)
        Cũ="chiều thứ 6 26/04",     tin mới="đổi sang tối được không"  → "tối DD/MM" (giữ ngày cũ)
        Cũ="thứ 7",                 tin mới="ko thứ 7, chuyển cn"      → "chủ nhật DD/MM"
        Cũ="sáng thứ 7 16/05",      tin mới="ok 4h chiều mai nha em"   → "16h chiều DD/MM" (ngày mai)
      Cue đổi ý PHẢI rõ — không nhầm với refine. Nếu chỉ thấy "à" hay câu khác chủ đề → giữ cũ.

    QUY TẮC CHUNG:
      - Ưu tiên gom đủ {giờ + buổi + thứ/ngày} khi khách cho đủ tín hiệu.
      - Có cue mơ hồ (tầm/khoảng/chắc/cỡ) → CHỈ ghi buổi, KHÔNG tự thêm ngày.
      - KHÔNG suy đoán vượt info khách cho — thà generic còn hơn gán sai.
      - KHÔNG slugify, viết đầy đủ có dấu tiếng Việt.

Chỉ extract ${missingSlots.length > 0 ? missingSlots.join(", ") : "— không cần extract"} — để null nếu không đề cập.`;
}

// ─────────────────────────────────────────────
// MAP OUTPUT
// ─────────────────────────────────────────────

const VALID_EMOTIONS: Emotion[] = [
  "neutral", "excited", "anxious", "frustrated", "hesitant", "trusting",
];

const VALID_INTENTS: Intent[] = ["explore", "compare", "selecting", "ready"];

const VALID_TOPICS: readonly string[] = INTENT_TOPICS;

function mapToClassification(
  parsed: any,
  hadFlowInPrompt: boolean,
  missingSlots: (keyof KnownInfo)[]
): LLMClassification {
  const emotion: Emotion = VALID_EMOTIONS.includes(parsed.emotion)
    ? parsed.emotion
    : "neutral";

  const intent: Intent = VALID_INTENTS.includes(parsed.intent)
    ? parsed.intent
    : "explore";

  // Parse intentSignal (3-axis output) + validate. Domain bắt buộc; service/attribute optional.
  let intentSignal: IntentSignal | null = null;
  if (parsed.intentSignal && isValidDomain(parsed.intentSignal.domain)) {
    const rawService = parsed.intentSignal.service ?? null;
    const service: Service = isValidService(rawService) ? (rawService as Service) : null;
    const attribute = typeof parsed.intentSignal.attribute === "string"
      ? (parsed.intentSignal.attribute as Attribute)
      : null;
    intentSignal = {
      domain: parsed.intentSignal.domain as Domain,
      service,
      attribute,
    };
  }

  // Derive legacy IntentTopic từ intentSignal qua mapping bridge (intent.ts).
  // Backward compat: code hiện tại (questionFlow.TEMPLATES, prefixBuilder GATE) đọc intentTopic.
  const intentTopic: IntentTopic | null = signalToLegacyTopic(intentSignal);

  const flow: Flow | null = hadFlowInPrompt
    ? (["fitness", "giai-co"].includes(parsed.flow) ? parsed.flow : null)
    : null;

  const extractedSlots: Partial<KnownInfo> = {};
  if (parsed.slots && missingSlots.length > 0) {
    for (const slot of missingSlots) {
      if (parsed.slots[slot] !== undefined) {
        (extractedSlots as any)[slot] = parsed.slots[slot];
      }
    }
  }

  // Verify thứ-trong-tuần khớp với DD/MM. Nếu LLM lỡ ghi "thứ 7 26/04" mà
  // 26/04 thực ra là CN → tự sửa lại thành "chủ nhật 26/04".
  if (typeof extractedSlots.preferredTime === "string") {
    const before = extractedSlots.preferredTime;
    const after = verifyWeekdayInTime(before);
    if (after !== before) {
      console.warn(
        `[classifier] sửa thứ-trong-tuần: "${before}" → "${after}"`,
      );
      extractedSlots.preferredTime = after ?? before;
    }
  }

  return {
    flow,
    llmStage: "discovery",
    emotion,
    intent,
    intentTopic,
    intentSignal,
    extractedSlots,
    qrShown: null,
    mediaShown: null,
  };
}

function getDefaultClassification(
  previousFlow: Flow,
  previousStage: Stage
): LLMClassification {
  return {
    flow: previousFlow,
    llmStage: previousStage,
    emotion: "neutral",
    intent: "explore",
    intentTopic: null,
    intentSignal: null,
    extractedSlots: {},
    qrShown: null,
    mediaShown: null,
  };
}
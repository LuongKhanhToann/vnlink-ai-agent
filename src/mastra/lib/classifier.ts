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
import { buildDateContext, verifyWeekdayInTime } from "./dateHelper";
import { openai } from "../config/openai";

// Single source of truth: list giá trị topic được phép — dùng cho cả zod enum + map output.
const INTENT_TOPICS = [
  "opening_greeting",
  "opening_chuong_trinh",
  "opening_chua_biet",
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
const classifierSchema = z.object({
  flow: z.enum(["fitness", "giai-co"]).nullable().optional(),
  emotion: z.enum([
    "neutral", "excited", "anxious", "frustrated", "hesitant", "trusting",
  ]),
  intent: z.enum(["explore", "compare", "selecting", "ready"]),
  intentTopic: z.enum(INTENT_TOPICS).nullable().optional(),
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
  "intentTopic": <1 trong các topic bên dưới, hoặc null nếu không match>,
  ${missingSlots.length > 0 ? `"slots": {${slotExtractionFields}}` : `// slots đã đủ`}
}

EMOTION: suy luận từ cách viết, dấu câu, từ ngữ.

FLOW DISAMBIGUATION (rất quan trọng — tránh route sai giữa fitness và giai-co):
  - "sauna", "xông hơi", "spa", "jacuzzi", "phòng nóng" — KHI HỎI VỀ TIỆN ÍCH/AMENITY của trung tâm (kể cả khi so sánh với phòng gym khác) → vẫn flow=fitness, KHÔNG phải giai-co.
    Vd: "bên kia có sauna với xông hơi" → flow=fitness (đang hỏi CSVC của fitness center).
    Chỉ route giai-co khi KH thực sự muốn ĐẶT lịch dịch vụ giải cơ (massage chuyên sâu).
  - "phẫu thuật / mổ / đứt dây chằng / chấn thương cần phục hồi" — flow=fitness (hỏi tư vấn tập phục hồi), KHÔNG phải giai-co dù có vùng đau.
    Vd: "anh mới phẫu thuật đứt dây chằng đầu gối 3 tháng" → flow=fitness + topic=ask_post_surgery.
    Giai-co chỉ xử lý đau cơ thông thường — KHÔNG xử lý chấn thương vừa phẫu thuật (cần BS).

INTENT_TOPIC: phân loại NỘI DUNG khách đang hỏi/nói. Chọn 1 topic phù hợp NHẤT, hoặc null nếu KHÔNG có topic nào sát.
  CHỈ chọn topic khi MESSAGE THỰC SỰ khớp ý nghĩa. KHÔNG đoán bừa — null tốt hơn sai.

  ── OPENING (chào hỏi / chưa rõ nhu cầu) ──
  opening_greeting          = chào suông không có nội dung: "Quan tâm", "Hi", "Alo", "Chào shop"
  opening_chuong_trinh      = "tư vấn chương trình tập luyện cho tôi", "có chương trình gì", "có gói tập nào"
  opening_chua_biet         = "chưa biết tập gì", "cho chị tham khảo", "không biết tập môn nào"
  tham_quan                 = "đi qua tham quan thôi", "chỉ ghé xem"

  ── INTRO MỤC TIÊU / TRẢI NGHIỆM ──
  intro_trai_nghiem         = "tôi muốn tập trải nghiệm", "muốn thử tập", "đến trải nghiệm"
                              (KH chủ động ngỏ ý trải nghiệm, KHÔNG hỏi "có được thử không")
  intro_giam_can            = "muốn giảm cân/mỡ/béo", "tập giảm cân"
                              (KH chỉ khai mục tiêu, chưa hỏi gì cụ thể)
  intro_uu_dai              = "có ưu đãi nào không", "có khuyến mãi gì", "đang khuyến mãi gì"

  ── TRIAL ──
  trial_ask_confirm         = "có được tập thử không em", "cho thử 1 buổi được không"
                              (câu HỎI yes/no về việc có cho thử — khác intro_trai_nghiem)
  trial_register_how        = "đăng ký trải nghiệm như thế nào", "đk thử kiểu gì"

  ── DISCOVERY / LỚP HỌC ──
  no_experience             = "chưa tập bao giờ", "chưa từng tập", "mới tập", "chưa tập"
                              (KH trả lời câu "đã tập X chưa" với NO/chưa)
  has_experience            = "đã tập rồi", "tập rồi", "có tập", "từng tập", "từng đi rồi",
                              "đã có kinh nghiệm", "tôi tập gym lâu rồi", "tập được vài năm"
                              (KH trả lời câu "đã tập X chưa" với YES/đã từng)
  new_class_inquiry         = "có lớp cho người mới không em", "có lớp dành cho người mới tập"
                              (KH lo lắng, hỏi xem có lớp riêng newbie không)
  class_has_newbies         = "Lớp bây giờ có người mới không em", "hiện tại lớp có ai mới không"
                              (KH muốn biết THÀNH PHẦN lớp hiện tại — khác new_class_inquiry)

  ── LOGISTICS / GIỜ MỞ CỬA ──
  ask_open_hours            = "khi nào qua được", "qua lúc nào", "mấy giờ mở", "lúc nào ghé được",
                              "trung tâm mở mấy giờ", "mấy giờ đóng cửa", "mở giờ nào"
                              (KH hỏi giờ trung tâm hoạt động chung — KHÔNG phải hỏi giá / lịch lớp cụ thể.
                               Nếu KH chỉ định "bể bơi mở giờ nào" → chọn pool_hours thay vì cái này.)

  ── BƠI ──
  pool_audience_ask         = "muốn học bơi" / "quan tâm bơi" — KH chưa nói NL hay TE, chưa nói tuổi
                              (CHỈ dùng turn ĐẦU mention bơi; nếu KH đã specify "cho trẻ em / cho người lớn" — dùng pool_child_no_age / khác)
  pool_child_no_age         = "cho con tôi học", "bé nhà mình", "cháu", "cho trẻ em", "cho học sinh",
                              "bơi cho bé", "lớp bơi trẻ em" — KHÔNG có số tuổi cụ thể
                              ⚠️ NẾU message có số tuổi (vd "6 tuổi", "bé 5t", "cháu 7t") → BẮT BUỘC dùng pool_child_with_age,
                              KHÔNG dùng pool_child_no_age dù previous=pool_child_no_age.
  pool_child_with_age       = đã đề cập tuổi cụ thể của bé ("6 tuổi", "bé 5t")
  pool_hours                = "bể bơi mở giờ nào", "bể bơi mở mấy giờ"
  pool_temperature          = hỏi về nước ấm/lạnh/4 mùa/mái che/trong nhà ngoài trời
  pool_swimwear             = "có cần mặc đồ bơi không", "có bắt buộc đồ bơi"
  pool_chlorine             = "bể có clo không", "có dùng chlorine"
  pool_water_change         = "có thay nước không em", "nước bể có sạch không"
  pool_lifeguard            = "có cứu hộ không", "có thầy kèm khi bơi không"
  pool_traffic              = "giờ nào vắng/đông", "khung giờ ít người"
  pool_limit                = "giới hạn lượt bơi không", "có hạn số lần không"

  ── ZUMBA ──
  zumba_vs_aerobic          = so sánh Zumba với Aerobic ("đang phân vân aerobic", "Zumba khác Aerobic chỗ nào")
  zumba_weight_loss         = "Zumba có giảm cân không", "tập Zumba giảm mỡ không"

  ── PRICING ──
  price_ask_generic         = hỏi giá chung "bao nhiêu tiền/tháng", "giá thế nào", "phí tập"
                              (KHÔNG match: "có gói nào" — đó là price_explicit_list)
  price_with_worry          = hỏi giá + tỏ lo "chưa tập bao giờ, không biết có theo được không"
                              (HẢ HAI yếu tố: hỏi giá VÀ tỏ lo lắng trong cùng 1 tin)
  price_explicit_list       = "có những gói giá nào em", "gói giá nào thế", "có các gói gì"
  price_objection           = "đắt quá", "chi phí cao quá", "có gói rẻ hơn không"

  ── PACKAGE / GOAL ──
  full_package_confirm      = "đăng ký gói Full luôn", "chọn gói Full nhỉ", "lấy gói Full"
  maintain_after_goal       = "sau khi giảm cân muốn duy trì", "mất ngủ", "khó ngủ"
  guidance_ask              = "có ai hướng dẫn không", "có HLV kèm không"

  ── COMBO ──
  combo_service_ask         = "tập Zumba có tập kèm dịch vụ khác không", "có gói combo không"

  ── MEDIA ──
  media_request             = "cho xem ảnh phòng tập", "có hình bể bơi không", "gửi video xem với"

  ── SWITCH SERVICE ──
  switch_service            = KH đang trên bộ môn X, giờ chủ động đổi sang Y
                              ("đang nói bơi → tôi quan tâm tập gym", "thôi chuyển sang yoga")
                              (CHỈ khi previous flow đã có serviceType khác)

  ── EDGE TOPICS (ngoài kịch bản Fami chính) ──
  ask_address               = "địa chỉ ở đâu", "trung tâm ở chỗ nào", "cho xin địa chỉ", "đến đâu để tập"
                              (CHỈ khi KH hỏi địa điểm/địa chỉ cụ thể, KHÔNG phải "lúc nào qua" — đó là ask_open_hours)
  ask_branch                = "có cơ sở 2 không", "có chi nhánh ở HN/SG", "ngoài Vĩnh Yên có chỗ nào", "anh ở Hà Nội tập được không"
  ask_facility              = hỏi tiện ích cơ sở: "có chỗ gửi xe không", "có tủ đồ phòng tắm không",
                              "phòng có điều hòa/máy lọc khí/wifi không", "có sauna/xông hơi không"
                              (KHÁC pool_* — pool dành riêng cho bể bơi)
  ask_hold_policy           = "thẻ tập có bảo lưu không", "đi công tác giữ thẻ được không", "vắng có bảo lưu được không"
  ask_refund_policy         = "lỡ đăng ký không tập có hoàn tiền không", "trả lại tiền được không", "có refund không"
  ask_change_package        = "đang tập gym muốn đổi sang yoga thì sao", "đổi gói giữa chừng được không", "có chuyển sang gói khác được không"
  ask_unsupported_service   = hỏi bộ môn KHÔNG có trong [Gym, Yoga, Zumba, Bơi, Pilates]:
                              "có boxing không", "có kickbox", "có aerobic riêng không", "có lớp dance",
                              "có CrossFit", "có võ thuật", "có cardio dance"
                              (Aerobic CHỈ → ask_unsupported_service khi KH hỏi LỚP aerobic riêng;
                               nếu so sánh Zumba vs Aerobic → zumba_vs_aerobic)
  complaint_crowded         = "phòng tập đông quá", "hôm qua đến không có máy", "lúc nào cũng đông kiểu này",
                              "không có máy để tập", "đông không tập được"
  ask_kid_supervision       = "có chỗ trông trẻ con không", "có dịch vụ trông trẻ khi mẹ tập không",
                              "không có ai trông con", "mang con đi tập gửi ai"
                              (KHÁC pool_child_* — đây hỏi TRÔNG TRẺ khi MẸ tập, không phải bé đi học bơi)
  ask_postpartum_safety     = "MỚI SINH tập được không", "đang cho con bú có tập được không",
                              "SAU sinh tập sao", "vừa sinh được X tháng"
                              (CHỈ khi KH đã SINH RỒI; nếu đang BẦU → dùng ask_prenatal_safety)
  ask_prenatal_safety       = "đang BẦU X tháng có tập được không", "có thai có tập được không",
                              "mang bầu tập yoga được không", "yoga bầu / lớp bầu"
                              (KH ĐANG MANG THAI, chưa sinh — khác postpartum)
  ask_senior_safety         = "người 60/65/70 tuổi tập được không", "mẹ/bà tập được không",
                              "có bệnh tim mạch/huyết áp/khớp/tiểu đường tập được không",
                              "thoái hóa khớp tập được không"
  ask_rapid_weight_loss     = mục tiêu giảm cân phi thực tế ("giảm 10kg trong 1 tháng",
                              "giảm 5kg trong 2 tuần", "muốn gầy nhanh trong tuần này")
  ask_post_surgery          = "vừa phẫu thuật", "mới mổ", "đứt dây chằng đang phục hồi",
                              "bác sĩ kêu tập nhẹ", "chấn thương cần tập phục hồi"
  ask_renewal               = "hết hạn thẻ giờ muốn gia hạn", "thẻ tập cũ", "anh tập rồi giờ muốn đăng ký lại",
                              "hội viên cũ", "đã đăng ký năm ngoái"
  ask_combo_pricing         = "1 tháng combo bao nhiêu", "gym+yoga 1 tháng nhiêu", "gói combo 2 môn giá nào",
                              "kết hợp 2 môn bao nhiêu/tháng"
                              (KHÁC combo_service_ask — combo_service_ask hỏi CÓ combo không;
                               ask_combo_pricing hỏi GIÁ combo cụ thể)
  ask_nutrition             = "tư vấn chế độ ăn", "ăn gì khi tập", "bán whey protein không",
                              "có chế độ dinh dưỡng đi kèm không"
  ask_corporate             = "công ty đăng ký cho X nhân viên", "gói doanh nghiệp",
                              "tập tập thể cho công ty", "corporate package"
  ask_pt_pricing            = "PT 1-1 bao nhiêu / tháng", "HLV riêng giá nào", "thuê HLV cá nhân giá",
                              "PT theo buổi bao nhiêu"
                              (KH hỏi cụ thể GIÁ PT — KHÁC ask_combo_pricing)
  ask_hlv_gender            = "có HLV nữ không", "có HLV nam không", "muốn HLV nữ vì ngại",
                              "có cô giáo nữ không"
  ask_payment_method        = "có trả góp không", "thanh toán thẻ credit", "có nhận card không",
                              "chuyển khoản được chứ", "có mã QR không"
                              (CHỈ khi KH hỏi HÌNH THỨC thanh toán, KHÔNG phải đã đến lúc cọc)
  ask_student_pricing       = "có gói cho học sinh không", "ưu đãi sinh viên", "giá học sinh bao nhiêu"
                              (CHỈ khi KH hỏi giá riêng cho HS/SV; nếu chỉ nói tuổi → ask_teen_safety)
  ask_teen_safety           = "em 13-17 tuổi có tập gym được không", "em đang học cấp 2/3 tập gym",
                              "cháu tuổi teen muốn tăng cơ", "tuổi này tập tạ có sao không"
                              (KH dưới 18 hỏi an toàn khi tập gym/tạ — khác ask_student_pricing chỉ hỏi giá)

  ── null ──
  null                      = không topic nào match, hoặc KH đang trả lời thông thường
                              (vd: cung cấp tên/SĐT, "ừ", "ok", "dạ", câu chat thường ngày)

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

FOLLOW-UP CONTEXT — dùng IntentTopic turn TRƯỚC để chọn topic turn này khi KH chat tiếp cùng chủ đề:
  - Trước = complaint_crowded:
    * KH hỏi tiếp về giờ vắng / cao điểm / khung giờ ít người → vẫn complaint_crowded (KHÔNG nhầm sang pool_traffic).
    * pool_traffic chỉ dùng khi KH hỏi rõ về BỂ BƠI ("bể giờ nào vắng").
  - Trước = ask_renewal:
    * KH hỏi "có ưu đãi gì cho khách cũ" / "gói 12 tháng cho HV cũ" / "giảm thêm bao nhiêu" → vẫn ask_renewal.
  - Trước = ask_postpartum_safety / ask_senior_safety:
    * KH mô tả thêm bệnh nền / triệu chứng ("bà có cao huyết áp", "khớp gối yếu") → vẫn topic safety đó (KHÔNG nhầm sang flow giai-co).
  - Trước = ask_facility / ask_address / ask_branch:
    * KH hỏi tiếp về CSVC khác cùng category → vẫn cùng topic group.

SLOTS cho fitness:
  serviceType   = gym/yoga/zumba/boi/pilates/full — extract khi khách nhắc dịch vụ cụ thể
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

  const intentTopic: IntentTopic | null =
    parsed.intentTopic && VALID_TOPICS.includes(parsed.intentTopic)
      ? (parsed.intentTopic as IntentTopic)
      : null;

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
    extractedSlots: {},
    qrShown: null,
    mediaShown: null,
  };
}
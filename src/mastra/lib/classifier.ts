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
  MediaMove,
  nullSlots,
  sanitizeName,
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
import { classifierModel, openai } from "../config/openai";

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

const CLASSIFIER_INSTRUCTIONS =
  `Bạn phân tích tin nhắn khách hàng. Trả JSON theo schema, không markdown, không giải thích.`;

const classifierAgent = new Agent({
  name: "classifier",
  id: "val-classifier",
  model: classifierModel,
  instructions: CLASSIFIER_INSTRUCTIONS,
});

// Hook A/B: override model để đo head-to-head (vd 4o-mini vs 5.4-mini). Prod KHÔNG
// truyền modelId → dùng singleton classifierModel y như cũ (hành vi không đổi).
function classifierAgentFor(modelId?: string) {
  if (!modelId) return classifierAgent;
  return new Agent({
    name: "classifier",
    id: `val-classifier-${modelId}`,
    model: openai.chat(modelId),
    instructions: CLASSIFIER_INSTRUCTIONS,
  });
}

// Schema tĩnh: tất cả field nullable. Cho phép gpt-4o-mini bỏ qua slot không cần.
//
// PHASE 1 REFACTOR: classifier giờ output `intentSignal` (3 trục: domain/service/attribute) —
// đây là output CHÍNH. `intentTopic` (legacy flat enum) được DERIVE từ intentSignal trong
// mapToClassification() qua signalToLegacyTopic() — KHÔNG còn ở schema. Mini chỉ classify 3 trục
// (mỗi trục < 12 lựa chọn) → accuracy cao hơn nhiều so với 1-trong-50 flat enum cũ.
// ⚠ HARDENING PARSE: mọi enum bọc .catch(default). LLM thỉnh thoảng trả 1 field lệch enum
// (vd honorific="em", intent="curious", emotion lạ) → TRƯỚC đây Zod throw → MẤT TOÀN BỘ classification
// → fallback getDefaultClassification (domain=null) → mất directive (vd objection "đắt thế e" rớt ~50%).
// .catch coerce field lệch về default, GIỮ phần còn lại (domain/slots) thay vì vứt hết.
const classifierSchema = z.object({
  flow: z.enum(["fitness", "giai-co"]).nullable().optional().catch(null),
  emotion: z.enum([
    "neutral", "excited", "anxious", "frustrated", "hesitant", "trusting",
  ]).catch("neutral"),
  intent: z.enum(["explore", "compare", "selecting", "ready"]).catch("explore"),
  // Xưng hô KH tự nhận: "anh"/"a" → anh, "chị"/"c" → chị. Không rõ → null (giữ cũ).
  honorific: z.enum(["anh", "chị"]).nullable().optional().catch(null),
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
        .optional()
        .catch(null),
      attribute: z.string().nullable().optional(),
    })
    .nullable()
    .optional()
    .catch(null),
  // Multi-intent: KH hỏi 2-3 thứ trong 1 tin nhắn → primary = intentSignal,
  // còn lại nằm trong secondaryIntents. Max 2 entry. Null/empty = single-intent.
  secondaryIntents: z
    .array(
      z.object({
        domain: z.enum([
          "greeting", "service_inquiry", "pricing", "scheduling",
          "discovery_answer", "safety_concern", "objection",
          "commitment", "media_request", "edge", "chitchat",
        ]),
        service: z
          .enum(["gym", "yoga", "zumba", "boi", "pilates", "full"])
          .nullable()
          .optional()
          .catch(null),
        attribute: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional()
    .catch(null),
  // Nước đi media chủ động (như sale khôn khéo): gửi đúng lúc đúng bộ môn, không linh tinh.
  // .catch("none") = mặc định an toàn: parse lệch → KHÔNG gửi (thà thiếu còn hơn gửi sai/lố).
  mediaMove: z
    .enum(["none", "show_service", "show_results"])
    .nullable()
    .optional()
    .catch("none"),
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
      appointmentDate: z.string().nullable().optional(),
      bodyStats:      z.string().nullable().optional(),
      gender:         z.string().nullable().optional(),
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
  /** Override model classifier (CHỈ dùng cho đo A/B; prod để trống → classifierModel mặc định). */
  modelId?: string;
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
    modelId,
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

  // appointmentDate: luôn cho re-extract — đi đôi preferredTime để resolve NGÀY tuyệt đối mỗi turn
  // (carry-forward + override do mergeSlots xử lý). Là khóa danh tính đơn → phải bám sát mọi turn.
  if (!slotsToExtract.includes("appointmentDate")) {
    slotsToExtract.push("appointmentDate");
  }

  // serviceType: luôn cho re-extract để detect KH đổi bộ môn ("đang nói bơi → quan tâm gym").
  // mergeSlots / buildNextState sẽ so sánh diff để detect switch + reset slots phụ thuộc.
  if (!slotsToExtract.includes("serviceType")) {
    slotsToExtract.push("serviceType");
  }

  // Re-extract slot mang NGHĨA nghiệp vụ (mục tiêu / vùng đau / phương pháp đã thử / loại thành viên)
  // khi khách BỔ SUNG hoặc ĐỔI Ý giữa cuộc thoại. Trước đây gate bằng regex cue từ khóa → khách diễn
  // đạt LẠ (không trúng keyword) thì slot cũ không update → bot kẹt/pitch sai hướng.
  // Nay để LLM tự trích (đúng nguyên tắc: không dùng regex cho quyết định nghĩa nghiệp vụ): classifier
  // prompt đã dặn "khách chưa nhắc → null"; mergeSlots/pickWithReextract giữ nguyên giá trị cũ khi LLM
  // trả null, chỉ override khi có value mới THẬT. Chỉ gate theo FLOW (state) để không nhồi slot lệch
  // flow gây noise cho model nhỏ (đối xứng slotsFor).
  const scopeFitness = needFlowClassification || previousFlow === "fitness";
  const scopeGiaiCo = needFlowClassification || previousFlow === "giai-co";
  const addSlot = (s: keyof KnownInfo) => {
    if (!slotsToExtract.includes(s)) slotsToExtract.push(s);
  };
  if (scopeFitness) {
    addSlot("fitnessGoal");
    addSlot("memberType");
  }
  if (scopeGiaiCo) {
    addSlot("painArea");
    addSlot("painSpread");
    addSlot("pastMethod");
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
    const result = await classifierAgentFor(modelId).generate(prompt, {
      // Classifier: temperature=0 để slot/intent extraction TẤT ĐỊNH.
      // (Khác fitness agent — agent cần variation, classifier cần ổn định.)
      // 0.1 làm objection terse ("đắt thế e") flaky → có lúc domain=null, mất directive reframe value.
      // 0 ổn định objection. Tác dụng phụ cũ (BỊA preferredTime "thử 1 buổi"→"thứ 4 17/06") đã được
      // chặn TẤT ĐỊNH bởi sanitizePreferredTime (cắt preferredTime khi message KHÔNG có cue thời gian).
      modelSettings: { temperature: 0 },
      abortSignal,
      structuredOutput: {
        schema: classifierSchema,
        // DeepSeek-V4 KHÔNG hỗ trợ response_format json_schema ("type unavailable").
        // jsonPromptInjection:true → Mastra inject schema vào prompt + parse text,
        // KHÔNG gửi response_format json_schema lên API → tương thích DeepSeek.
        jsonPromptInjection: true,
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
//
// BỐ CỤC CHO PROMPT CACHING (OpenAI tự cache prefix ≥1024 tok, giảm ~90% giá input
// phần trùng): phần TĨNH (taxonomy — KHÔNG phụ thuộc tin khách) đặt LÊN ĐẦU; phần
// ĐỘNG (tin khách / đã-biết / ngày / slot cần extract) gom vào dataTail ĐẶT CUỐI.
// Đầu prompt ổn định theo flow (slot theo flow) → byte-identical giữa các lượt cùng
// 1 cuộc thoại → cache hit. Đo cached_tokens ở response.usage để xác nhận.
// ─────────────────────────────────────────────

type SlotScope = "fitness" | "giai-co" | "both";

// Định nghĩa slot TÁCH theo flow → chỉ gửi block của flow đang chạy (slim ~nửa block
// slot). Nội dung GIỮ NGUYÊN VĂN từ bản cũ, chỉ tách ra để gửi có chọn lọc.
const SLOTS_FITNESS = `SLOTS cho fitness:
  serviceType   = gym/yoga/zumba/boi/pilates/full — extract khi khách nhắc dịch vụ cụ thể.
                  ⚠️ Multi-service ONLY khi KH muốn TẬP 2+ dịch vụ ("gym và bơi cả 2", "yoga + zumba luôn", "đăng ký gym + yoga", "cả gym lẫn bơi") → trả "full" (combo).
                  ⚠️ GỌI TÊN GÓI FULL: khi KH nhắc thẳng "gói full" / "thẻ full" / "combo" / "cả gói" / "gói tổng hợp" (kể cả khi đang hỏi giá) → serviceType="full". KH đang đổi focus sang gói Full, ghi đè bộ môn lẻ đã nói trước đó.
                  ⚠️ COMPARISON ("gym với yoga cái nào tốt hơn", "gym hay yoga", "X so với Y", "X vs Y") → KHÔNG extract serviceType (để null). Đây là hỏi tư vấn, không phải chọn cả 2.
                  TUYỆT ĐỐI KHÔNG trả "gym và bơi" / "gym + bơi" / "gym, bơi" — phải là 1 trong 6 enum.
  memberType    = ca-nhan/gia-dinh/hoc-sinh — extract khi có cue:
                  "sinh viên" / "sv" / "học sinh" / "hs" / "đang học" → "hoc-sinh"
                  "vợ chồng" / "gia đình" / "cả nhà" / "2 vợ chồng" / "với vợ/chồng/con" → "gia-dinh"
                  không có cue → null (đừng đoán "ca-nhan")
  durationMonths = số tháng muốn đăng ký
  schedule      = khung giờ / số buổi mỗi tuần (VD: "sáng" → "sáng", "chiều tối" → "chiều-tối", "3 buổi/tuần" → "3-buoi-tuan")
  fitnessGoal   = giam-mo/tang-co/tang-can/thu-gian/hoc-boi/suc-khoe/giu-dang/linh-hoat
                  PHẢI extract ngay khi khách đề cập mục tiêu, dù ngầm hiểu:
                  "giảm mỡ" / "giảm cân" / "đốt mỡ" → "giam-mo"
                  "tăng cơ" / "tăng cơ bắp" / "to hơn" → "tang-co"
                  "tăng cân" / "lên cân" / "mập lên" / "gầy quá muốn tăng" / "ăn mãi không béo" / "khó tăng cân" → "tang-can"
                  "thư giãn" / "giải stress" / "cho khỏe" → "thu-gian"
                  "học bơi" / "muốn biết bơi" → "hoc-boi"
                  "giữ dáng" / "duy trì vóc dáng" / "giữ form" / "giữ cân" / "săn chắc duy trì" → "giu-dang"
                  Phân biệt: "tăng cơ" (cơ bắp, gym thuần) = tang-co; "tăng cân" (người gầy muốn lên cân) = tang-can.
                  VD: "muốn tập gym giảm mỡ" → serviceType="gym", fitnessGoal="giam-mo"
  bodyStats     = chỉ số cơ thể khách TỰ KHAI (chiều cao / cân nặng / số cân muốn giảm-tăng).
                  Ghi NGUYÊN VĂN gọn những gì khách nói, để null nếu không nhắc.
                  "cao 1m65 nặng 72 muốn giảm 8 cân" → "cao 1m65, nặng 72kg, giảm 8kg"
                  "1m75 mà có 58kg" → "cao 1m75, nặng 58kg"
                  "85kg muốn xuống 70" → "nặng 85kg, mục tiêu 70kg"
                  KHÔNG suy diễn nếu khách chưa cho số — hỏi giá/buổi tập KHÔNG phải bodyStats.
  gender        = "nam" / "nu" — SUY từ cách khách tự xưng / ngữ cảnh, KHÔNG cần khách nói thẳng:
                  tự xưng "anh"/"thằng"/"ông" hoặc nhắc "vợ em"/"bạn gái em" → "nam";
                  tự xưng "chị"/"em gái"/"con" (nữ) hoặc nhắc "chồng em"/"bạn trai em", mang thai/sau sinh/cho con bú → "nu".
                  KHÔNG chắc → để null (đừng đoán bừa). Khách xưng "mình/em" trung tính mà không có cue khác → null.`;

const SLOTS_GIAICO = `SLOTS cho giai-co:
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
  sessionPackage = le/5-buoi/10-buoi/20-buoi`;

// Slot theo flow: flow đã biết → chỉ block đó; chưa biết (needFlow) → cả hai.
function slotsFor(scope: SlotScope): string {
  const parts: string[] = [];
  if (scope !== "giai-co") parts.push(SLOTS_FITNESS);
  if (scope !== "fitness") parts.push(SLOTS_GIAICO);
  return parts.join("\n\n");
}

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
  if (knownInfo.appointmentDate) knownParts.push(`ngày_hẹn=${knownInfo.appointmentDate}`);
  if (knownInfo.bodyStats)      knownParts.push(`chỉ_số=${knownInfo.bodyStats}`);
  if (knownInfo.gender)         knownParts.push(`giới=${knownInfo.gender}`);

  const knownSummary = knownParts.join(", ") || "chưa có gì";

  const slotExtractionFields = missingSlots
    .map((s) => `"${s}": <giá trị hoặc null>`)
    .join(", ");

  const flowInstruction = needFlow
    ? `"flow": "fitness"|"giai-co",  // fitness=tập thể dục/gym/bơi/yoga/zumba | giai-co=massage/đau mỏi/giải cơ/spa.
  //   PHÂN XỬ khi đang fitness ĐÃ chốt bộ môn mà khách than đau/mỏi cơ-xương: nếu cơn đau là VẤN ĐỀ RIÊNG khách
  //   muốn xử lý (đau/mỏi/cứng mãn, kéo dài, do ngồi nhiều/sai tư thế) → "giai-co" (chuyển sang trị liệu). Nếu đau
  //   chỉ là LÝ DO/mục tiêu của việc chọn môn tập (tập để cải thiện cơn đau đó) → "fitness".
  //   STICKY ngược lại: đang "giai-co" ĐÃ biết vùng đau, câu follow-up của buổi trị liệu (có hết hẳn
  //   không, có đau không, xin xem ca giống mình, 1 buổi bao nhiêu, làm mấy buổi) → GIỮ "giai-co", DÙ
  //   câu có chữ "thể thao/tập/gym". Chỉ trả "fitness" khi khách RÕ RÀNG quay sang hỏi tập gym/yoga/
  //   hội viên cho bản thân — không phải hỏi tiếp về trị liệu.`
    : `// flow đã xác định: "${previousFlow}" — không cần classify`;

  const prevTopicLine = previousIntentTopic
    ? `IntentTopic turn TRƯỚC: "${previousIntentTopic}" — nếu KH đang follow-up cùng chủ đề, ưu tiên gán lại topic này (xem mục FOLLOW-UP CONTEXT).`
    : `IntentTopic turn TRƯỚC: null`;

  const scope: SlotScope = needFlow
    ? "both"
    : previousFlow === "giai-co"
    ? "giai-co"
    : "fitness";

  // PHẦN ĐỘNG — đặt CUỐI prompt để KHÔNG phá cache prefix (taxonomy tĩnh ở trên).
  const dataTail = `─────────────────────────────────────────────
DỮ LIỆU LƯỢT NÀY:
Tin nhắn khách: "${message}"
Đã biết: ${knownSummary}
Flow trước: "${previousFlow}", Stage trước: "${previousStage}"
${prevTopicLine}

NGÀY HIỆN TẠI (múi giờ VN):
${dateContext}

Trả JSON thuần (định nghĩa các trục: xem taxonomy Ở TRÊN):
{
  ${flowInstruction}
  "emotion": "neutral"|"excited"|"anxious"|"frustrated"|"hesitant"|"trusting",
  "intent": "explore"|"compare"|"selecting"|"ready",
  "honorific": "anh"|"chị"|null,
  "intentSignal": {
    "domain": "<1 trong 11 domain ở mục INTENT_SIGNAL trên>",
    "service": "gym"|"yoga"|"zumba"|"boi"|"pilates"|"full"|null,
    "attribute": "<attribute key trong domain — xem mục ATTRIBUTE>"
  },
  "secondaryIntents": [ /* OPTIONAL — xem MULTI-INTENT ở trên. Null hoặc [] nếu KH chỉ hỏi 1 thứ. */ ],
  "mediaMove": "none"|"show_service"|"show_results",
  ${missingSlots.length > 0 ? `"slots": {${slotExtractionFields}}` : `// slots đã đủ`}
}`;

  return `EMOTION: suy luận từ cách viết, dấu câu, từ ngữ. Mặc định "neutral" khi không có tín hiệu rõ — ĐỪNG ép gán cảm xúc.
  - excited: hào hứng, dùng "!", "quá", "luôn", muốn bắt đầu ngay ("đăng ký luôn", "tập ngay được không", "ok chốt luôn").
  - trusting: tin & xuôi theo tư vấn, "ok em", "nghe hợp lý", "vậy chốt", "em tư vấn giúp anh/chị" — đồng ý dễ, ít vặn.
  - hesitant: phân vân/chưa quyết, "để nghĩ thêm", "chưa chắc", "hơi lăn tăn", "không biết có hợp không", "tham khảo đã", "từ từ".
  - anxious: lo lắng về bản thân, "sợ tập sai", "sợ đau", "không theo kịp", "mới tập có sao không", "có nguy hiểm không", "lớn tuổi tập được không".
  - frustrated: khó chịu/bực, gắt, đòi hỏi lặp, "sao lâu thế", "nãy giờ hỏi mãi", "trả lời thẳng đi", "lại nữa à".

HONORIFIC (xưng hô KH TỰ NHẬN trong tin — để bot gọi khách đúng "anh"/"chị"):
  - KH tự xưng nam → "anh". Tín hiệu: tự gọi mình "anh" hoặc viết tắt "a" ("a muốn giảm cân", "cho a hỏi", "a đăng ký gym"), hoặc tên nam rõ ("anh Hùng").
  - KH tự xưng nữ → "chị". Tín hiệu: "chị"/"c" ("c muốn tập", "cho chị xem"), bối cảnh nữ rõ ("mới sinh muốn lấy dáng", "đang bầu").
  - KHÔNG rõ giới → null (giữ xưng hô cũ). Đừng đoán bừa.
  - ⚠ Phân biệt: "a"/"c" đứng đầu câu nói về CHÍNH khách = xưng hô. Còn "em" KH dùng để tự gọi mình thì vẫn để null (bot luôn gọi khách bằng anh/chị, không gọi "em").

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
                      Vd: "đắt quá", "đắt thế", "đắt v", "sao mắc thế", "bên kia rẻ hơn", "gym hay yoga tốt hơn", "thôi để chị xem thêm"
                      ⚠ Phản ứng NGẮN với giá ("đắt thế e", "mắc v", "cao thế", "hơi đắt") vẫn = objection/price_too_high, đừng để null.
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
    - acute_injury           CHẤN THƯƠNG CẤP THẬT SỰ: vừa bị (hôm nay/hôm qua, <72h) do 1 sự cố cụ thể
                             (trẹo/lật/bong gân/té ngã/va đập/đá bóng) KÈM dấu hiệu cấp: sưng vù, nóng đỏ,
                             không cử động/đi/nhấc nổi. VD "vừa lật cổ chân chiều nay sưng đi không nổi".
                             ⛔ KHÔNG phải acute_injury (đây là giai-co BÌNH THƯỜNG → domain=discovery_answer):
                             đau mỏi/cứng cổ vai gáy/lưng do ngồi nhiều-sai tư thế, "mấy nay", "vài tháng",
                             "cứng đơ", "mỏi", đau âm ỉ/lan/tê do căng cơ mạn — ĐÂY LÀ ĐÚNG ca giải cơ xử lý,
                             KHÔNG phải chấn thương cấp. Đau lan/tê do cơ căng mạn ≠ cấp tính.

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
    - off_topic              CHỈ khi câu HOÀN TOÀN ngoài lề, vô can dịch vụ (vd "thời tiết hôm nay", chính trị, tán gẫu).
                             ⚠️ Hỏi về cơ sở/tiện ích/gửi xe/thanh toán/chính sách (hoàn tiền, bảo lưu, đổi gói)/giờ giấc/
                             "có ... không", "có làm được không", "có ... khỏi không" VỀ DỊCH VỤ bên em → domain=service_inquiry
                             (hoặc safety_concern nếu về sức khỏe/chấn thương). TUYỆT ĐỐI KHÔNG xếp vào off_topic.

  chitchat:
    - filler_ok              "ok", "ừ", "được", "dạ"
    - thanks                 "cảm ơn", "thanks"
    - unknown                không phân loại được

  ─────────────────────────────────────────────
  ⚠️ NẾU không chắc attribute → để null. Domain bắt buộc.
  ⚠️ Chỉ pick attribute từ list TƯƠNG ỨNG domain đã chọn (vd domain=pricing thì attribute phải là ask_price_*).

  ─────────────────────────────────────────────
  MULTI-INTENT — KH hỏi NHIỀU thứ trong 1 tin nhắn:
  ─────────────────────────────────────────────
  Vd: "giá bao nhiêu? có ảnh phòng tập không?" → 2 intent (pricing + media_request).
  Vd: "đăng ký gym, mà chiều mở mấy giờ?" → 2 intent (commitment + scheduling).
  Vd: "có gói cho sinh viên không, tập sáng có đông không?" → 2 intent (pricing + service_inquiry).

  Quy tắc:
  - intentSignal = PRIMARY (intent quan trọng nhất theo priority bên dưới).
  - secondaryIntents = ARRAY các intent còn lại (tối đa 2 entry), mỗi entry cùng schema (domain/service/attribute).
  - Nếu KH chỉ hỏi 1 thứ → secondaryIntents = null hoặc [].

  Priority pick PRIMARY (cao → thấp):
    commitment > scheduling > pricing > safety_concern > media_request >
    service_inquiry > discovery_answer > objection > edge > greeting > chitchat

  TUYỆT ĐỐI KHÔNG:
  - Đặt cùng 1 (domain, attribute) ở cả primary và secondary — duplicate.
  - Đẩy chitchat / greeting filler vào secondary nếu intent chính đã rõ.
  - Vượt 2 entry secondary (chọn 2 quan trọng nhất, bỏ phần còn lại).

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
  - Tin TRƯỚC bot vừa BÁO GIÁ/GÓI → KH phản ứng ngắn tiêu cực ("đắt thế", "mắc v", "sao cao thế", "thôi đắt") → domain=objection + attribute=price_too_high (đừng để domain=null).

MEDIA_MOVE — quyết định CHỦ ĐỘNG gửi ảnh/video như một nhân viên sale khôn khéo (chọn 1):
  none         = MẶC ĐỊNH. Không gửi gì. Dùng khi: chào hỏi/filler, hỏi giá-gói-thanh toán đơn thuần,
                 đang chốt lịch/đăng ký/cho tên-SĐT, hỏi chính sách (bảo lưu/hoàn/đổi gói), hoặc tin lạc ngữ cảnh.
                 ⚠️ Câu hỏi KIẾN-THỨC/khái-niệm/cơ-chế/SO-SÁNH thuật ngữ (vd "InBody khác gì cân thường", "giải cơ là gì",
                    "yoga với pilates khác nhau sao", "tập bao lâu thì lên") là hỏi để HIỂU — trả lời bằng LỜI, KHÔNG kèm ảnh cơ sở → none.
                    (ảnh phòng/bể/máy chỉ hợp khi khách soi CƠ SỞ VẬT CHẤT thật, không phải khi khách hỏi một khái niệm.)
  show_service = khách đang TÌM HIỂU/CÂN NHẮC một bộ môn cụ thể, hoặc soi CƠ SỞ VẬT CHẤT thật của nó
                 (phòng có rộng không, máy mới hay cũ, bể có sạch không, không gian lớp thế nào)
                 → nên cho khách xem ảnh/video bộ môn đó để hình dung thực tế. Bộ môn lấy theo "service" đã chọn ở trên;
                 khách hỏi cơ sở chung chung (chưa rõ bộ môn) vẫn show_service. domain=media_request (xin xem trực tiếp) ⇒ luôn show_service.
  show_results = khách quan tâm HIỆU QUẢ/kết quả, hoặc NGHI NGỜ độ hiệu quả/độ thật/độ bền của dịch vụ
                 → cho xem ảnh kết quả (hội viên/ca trước-sau) để củng cố niềm tin.
                 ⭐ BẮT BUỘC chọn show_results (ĐỪNG để none) khi khách hỏi kiểu NGHI NGỜ KẾT QUẢ, ví dụ:
                    fitness: "liệu có lên/giảm thật không", "tập mãi chẳng thấy gì", "có hiệu quả thật không";
                    giai-co: "làm xong có đỡ/khỏi thật không", "có hết hẳn không hay lại đau", "có tái lại không".
                 ⭐ NGHI NGỜ TÁI PHÁT / DỘI LẠI (khách sợ kết quả KHÔNG BỀN) cũng là show_results, KHÔNG phải hỏi giữ-dáng:
                    "giảm xong lại lên lại như cũ", "tập rồi có xuống bền không hay lên lại", "sợ lại về như cũ",
                    "được thời gian lại béo lại". Đây là DOUBT về độ bền kết quả → bung ảnh trước-sau, ĐỪNG gán maintain_after_goal.
                 Đây là lúc VÀNG để bung ảnh trước-sau tạo niềm tin.
  NGUYÊN TẮC: chỉ chọn show_* khi ĐÚNG LÚC giúp khách quyết — như sale đọc vị, KHÔNG gửi cho có, KHÔNG gửi khi đang
  thăm dò sơ khởi hay đang nói chuyện khác. Không chắc thì để none. Đây chỉ là Ý ĐỊNH gửi — hệ thống tự lo việc gửi
  thật, đúng bộ môn và chống trùng, nên cứ chọn theo nhịp hội thoại, KHÔNG cần bận tâm đã gửi hay chưa.

${slotsFor(scope)}

SLOTS chung (áp dụng cả fitness và giai-co):
  name  = tên khách (tên đơn như "trung", "Lan" hoặc họ tên đầy đủ đều được — chấp nhận bất kỳ dạng tên nào).
          ⚠️ CHỈ lấy phần TÊN, BỎ động từ/xưng hô dẫn vào: "tên anh là Trung"→"Trung", "mình tên Lan"→"Lan", "em là Hùng"→"Hùng". KHÔNG bao giờ gồm "là"/"tên"/"anh"/"chị".
  phone = số điện thoại
  preferredTime = thời gian khách muốn đến — RESOLVE dựa bảng "NGÀY HIỆN TẠI" ở phần DỮ LIỆU bên dưới (đã có sẵn thứ→DD/MM 14 ngày tới). Viết CÓ DẤU, KHÔNG slugify ("cuối tuần" không phải "cuoi tuan").
    - NGÀY/GIỜ RÕ (có thứ/ngày/giờ cụ thể, kể cả "mai"/"ngày kia"/"thứ 4 tuần sau") → "[giờ] [buổi] [thứ] DD/MM", gom đủ phần khách cho, bỏ phần không có. Buổi suy từ giờ: <12=sáng, 12–17=chiều, ≥18=tối. Chỉ có giờ → suy ngày gần nhất hợp lý.
    - CỬA SỔ nhiều ngày ("đầu/giữa/cuối tuần|tháng", "tuần/tháng sau", "vài/mấy hôm nữa", "hôm nào") → GIỮ NGUYÊN cụm, KHÔNG tự ép 1 ngày (bot đề xuất 2 ngày sau). Kèm buổi nếu khách cho ("sáng đầu tuần sau").
    - MƠ HỒ (cue "tầm/khoảng/chắc/cỡ" hoặc chỉ nói buổi trơ) → CHỈ ghi buổi, KHÔNG gán ngày. "chưa biết"/"lúc nào rảnh" → null.
    - REFINE (đã có value cũ, tin mới BỔ SUNG cùng hướng) → GỘP cũ+mới thành cụ thể hơn. Tin mới KHÔNG nói gì về giờ → giữ NGUYÊN value cũ.
    - ĐỔI Ý (cue "thôi/đổi/chuyển/dời/không/ko" + có từ thời gian) → THAY HẲN value cũ, KHÔNG gộp; PHẢI extract value mới (không null). Cue phải rõ — chỉ "à" thì giữ cũ.
    - KHÔNG suy đoán vượt info khách cho — thà generic còn hơn sai.
  appointmentDate = NGÀY hẹn TUYỆT ĐỐI đã resolve, format CỐ ĐỊNH "DD/MM/YYYY" (vd "18/06/2026"). Tách RIÊNG khỏi preferredTime.
    - Tin có nhắc NGÀY/THỨ (kể cả tương đối "mai", "ngày kia", "thứ 4", "thứ 5 tuần sau") → RESOLVE ra "DD/MM/YYYY" dựa bảng "NGÀY HIỆN TẠI". Năm theo VN hiện tại.
    - Tin CHỈ đổi GIỜ/BUỔI mà KHÔNG nhắc ngày ("2h chiều", "10h", "sáng nhé") → null. (state đã giữ ngày_hẹn cũ — đừng lặp lại, đừng bịa ngày mới.)
    - CỬA SỔ mơ hồ nhiều ngày ("cuối tuần", "tuần sau", "hôm nào") hoặc chưa có ngày → null. KHÔNG tự ép 1 ngày.
    - Khác preferredTime: preferredTime giữ cụm chữ khách nói; appointmentDate CHỈ là ngày máy đọc được để chốt lịch.

${dataTail}

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

// sanitizeName đã chuyển xuống stateMachine.ts (layer thấp hơn) để dùng chung cho cả inline/standalone
// extractor trong buildNextState (path đó trước KHÔNG sanitize → "Là Trung" leak). Re-export giữ API cũ.
export { sanitizeName };

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

  const honorific: "anh" | "chị" | null =
    parsed.honorific === "anh" || parsed.honorific === "chị"
      ? parsed.honorific
      : null;

  // Parse intentSignal (3-axis output) + validate. Domain bắt buộc; service/attribute optional.
  const parseSignal = (raw: any): IntentSignal | null => {
    if (!raw || !isValidDomain(raw.domain)) return null;
    const rawService = raw.service ?? null;
    const service: Service = isValidService(rawService) ? (rawService as Service) : null;
    const attribute = typeof raw.attribute === "string"
      ? (raw.attribute as Attribute)
      : null;
    return { domain: raw.domain as Domain, service, attribute };
  };

  const intentSignal: IntentSignal | null = parseSignal(parsed.intentSignal);

  // Nước đi media (đã .catch("none") ở schema, validate lại cho chắc — mặc định an toàn = none).
  const mediaMove: MediaMove =
    parsed.mediaMove === "show_service" || parsed.mediaMove === "show_results"
      ? parsed.mediaMove
      : "none";

  // Parse secondaryIntents (multi-intent). Dedupe duplicate với primary.
  // Cap 2 entry để tránh prompt overflow downstream.
  let secondaryIntents: IntentSignal[] = [];
  if (Array.isArray(parsed.secondaryIntents)) {
    const primaryKey = intentSignal
      ? `${intentSignal.domain}|${intentSignal.attribute ?? ""}`
      : "";
    const seen = new Set<string>([primaryKey]);
    for (const raw of parsed.secondaryIntents) {
      const sig = parseSignal(raw);
      if (!sig) continue;
      const key = `${sig.domain}|${sig.attribute ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      secondaryIntents.push(sig);
      if (secondaryIntents.length >= 2) break;
    }
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

  // Lưới TẤT ĐỊNH: strip động từ/xưng hô dẫn vào tên ("tên anh là Trung" → name="Là Trung"
  // do LLM nuốt cả "là"). Tránh bot gọi "anh Là Trung". Chạy bất kể LLM có sạch hay không.
  if (typeof extractedSlots.name === "string") {
    const cleaned = sanitizeName(extractedSlots.name);
    if (cleaned !== extractedSlots.name) {
      console.warn(`[classifier] sửa tên: "${extractedSlots.name}" → "${cleaned}"`);
    }
    extractedSlots.name = cleaned as any;
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

  // Canonical hóa gender về "nam"/"nu" (string ops thuần, KHÔNG regex) — phòng model trả
  // "nữ"/"Nam"/"female". Không khớp vocab → bỏ (null) thay vì giữ rác.
  if (typeof extractedSlots.gender === "string") {
    const g = extractedSlots.gender.toLowerCase().trim();
    const isFemale =
      g.includes("nu") || g.includes("nữ") || g.includes("female") || g.includes("gái");
    const isMale =
      g.includes("nam") || g.includes("male") || g.includes("trai");
    extractedSlots.gender = (isFemale ? "nu" : isMale ? "nam" : null) as any;
  }

  return {
    flow,
    llmStage: "discovery",
    emotion,
    intent,
    honorific,
    intentTopic,
    intentSignal,
    secondaryIntents,
    mediaMove,
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
    honorific: null,
    intentTopic: null,
    intentSignal: null,
    secondaryIntents: [],
    mediaMove: "none",
    extractedSlots: {},
    qrShown: null,
    mediaShown: null,
  };
}
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
  KnownInfo,
  LLMClassification,
  nullSlots,
} from "./stateMachine";
import { buildDateContext, verifyWeekdayInTime } from "./dateHelper";
import { openai } from "../config/openai";

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
    needFlowClassification
  );

  try {
    const result = await classifierAgent.generate(prompt, {
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
  needFlow: boolean
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

  return `Tin nhắn khách: "${message}"
Đã biết: ${knownSummary}
Flow trước: "${previousFlow}", Stage trước: "${previousStage}"

NGÀY HIỆN TẠI (múi giờ VN):
${dateContext}

Trả JSON thuần:
{
  ${flowInstruction}
  "emotion": "neutral"|"excited"|"anxious"|"frustrated"|"hesitant"|"trusting",
  "intent": "explore"|"compare"|"selecting"|"ready",
  ${missingSlots.length > 0 ? `"slots": {${slotExtractionFields}}` : `// slots đã đủ`}
}

EMOTION: suy luận từ cách viết, dấu câu, từ ngữ.

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

    E) ĐỔI Ý — khi khách CHỦ ĐỘNG đổi sang giờ khác (cue: "thôi", "đổi", "chuyển", "không", "ko"):
      THAY THẾ HOÀN TOÀN value cũ bằng tin mới. KHÔNG gộp với cũ.
      Ví dụ:
        Cũ="9h sáng thứ 7 02/05",   tin mới="thôi sáng mai luôn nha"   → "sáng DD/MM" (ngày mai)
        Cũ="chiều thứ 6 26/04",     tin mới="đổi sang tối được không"  → "tối DD/MM" (giữ ngày cũ)
        Cũ="thứ 7",                 tin mới="ko thứ 7, chuyển cn"      → "chủ nhật DD/MM"
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
    extractedSlots: {},
    qrShown: null,
    mediaShown: null,
  };
}
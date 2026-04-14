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
import { createOpenAI } from "@ai-sdk/openai";
import {
  Flow,
  Stage,
  Emotion,
  Intent,
  KnownInfo,
  LLMClassification,
  nullSlots,
} from "./stateMachine";
import "dotenv/config";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const classifierAgent = new Agent({
  name: "classifier",
  id: "val-classifier",
  model: openai("gpt-4o-mini"),
  instructions: `Bạn phân tích tin nhắn khách hàng. Chỉ trả JSON thuần, không markdown, không giải thích.`,
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
  const prompt = buildPrompt(
    message,
    previousFlow,
    previousStage,
    currentKnownInfo,
    missingSlots,
    needFlowClassification
  );

  try {
    const result = await classifierAgent.generate(prompt);
    const raw = result.text
      .trim()
      .replace(/```json|```/g, "")
      .trim();
    const parsed = JSON.parse(raw);
    return mapToClassification(parsed, needFlowClassification, missingSlots);
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
  if (knownInfo.name)           knownParts.push(`tên=${knownInfo.name}`);
  if (knownInfo.phone)          knownParts.push(`sđt=${knownInfo.phone}`);
  if (knownInfo.serviceType)    knownParts.push(`dịch_vụ=${knownInfo.serviceType}`);
  if (knownInfo.fitnessGoal)    knownParts.push(`mục_tiêu=${knownInfo.fitnessGoal}`);
  if (knownInfo.memberType)     knownParts.push(`loại_thành_viên=${knownInfo.memberType}`);
  if (knownInfo.durationMonths) knownParts.push(`thời_hạn=${knownInfo.durationMonths}tháng`);
  if (knownInfo.schedule)       knownParts.push(`lịch=${knownInfo.schedule}`);
  if (knownInfo.fitnessGoal)    knownParts.push(`mục_tiêu=${knownInfo.fitnessGoal}`);
  if (knownInfo.painArea)       knownParts.push(`vùng_đau=${knownInfo.painArea}`);
  if (knownInfo.painDuration)   knownParts.push(`đau_bao_lâu=${knownInfo.painDuration}`);
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

Trả JSON thuần:
{
  ${flowInstruction}
  "emotion": "neutral"|"excited"|"anxious"|"frustrated"|"hesitant"|"trusting",
  "intent": "explore"|"compare"|"selecting"|"ready",
  ${missingSlots.length > 0 ? `"slots": {${slotExtractionFields}}` : `// slots đã đủ`}
}

EMOTION: suy luận từ cách viết, dấu câu, từ ngữ.

INTENT:
  explore   = hỏi chung chung, chưa có định hướng rõ ("cho hỏi", "bên mình có gì")
  compare   = so sánh gói/giá/dịch vụ ("giá bao nhiêu", "có gói nào")
  selecting = đang chọn cụ thể ("muốn đăng ký bơi", "cho chị gói 6 tháng")
  ready     = muốn đăng ký / xác nhận luôn ("ok đăng ký luôn", "chị lấy gói đó")

SLOTS cho fitness:
  serviceType   = gym/yoga/zumba/boi/pilates/full — extract khi khách nhắc dịch vụ cụ thể
  memberType    = ca-nhan/gia-dinh/hoc-sinh
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
  painDuration  = đau bao lâu (VD: "1 tuần", "vài tháng")
  sessionPackage = le/5-buoi/10-buoi/20-buoi
  preferredTime = giờ muốn đặt lịch

SLOTS chung:
  name  = họ tên đầy đủ
  phone = số điện thoại

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
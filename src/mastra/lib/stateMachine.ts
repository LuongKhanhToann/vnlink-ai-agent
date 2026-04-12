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

import { z } from "zod";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type Flow = "fitness" | "giai-co";

export type Stage =
  | "opening"
  | "discovery"
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

  // Giải cơ
  painArea: string | null;        // vùng đau: vai-gáy, lưng, chân, toàn thân
  painDuration: string | null;    // đau bao lâu
  sessionPackage: string | null;  // le / 5-buoi / 10-buoi / 20-buoi
  preferredTime: string | null;   // giờ muốn đặt lịch
}

export interface ConversationState {
  flow: Flow;
  stage: Stage;
  temperature: Temperature;
  emotion: Emotion;
  intent: Intent;
  honorific: "anh" | "chị" | "anh/chị";
  knownInfo: KnownInfo;
  turnCount: number;
  qrShown: boolean;         // đã gửi QR thanh toán chưa
  mediaShown: boolean;      // đã gửi ảnh/video giới thiệu chưa
}

// ─────────────────────────────────────────────
// SLOT MERGE — Store-first
// ─────────────────────────────────────────────

export function mergeSlots(
  existing: KnownInfo,
  extracted: Partial<KnownInfo>
): KnownInfo {
  return {
    name:           existing.name           ?? extracted.name           ?? null,
    phone:          existing.phone          ?? extracted.phone          ?? null,
    serviceType:    existing.serviceType    ?? extracted.serviceType    ?? null,
    memberType:     existing.memberType     ?? extracted.memberType     ?? null,
    durationMonths: existing.durationMonths ?? extracted.durationMonths ?? null,
    schedule:       existing.schedule       ?? extracted.schedule       ?? null,
    painArea:       existing.painArea       ?? extracted.painArea       ?? null,
    painDuration:   existing.painDuration   ?? extracted.painDuration   ?? null,
    sessionPackage: existing.sessionPackage ?? extracted.sessionPackage ?? null,
    preferredTime:  existing.preferredTime  ?? extracted.preferredTime  ?? null,
  };
}

export function nullSlots(info: KnownInfo): (keyof KnownInfo)[] {
  return (Object.keys(info) as (keyof KnownInfo)[]).filter(
    (k) => info[k] === null
  );
}

// ─────────────────────────────────────────────
// FLOW DETECTION — Keyword pre-check
// ─────────────────────────────────────────────

const FITNESS_KEYWORDS =
  /\b(gym|yoga|zumba|bơi|pilates|thể dục|tập luyện|thể hình|thẻ tập|hội viên|fitness|aerobic|inbody|hlv|huấn luyện viên|pool|bể bơi|thể thao)\b/i;

const GIAI_CO_KEYWORDS =
  /\b(giải cơ|massage|xoa bóp|đau lưng|đau vai|đau cổ|đau gáy|vật lý trị liệu|trigger|fascia|cứng cơ|đau mỏi|nhức mỏi|spa|xông hơi|ngâm bồn|regenix|hoa sen)\b/i;

export function detectFlowByKeyword(
  message: string,
  previousFlow: Flow | null
): Flow | null {
  const isGiaiCo = GIAI_CO_KEYWORDS.test(message);
  const isFitness = FITNESS_KEYWORDS.test(message);

  if (isGiaiCo && !isFitness) return "giai-co";
  if (isFitness && !isGiaiCo) return "fitness";
  return null; // ambiguous → LLM decides
}

// ─────────────────────────────────────────────
// HONORIFIC DETECTION
// ─────────────────────────────────────────────

export function detectHonorific(
  message: string,
  previous: "anh" | "chị" | "anh/chị"
): "anh" | "chị" | "anh/chị" {
  const msg = message.toLowerCase();
  if (/\b(chị|chj)\b/.test(msg)) return "chị";
  if (/\b(anh|a)\b/.test(msg) && !/anh\/chị/.test(msg)) return "anh";
  return previous;
}

export function resolveHonorific(h: "anh" | "chị" | "anh/chị"): string {
  return h === "anh/chị" ? "anh/chị" : h;
}

// ─────────────────────────────────────────────
// STAGE TRANSITION — Hard-coded FSM
// ─────────────────────────────────────────────

export function computeNextStage(
  currentStage: Stage,
  info: KnownInfo,
  intent: Intent,
  flow: Flow,
  llmSuggestedStage: Stage
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

  // Opening → Discovery
  if (currentStage === "opening") {
    if (
      info.serviceType !== null ||
      info.painArea !== null ||
      intent !== "explore"
    ) {
      return "discovery";
    }
    return "opening";
  }

  // Discovery → Evaluation
  if (currentStage === "discovery") {
    const hasEnoughFitness =
      flow === "fitness" && (info.serviceType !== null || info.memberType !== null);
    const hasEnoughGiaiCo =
      flow === "giai-co" && (info.painArea !== null || info.painDuration !== null);

    if (hasEnoughFitness || hasEnoughGiaiCo) {
      if (intent === "compare" || intent === "selecting" || intent === "ready") {
        return "evaluation";
      }
      if (info.serviceType !== null || info.painArea !== null) return "evaluation";
    }
    return "discovery";
  }

  // Evaluation → Negotiation / Commitment
  if (currentStage === "evaluation") {
    if (intent === "ready") return "commitment";
    if (intent === "selecting") return "negotiation";
    return "evaluation";
  }

  // Negotiation → Commitment
  if (currentStage === "negotiation") {
    if (intent === "ready" || intent === "selecting") return "commitment";
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
  const flow = keywordFlow ?? llm.flow ?? previous.flow;

  const baseStage: Stage =
    flow !== previous.flow ? "opening" : previous.stage;

  const knownInfo = mergeSlots(previous.knownInfo, llm.extractedSlots);
  const intent = llm.intent;

  const stage = computeNextStage(
    baseStage,
    knownInfo,
    intent,
    flow,
    llm.llmStage
  );

  const temperature = computeTemperature(knownInfo, intent, stage);
  const emotion = llm.emotion;

  const qrShown = llm.qrShown ?? previous.qrShown;
  const mediaShown = llm.mediaShown ?? previous.mediaShown;

  return {
    flow,
    stage,
    temperature,
    emotion,
    intent,
    honorific,
    knownInfo,
    turnCount: previous.turnCount + 1,
    qrShown,
    mediaShown,
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
  honorific: "anh/chị",
  knownInfo: {
    name: null,
    phone: null,
    serviceType: null,
    memberType: null,
    durationMonths: null,
    schedule: null,
    painArea: null,
    painDuration: null,
    sessionPackage: null,
    preferredTime: null,
  },
  turnCount: 0,
  qrShown: false,
  mediaShown: false,
};
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
  honorific: "anh" | "chị" | "anh/chị";
  knownInfo: KnownInfo;
  turnCount: number;
  qrShown: boolean;
  mediaShown: boolean;
  sheetsWritten: boolean;
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

  return {
    name:           pick(existing.name,           extracted.name),
    phone:          pick(existing.phone,          extracted.phone),
    serviceType:    pick(existing.serviceType,    extracted.serviceType),
    memberType:     pick(existing.memberType,     extracted.memberType),
    durationMonths: pick(existing.durationMonths, extracted.durationMonths),
    schedule:       pick(existing.schedule,       extracted.schedule),
    fitnessGoal:    pick(existing.fitnessGoal,    extracted.fitnessGoal),
    painArea:       pick(existing.painArea,       extracted.painArea),
    painSpread:     pick(existing.painSpread,     extracted.painSpread),
    painDuration:   pick(existing.painDuration,   extracted.painDuration),
    pastMethod:     pick(existing.pastMethod,     extracted.pastMethod),
    sessionPackage: pick(existing.sessionPackage, extracted.sessionPackage),
    preferredTime:  pick(existing.preferredTime,  extracted.preferredTime),
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
  if (/\b(chị|chj)\b/.test(msg)) return "chị";
  if (/\b(anh|a)\b/.test(msg) && !/anh\/chị/.test(msg)) return "anh";
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

  // Opening → Discovery
  if (currentStage === "opening") {
    if (
      info.serviceType !== null ||
      info.painArea !== null ||
      info.fitnessGoal !== null ||
      intent !== "explore"
    ) {
      return "discovery";
    }
    return "opening";
  }

  // Discovery → Evaluation
  if (currentStage === "discovery") {
    const fitnessReady = flow === "fitness" && fitnessReadyForEvaluation(info, intent);
    const giaiCoReady  = flow === "giai-co" && giaiCoReadyForEvaluation(info, intent);

    if (fitnessReady || giaiCoReady) {
      // GUARD — tin đầu tiên (turnCount <= 1): luôn giữ ở discovery
      // trừ khi khách đã chủ động chọn gói / sẵn sàng đăng ký (selecting/ready).
      // Ngăn trường hợp LLM classifier phân loại "tăng cơ giảm mỡ" = "compare"
      // rồi nhảy thẳng vào evaluation khi chưa hỏi schedule / số buổi.
      if (turnCount <= 1 && intent !== "selecting" && intent !== "ready") {
        return "discovery";
      }
      // Fitness: mandatory Inbody funnel trước khi show gói
      // Chỉ skip nếu khách đã chọn cụ thể (selecting/ready) — họ biết muốn gì rồi
      if (flow === "fitness" && intent !== "selecting" && intent !== "ready") {
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
    // Giải cơ: khách báo giờ = đồng ý thử 1 buổi → commitment LUÔN (kể cả khi intent=selecting)
    // "sáng nha", "chiều được", "9h" đều là tín hiệu book lịch, không phải chọn gói
    if (flow === "giai-co" && info.preferredTime !== null) {
      console.log(`[stateMachine] giai-co evaluation → commitment (preferredTime=${info.preferredTime})`);
      return "commitment";
    }

    if (intent === "ready") return "commitment";

    // Fitness: chỉ vào negotiation khi khách chủ động chọn gói cụ thể
    if (intent === "selecting") return "negotiation";

    // Fitness: đã có tên/SĐT → commitment
    if (flow === "fitness" && info.name !== null && info.phone !== null) {
      console.log(`[stateMachine] fitness evaluation → commitment (name/phone filled)`);
      return "commitment";
    }

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
    llm.llmStage,
    previous.turnCount   // truyền turnCount để guard "tin đầu tiên"
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
    honorific,
    knownInfo,
    turnCount: previous.turnCount + 1,
    qrShown,
    mediaShown,
    sheetsWritten: previous.sheetsWritten,
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
    fitnessGoal: null,
    painArea: null,
    painSpread: null,
    painDuration: null,
    pastMethod: null,
    sessionPackage: null,
    preferredTime: null,
  },
  turnCount: 0,
  qrShown: false,
  mediaShown: false,
  sheetsWritten: false,
};
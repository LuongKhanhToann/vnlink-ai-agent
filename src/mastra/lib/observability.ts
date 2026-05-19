/**
 * lib/observability.ts — Per-turn structured logging (Phase 7 refactor).
 *
 * Mỗi turn emit 1 JSON line với decision metadata. Dùng cho:
 *   - Debug: dò turn nào drift / fallback / classifier sai
 *   - Analytics: topic miss rate, fallback rate, prefix mode distribution
 *
 * Format: console.log("[turn]", JSON) — log aggregator (CloudWatch / Datadog) parse được.
 * Production: route stdout vào log collector. Local dev: grep '[turn]' để xem.
 */

import type {
  ConversationState,
  IntentTopic,
  Emotion,
  Intent,
  Stage,
  Flow,
} from "./stateMachine";
import type { Domain, Service, Attribute } from "./intent";

export type PrefixMode = "SCRIPT" | "GATE" | "PITCH";

export interface TurnDecision {
  /** Thread + turn identifier. */
  threadId: string;
  turn: number;
  timestamp: string;
  /** Inputs. */
  message: string;
  /** Stage + flow trước/sau classify. */
  flow: Flow;
  stage: Stage;
  /** Classifier output. */
  classifier: {
    domain: Domain | null;
    service: Service;
    attribute: Attribute | null;
    legacyTopic: IntentTopic | null;
    emotion: Emotion;
    intent: Intent;
    /** Số secondary intents (multi-intent detection). 0 = single-intent. */
    secondaryCount?: number;
  };
  /** Prefix mode + template id (nếu SCRIPT). */
  mode: PrefixMode;
  templateId: string | null;
  prefixChars: number;
  /** Output. */
  replyChars: number;
  hasMedia: boolean;
  hasQR: boolean;
  /** Validator result — null nếu skip validation, "valid" nếu pass, danh sách reason nếu fail. */
  validator: "valid" | "off-topic-fallback" | string[];
  /** Tracking sets size (snapshot sau turn). */
  trackingCounts: {
    askedHistory: number;
    mentionedFacts: number;
  };
  /** Duration ms từ khi nhận message đến khi gửi reply. */
  durationMs?: number;
}

/**
 * Log một turn decision. Default emit ra stdout — production có thể override để
 * gửi tới log aggregator (CloudWatch / Datadog / Loki).
 */
export function logTurn(decision: TurnDecision): void {
  // Compact JSON (1 line) cho log aggregator parse. Loại bỏ undefined.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decision)) {
    if (v !== undefined) cleaned[k] = v;
  }
  console.log("[turn]", JSON.stringify(cleaned));
}

// ─────────────────────────────────────────────
// AGGREGATE METRICS (Phase 7.future) — đọc threads + tính:
//   - classifier accuracy (% legacyTopic NULL = mini miss)
//   - fallback rate (% off-topic-fallback / safe-fallback)
//   - mode distribution (SCRIPT / GATE / PITCH)
//   - average prefix tokens
// Hiện chỉ có shape. Implementation defer đến khi cần tích lũy 1 tuần production data.
// ─────────────────────────────────────────────

export interface AggregateMetrics {
  totalTurns: number;
  modeDistribution: Record<PrefixMode, number>;
  /** % turn classifier không pick được legacyTopic (null) — proxy cho topic miss rate. */
  topicMissRate: number;
  /** % turn validator fail → fallback. */
  fallbackRate: number;
  /** Avg prefix chars. */
  avgPrefixChars: number;
  /** Avg reply chars. */
  avgReplyChars: number;
}

export function computeAggregate(decisions: TurnDecision[]): AggregateMetrics {
  if (decisions.length === 0) {
    return {
      totalTurns: 0,
      modeDistribution: { SCRIPT: 0, GATE: 0, PITCH: 0 },
      topicMissRate: 0,
      fallbackRate: 0,
      avgPrefixChars: 0,
      avgReplyChars: 0,
    };
  }
  const modeDistribution: Record<PrefixMode, number> = { SCRIPT: 0, GATE: 0, PITCH: 0 };
  let topicMiss = 0;
  let fallbackCount = 0;
  let sumPrefix = 0;
  let sumReply = 0;
  for (const d of decisions) {
    modeDistribution[d.mode] = (modeDistribution[d.mode] ?? 0) + 1;
    if (d.classifier.legacyTopic === null) topicMiss++;
    if (
      d.validator === "off-topic-fallback" ||
      (Array.isArray(d.validator) && d.validator.length > 0)
    ) {
      fallbackCount++;
    }
    sumPrefix += d.prefixChars;
    sumReply += d.replyChars;
  }
  return {
    totalTurns: decisions.length,
    modeDistribution,
    topicMissRate: topicMiss / decisions.length,
    fallbackRate: fallbackCount / decisions.length,
    avgPrefixChars: sumPrefix / decisions.length,
    avgReplyChars: sumReply / decisions.length,
  };
}

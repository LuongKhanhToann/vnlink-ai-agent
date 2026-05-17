/**
 * templates/engine.ts — Stage-aware Template Engine (Phase 2 refactor)
 *
 * THIẾT KẾ: thay vì lookup template theo flat `intentTopic` (như questionFlow.TEMPLATES cũ),
 * mỗi template self-contained với:
 *   - match: { stages, flow, domain, service, attribute, topic } — declarative
 *   - guards: optional cross-turn check (vd "đã hỏi tuổi chưa" qua state.lastUserMessage)
 *   - render: trả về template content
 *
 * Lookup chạy theo thứ tự: filter match → run guards → render first match.
 *
 * MỤC ĐÍCH: bỏ pattern `if (state.X) return null` rải khắp templates ở round trước —
 * thay bằng declarative `stages: ["discovery"]` v.v. để mini-clarity và code dễ maintain.
 *
 * BACKWARD COMPAT: template có thể match qua `topic` (legacy IntentTopic) HOẶC qua
 * { domain, service, attribute } (new IntentSignal). Migration giai-cấp được.
 */

import type { ConversationState, IntentTopic, Stage, Flow } from "../stateMachine";
import type { Domain, Service, Attribute } from "../intent";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface TemplateContext {
  state: ConversationState;
  /** Tin nhắn user của TURN HIỆN TẠI. */
  message: string;
  /** Reply bot turn TRƯỚC (state.lastBotReply). */
  prevReply: string;
  /** Tin user TURN TRƯỚC (state.lastUserMessage). */
  prevUserMessage: string;
  /** Xưng hô đã resolve (vd "anh"/"chị"/"anh/chị"). */
  h: string;
}

export interface TemplateMatch {
  /** Chỉ fire ở các stage này. Omit = mọi stage. */
  stages?: Stage[];
  /** Chỉ fire ở flow này. Omit = mọi flow. */
  flow?: Flow;
  /** Match intentSignal.domain. Có thể list. */
  domain?: Domain | Domain[];
  /** Match intentSignal.service. Có thể list hoặc null (explicit "không service"). */
  service?: Service | Service[];
  /** Match intentSignal.attribute. Có thể list. */
  attribute?: Attribute | Attribute[];
  /** Backward compat: match qua legacy IntentTopic. Có thể list. */
  topic?: IntentTopic | IntentTopic[];
}

export interface TemplateGuardSkip {
  skip: true;
  reason?: string;
}

export interface TemplateGuardPass {
  skip?: false;
}

export type TemplateGuardResult = TemplateGuardSkip | TemplateGuardPass | boolean;

export interface RenderedTemplate {
  /** Tên decision (debug log). */
  id: string;
  /** Template reply CHÍNH XÁC. Đã interpolate honorific. */
  template: string;
  /** Cụm bắt buộc xuất hiện trong reply (test check). */
  mustInclude?: string[];
  /** Cụm KHÔNG được xuất hiện. */
  mustNotInclude?: string[];
}

export interface Template {
  /** ID unique của template (dùng cho debug log + test). */
  id: string;
  /** Declarative match conditions. */
  match: TemplateMatch;
  /** Optional cross-turn guard. Return `{skip: true}` hoặc `false` → skip template. */
  guards?: (ctx: TemplateContext) => TemplateGuardResult;
  /** Render template content. */
  render: (ctx: TemplateContext) => RenderedTemplate;
}

// ─────────────────────────────────────────────
// LOOKUP
// ─────────────────────────────────────────────

function toArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function matchValue<T>(value: T, expected: T | T[] | undefined): boolean {
  if (expected === undefined) return true;
  const arr = toArray(expected) as T[];
  return arr.includes(value);
}

/**
 * Check template `match` against state + signal.
 * Trả về true nếu mọi điều kiện match pass.
 */
function checkMatch(t: Template, ctx: TemplateContext): boolean {
  const { state } = ctx;
  const m = t.match;

  // Stage filter
  if (m.stages && !m.stages.includes(state.stage)) return false;

  // Flow filter
  if (m.flow && state.flow !== m.flow) return false;

  // Topic legacy match
  if (m.topic) {
    const topics = toArray(m.topic) as IntentTopic[];
    if (!state.intentTopic || !topics.includes(state.intentTopic)) {
      // Nếu chỉ định topic match, KHÔNG match qua domain/service nữa
      return false;
    }
    // Topic match → bypass signal check (legacy path)
    return true;
  }

  // IntentSignal match (new path)
  const signal = state.intentSignal;
  if (m.domain) {
    if (!signal) return false;
    if (!matchValue(signal.domain, m.domain)) return false;
  }
  if (m.service !== undefined) {
    if (!signal) return false;
    if (!matchValue(signal.service, m.service)) return false;
  }
  if (m.attribute) {
    if (!signal || !signal.attribute) return false;
    if (!matchValue(signal.attribute, m.attribute)) return false;
  }

  // Nếu KHÔNG có match điều kiện nào (no stages/flow/topic/domain/service/attribute) →
  // template fire bất kể. Đây là wild-card pattern → cẩn thận khi dùng.
  return true;
}

/**
 * Lookup template đầu tiên match `ctx`. Run guards sau khi match.
 * Trả `null` nếu không template nào pass.
 */
export function findTemplate(
  templates: Template[],
  ctx: TemplateContext,
): RenderedTemplate | null {
  for (const t of templates) {
    if (!checkMatch(t, ctx)) continue;
    if (t.guards) {
      const res = t.guards(ctx);
      let skip = false;
      let reason: string | undefined;
      if (res === false) {
        skip = true;
      } else if (typeof res === "object" && res !== null && (res as TemplateGuardSkip).skip === true) {
        skip = true;
        reason = (res as TemplateGuardSkip).reason;
      }
      if (skip) {
        if (reason) console.log(`[template] skip ${t.id}: ${reason}`);
        continue;
      }
    }
    const rendered = t.render(ctx);

    // Auto anti-loop: nếu output rất giống prev reply (jaccard ≥ 0.85) → skip.
    if (ctx.prevReply && isHighSimilarity(rendered.template, ctx.prevReply)) {
      console.log(`[template] skip ${t.id}: hard-loop with prev reply`);
      continue;
    }

    return rendered;
  }
  return null;
}

// ─────────────────────────────────────────────
// ANTI-LOOP HELPER
// ─────────────────────────────────────────────

const STOPWORDS = new Set([
  "dạ","ạ","vâng","nha","nhé","ơi","à","ừ",
  "anh","chị","em","mình","tôi","bạn",
  "là","có","và","với","để","cho","của","đến","đi","ở","ra","vào",
  "thì","mà","nhưng","còn","hay","hoặc","cũng","đã","đang","sẽ",
  "này","đó","đây","kia","ấy","nào","gì",
  "không","chưa","rồi","được","cứ","luôn","ngay",
]);

function tokenize(s: string): Set<string> {
  const tokens = s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  return new Set(tokens);
}

function isHighSimilarity(a: string, b: string): boolean {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size < 4 || B.size < 4) return false; // câu quá ngắn → không check
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  const sim = union === 0 ? 0 : inter / union;
  return sim >= 0.85;
}

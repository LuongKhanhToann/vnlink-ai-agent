/**
 * lib/tracking.ts — Cross-turn tracking (Phase 6 refactor).
 *
 * Detect câu hỏi đã hỏi + fact đã pitch trong bot reply → persist trong state.
 * Templates/prefix dùng để không lặp.
 *
 * KEYS:
 *   askedHistory[]:
 *     "exp_gym" / "exp_yoga" / "exp_zumba" / "exp_pilates"  — đã hỏi kinh nghiệm bộ môn
 *     "goal"                                                 — đã hỏi mục tiêu
 *     "schedule"                                             — đã hỏi sáng/chiều/tối
 *     "method_history"                                       — đã hỏi biện pháp giảm cân đã thử
 *     "child_age"                                            — đã hỏi tuổi bé
 *     "newbie_status"                                        — đã hỏi "đã tập chưa"
 *     "contact"                                              — đã xin tên/SĐT
 *     "preferred_time"                                       — đã hỏi giờ muốn
 *     "pain_area" / "pain_spread" / "pain_method"            — giải cơ
 *
 *   mentionedFacts[]:
 *     "inbody_free"     — đã pitch InBody miễn phí
 *     "full_4_dichvu"   — đã list 4 dịch vụ Gym/Yoga/Zumba/Bơi
 *     "full_7tr"        — đã pitch giá Full 7tr/12 tháng
 *     "pt_6tr"          — đã pitch PT 20 buổi 6tr
 *     "be_4_mua"        — đã nhắc bể 4 mùa duy nhất Vĩnh Yên
 *     "gv_an_do"        — đã nhắc GV Ấn Độ
 *     "gym_700m2"       — đã nhắc gym 700m2
 *     "hoc_boi_1_1"     — đã pitch học bơi 1-1
 *     "commit_warranty" — đã pitch cam kết biết bơi
 */

import type { ConversationState } from "./stateMachine";

// ─────────────────────────────────────────────
// QUESTION DETECTORS — scan bot reply để biết bot đã hỏi câu nào
// ─────────────────────────────────────────────

const QUESTION_KEY_PATTERNS: Array<[string, RegExp]> = [
  ["exp_gym", /đã\s*tập\s*gym\s*(bao\s*giờ\s*)?chưa/i],
  ["exp_yoga", /đã\s*tập\s*yoga\s*(bao\s*giờ\s*)?chưa/i],
  ["exp_zumba", /đã\s*tập\s*zumba\s*(bao\s*giờ\s*)?chưa/i],
  ["exp_pilates", /đã\s*tập\s*pilates\s*(bao\s*giờ\s*)?chưa/i],
  ["goal", /mục\s*tiêu.{0,30}(là\s*gì|gì\s*ạ|tăng\s*cân|giảm\s*cân|duy\s*trì)/i],
  ["schedule", /(sáng\s*hay\s*chiều|tiện\s*(buổi|sáng|chiều|tối)|mấy\s*buổi\s*(\/|một|mỗi)\s*tuần|khung\s*giờ\s*nào)/i],
  ["method_history", /biện\s*pháp\s*giảm\s*cân/i],
  ["child_age", /(mấy\s*tuổi|năm\s*nay\s*bao\s*nhiêu\s*tuổi)/i],
  ["newbie_status", /(đã\s*từng\s*tập|trước\s*đây\s*đã\s*tập|đã\s*tập\s*bộ\s*môn)/i],
  ["contact", /(cho\s+em\s+xin\s+(tên|sđt|số)|xin\s+(tên|liên\s+hệ|sđt))/i],
  ["preferred_time", /(muốn\s+đến\s+buổi|tiện\s+ghé\s+(sáng|chiều|tối|hôm\s+nào)|đến\s+khi\s+nào)/i],
  ["pain_area", /(đau\s+ở\s+(vùng|đâu)|vùng\s+nào\s+đau|đau\s+(vai|gáy|cổ|lưng|chân|gối))/i],
  ["pain_spread", /(lan\s+ra|cố\s+định\s+(một|1)\s*(điểm|chỗ)|đau\s+lan)/i],
  ["pain_method", /(thử\s+massage|đã\s+thử|dán\s+cao|uống\s+thuốc|vật\s+lý\s+trị\s+liệu)/i],
];

export function detectAskedQuestions(reply: string): string[] {
  if (!reply) return [];
  const keys: string[] = [];
  for (const [key, pat] of QUESTION_KEY_PATTERNS) {
    if (pat.test(reply)) keys.push(key);
  }
  return keys;
}

// ─────────────────────────────────────────────
// FACT DETECTORS — scan bot reply để biết fact nào đã được pitch
// ─────────────────────────────────────────────

const FACT_KEY_PATTERNS: Array<[string, RegExp]> = [
  ["inbody_free", /(inbody\s+miễn\s+phí|đo\s+inbody\s+(miễn\s+phí|lần\s+đầu))/i],
  ["full_4_dichvu", /(thẻ\s+Full\s+4\s+dịch\s+vụ|Full\s+(Gym\s*\+\s*Bơi|4\s+dịch\s+vụ))/i],
  ["full_7tr", /(Full.{0,30}7\s*triệu|7\s*triệu.{0,20}12\s*tháng.{0,20}Full)/i],
  ["pt_6tr", /(PT\s+20\s+buổi\s+6\s*triệu|6\s*triệu.{0,15}2\s*tháng.{0,15}PT)/i],
  ["be_4_mua", /(bể\s+4\s+mùa|bể\s+bơi.{0,15}duy\s+nhất\s+Vĩnh\s+Yên)/i],
  ["gv_an_do", /(GV\s+Ấn\s+Độ|giáo\s+viên\s+(người\s+)?Ấn\s+Độ)/i],
  ["gym_700m2", /(gym.{0,15}700m2|phòng\s+gym\s+rộng\s+700)/i],
  ["hoc_boi_1_1", /(học\s+bơi\s+1-?1|lớp\s+1-?1\s+12\s+buổi)/i],
  ["commit_warranty", /(cam\s+kết\s+biết\s+bơi|học\s+lại\s+miễn\s+phí)/i],
  ["pricing_yoga", /(yoga.{0,20}(\d+\.?\d*)\s*triệu|\d+\.?\d*\s*triệu.{0,15}yoga)/i],
  ["pricing_zumba", /(zumba.{0,20}\d+\s*(k|triệu)|375k)/i],
];

export function detectMentionedFacts(reply: string): string[] {
  if (!reply) return [];
  const keys: string[] = [];
  for (const [key, pat] of FACT_KEY_PATTERNS) {
    if (pat.test(reply)) keys.push(key);
  }
  return keys;
}

// ─────────────────────────────────────────────
// STATE UPDATE — merge detected keys vào state
// ─────────────────────────────────────────────

/**
 * Tăng tracking sets sau khi bot reply. Idempotent — không duplicate.
 * Cap size để không phình state (max 20 entries / set).
 */
export function updateTracking(
  state: ConversationState,
  botReply: string,
): { askedHistory: string[]; mentionedFacts: string[] } {
  const newAsked = detectAskedQuestions(botReply);
  const newFacts = detectMentionedFacts(botReply);
  const currentAsked = state.askedHistory ?? [];
  const currentFacts = state.mentionedFacts ?? [];
  const mergedAsked = Array.from(new Set([...currentAsked, ...newAsked])).slice(-20);
  const mergedFacts = Array.from(new Set([...currentFacts, ...newFacts])).slice(-20);
  return { askedHistory: mergedAsked, mentionedFacts: mergedFacts };
}

// ─────────────────────────────────────────────
// QUERY HELPERS — dùng trong templates / prefix
// ─────────────────────────────────────────────

export function hasAsked(state: ConversationState, key: string): boolean {
  return (state.askedHistory ?? []).includes(key);
}

export function hasMentioned(state: ConversationState, key: string): boolean {
  return (state.mentionedFacts ?? []).includes(key);
}

/**
 * scripts/grader.ts
 *
 * Đánh giá hội thoại theo rubric 10 điểm. Kết hợp 2 loại check:
 *   1. Deterministic checks (regex/rule-based) — bắt lỗi rõ rệt, không cần LLM
 *   2. LLM judge (gpt-4o-mini) — đánh giá độ tự nhiên, intent, sale tactic
 *
 * Mỗi turn được chấm 0-10:
 *   - Tự nhiên (3): không lặp, không khen giả, có "dạ/ạ/nha", không markdown/URL leak
 *   - Đúng intent (3): trả lời đúng câu hỏi/ý khách, không né, không lặp lại câu khách
 *   - FSM transition (2): stage chuyển hợp lý, không nhảy ngược, không pitch sau khi đã chốt
 *   - Sale tactic (2): build value trước price, anchor cao→vừa→nhẹ, gửi media đúng moment
 *
 * Scenario score = avg(turn scores). Min target ≥ 9.0/10 (= 90/100).
 */

import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { openai } from "../config/openai";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export interface TurnSnapshot {
  turn: number;
  input: string;
  reply: string;
  mediaCount: number;
  hasQR: boolean;
  state: {
    flow: string;
    stage: string;
    intent: string;
    knownInfo: Record<string, unknown>;
  };
  prevStage?: string; // stage trước turn này
}

export interface TurnScore {
  turn: number;
  natural: number;
  intent_match: number;
  fsm_correct: number;
  sale_tactic: number;
  total: number;
  deterministic_issues: string[];
  judge_issues: string[];
}

export interface ScenarioScore {
  name: string;
  turn_scores: TurnScore[];
  avg_score: number;
  min_turn_score: number;
  total_issues: string[];
}

// ─────────────────────────────────────────────
// DETERMINISTIC CHECKS
// ─────────────────────────────────────────────

const FAKE_PRAISE = /tuyệt\s*vời|tuyệt\s*quá|chắc\s*chắn\s*rồi|rất\s*vui\s*được|quá\s*hợp\s*lý|hay\s*quá|chuẩn\s*rồi/i;
const URL_LEAK = /https?:\/\/|!\[.*\]\(.*\)|\[.*\]\(http/i;
const MARKDOWN_BOLD = /\*\*[^*]+\*\*|__[^_]+__/;

/**
 * Trả mảng issues (text mô tả lỗi). Empty = clean.
 * Mỗi issue penalty -1 điểm tự nhiên (max -3).
 */
function deterministicChecks(turn: TurnSnapshot, prevReply?: string): string[] {
  const issues: string[] = [];
  const r = turn.reply;

  if (!r || !r.trim()) {
    issues.push("Reply rỗng");
    return issues;
  }

  if (FAKE_PRAISE.test(r)) {
    issues.push(`Khen giả: "${r.match(FAKE_PRAISE)?.[0]}"`);
  }
  if (URL_LEAK.test(r)) {
    issues.push("URL/markdown link leak vào text");
  }
  if (MARKDOWN_BOLD.test(r)) {
    issues.push("Có **bold**/__italic__ markdown");
  }

  // Đếm câu hỏi (HARD RULE: max 1)
  const questionCount = (r.match(/[?？]/g) || []).length;
  if (questionCount > 1) {
    issues.push(`${questionCount} câu hỏi trong 1 reply (max 1)`);
  }

  // Reply quá dài — Zalo nên < 280 ký tự, > 400 phạt nặng
  if (r.length > 400) {
    issues.push(`Reply quá dài (${r.length} ký tự, nên < 280)`);
  }

  // Lặp y câu trước
  if (prevReply && r.trim() === prevReply.trim()) {
    issues.push("Lặp y nguyên reply trước");
  }

  // Lặp 1 cụm câu hỏi cụ thể với tin trước (similarity nhanh): tìm câu hỏi
  // chính trong reply hiện tại và check xem có xuất hiện gần như y nguyên ở reply trước không.
  if (prevReply) {
    const currentQuestion = r.match(/[^.!?]+\?/)?.[0]?.trim();
    if (currentQuestion && currentQuestion.length > 15 && prevReply.includes(currentQuestion.slice(0, Math.min(40, currentQuestion.length - 5)))) {
      issues.push(`Lặp lại câu hỏi từ reply trước: "${currentQuestion.slice(0, 60)}"`);
    }
  }

  // Bot phát ngôn "em gửi hình" mà không thực sự có mediaCount > 0
  if (
    /(em\s+(gửi|sẽ\s+gửi|có\s+thể\s+gửi|gửi\s+thử)|để\s+(em|chị|anh)\s+gửi).{0,30}(hình|ảnh|video|clip)/i.test(
      r,
    ) &&
    turn.mediaCount === 0
  ) {
    issues.push("Phát ngôn 'em gửi hình' nhưng KHÔNG gọi tool get-media (hứa hão)");
  }

  // Markdown bullet "- " (Zalo không render đúng)
  if (/^\s*-\s+/m.test(r)) {
    issues.push("Có markdown bullet '-' (không phù hợp Zalo)");
  }

  // Stage nhảy ngược (commitment → discovery)
  // (kiểm thực hiện bên ngoài vì cần prev state)

  // FSM: nếu commitment + đã có name+phone+time → mediaCount phải = 0 (không nên gửi)
  const ki = turn.state.knownInfo as Record<string, unknown>;
  const stage = turn.state.stage;
  const hasContact = !!ki.name && !!ki.phone;
  const hasTime = !!ki.preferredTime;
  if (stage === "commitment" && hasContact && hasTime && turn.mediaCount > 0) {
    issues.push("Gửi media ở commitment khi đã đủ tên/SĐT/giờ — sai moment");
  }

  // Pitch lại khi đã chốt: reply chứa giá rõ ("tr"/"k", có số)
  if (
    stage === "commitment" &&
    hasContact &&
    hasTime &&
    /\d+\s*(tr|k|triệu)/i.test(r) &&
    !ki.qrShown // nếu không phải đang gửi QR
  ) {
    issues.push("Pitch giá khi đã đủ thông tin chốt");
  }

  return issues;
}

// ─────────────────────────────────────────────
// LLM JUDGE
// ─────────────────────────────────────────────

const judgeAgent = new Agent({
  name: "scenario-judge",
  id: "scenario-judge",
  model: openai("gpt-4o-mini"),
  instructions:
    "Bạn là chuyên gia review hội thoại sale chatbot tiếng Việt. " +
    "Bạn đánh giá độ tự nhiên, đúng intent khách, sale tactic. Trả JSON theo schema.",
});

const judgeSchema = z.object({
  natural: z
    .number()
    .min(0)
    .max(3)
    .describe(
      "0-3. 3=như nhắn người thật, có dạ/ạ/nha, không lặp. " +
        "2=ổn, vài chỗ cứng. 1=rõ là bot. 0=script khô.",
    ),
  intent_match: z
    .number()
    .min(0)
    .max(3)
    .describe(
      "0-3. 3=trả lời đúng câu hỏi khách trước, rồi mới dẫn dắt. " +
        "2=gần đúng. 1=né câu hỏi. 0=ignore.",
    ),
  fsm_correct: z
    .number()
    .min(0)
    .max(2)
    .describe(
      "0-2. 2=stage transition hợp lý theo mục tiêu sale. " +
        "1=hợp lý nhưng chưa optimal. 0=stage sai.",
    ),
  sale_tactic: z
    .number()
    .min(0)
    .max(2)
    .describe(
      "0-2. 2=đúng moment (value before price, anchor cao→vừa→nhẹ, gửi media đúng lúc, hỏi gộp khi commitment). " +
        "1=ổn nhưng có thể tốt hơn. 0=pitch sai moment.",
    ),
  issues: z
    .array(z.string())
    .describe("List ngắn các vấn đề tìm thấy. Empty nếu reply hoàn hảo."),
});

interface JudgeOutput {
  natural: number;
  intent_match: number;
  fsm_correct: number;
  sale_tactic: number;
  issues: string[];
}

async function judgeTurn(
  turn: TurnSnapshot,
  scenarioContext: string,
  history: { input: string; reply: string }[],
): Promise<JudgeOutput> {
  const historyBlock =
    history.length > 0
      ? "TIN TRƯỚC ĐÓ (context):\n" +
        history
          .map(
            (h, i) =>
              `  T${i + 1} KH: "${h.input}"\n  T${i + 1} BOT: "${h.reply.slice(0, 200)}"`,
          )
          .join("\n") +
        "\n\n"
      : "";

  const prompt = `BỐI CẢNH SCENARIO: ${scenarioContext}

${historyBlock}═══ TIN HIỆN TẠI (chấm điểm tin này) ═══
KHÁCH (turn ${turn.turn}): "${turn.input}"
BOT REPLY: "${turn.reply}"
STATE SAU TURN: flow=${turn.state.flow}, stage=${turn.state.stage}, intent=${turn.state.intent}
SLOTS đã có: ${JSON.stringify(turn.state.knownInfo, null, 0)}
${turn.mediaCount > 0 ? `✅ HÀNH ĐỘNG: Bot ĐÃ gửi ${turn.mediaCount} ảnh/video thật kèm tin (qua tool get-media). Khi khách xin xem ảnh → việc bot gửi ${turn.mediaCount} file ảnh = đáp ứng yêu cầu, KHÔNG trừ điểm vì "không gửi hình".` : ""}
${turn.hasQR ? "✅ HÀNH ĐỘNG: Bot ĐÃ gửi QR thanh toán." : ""}

TIÊU CHÍ:
- natural (0-3): Ngôn từ tự nhiên, không khen giả, không lặp y câu trước, không markdown/URL trong text.
- intent_match (0-3): Trả lời đúng điều khách hỏi/cần TRONG TIN HIỆN TẠI. Lưu ý context: nếu bot đã trả giá / nói X ở turn trước, KHÔNG cần lặp lại ở turn này. Khách hỏi giá lần đầu → answer first; khách đã có giá rồi → tiếp tục xây value/chốt.
- fsm_correct (0-2): Stage hợp lý. Không pitch lại khi đã chốt. Đã đủ tên+SĐT+giờ → xác nhận và DỪNG.
- sale_tactic (0-2): Build value trước price. Khách phản đối giá → reframe. Khách lạnh → KHÔNG xin info. Khi mediaCount > 0 = bot đã gửi ảnh thật rồi → KHÔNG đòi gửi thêm.

⚠️ CHẤM CÔNG BẰNG dựa trên context:
  - Nếu thông tin đã được trả lời ở turn trước → ĐỪNG trừ điểm 'không trả lời X'.
  - Nếu mediaCount > 0 → coi như bot ĐÃ gửi hình rồi (không cần xuất hiện URL trong text).
⚠️ KHẮT KHE với: khen giả ('Tuyệt vời/quá'), reply > 300 ký tự, pitch khi đã chốt, ép info khi khách lạnh, lặp y câu hỏi từ turn trước.

Trả JSON với điểm và list issues.`;

  try {
    const result = await judgeAgent.generate(prompt, {
      structuredOutput: {
        schema: judgeSchema,
        instructions: "Trả đúng schema, điểm số phải nằm trong khoảng quy định.",
      },
    });
    if (!result.object) throw new Error("judge returned no object");
    return result.object;
  } catch (e) {
    console.error(`[judge] turn ${turn.turn} failed:`, e);
    // Fallback: cho điểm trung bình + đánh dấu lỗi
    return {
      natural: 2,
      intent_match: 2,
      fsm_correct: 1,
      sale_tactic: 1,
      issues: [`judge error: ${String(e).slice(0, 100)}`],
    };
  }
}

// ─────────────────────────────────────────────
// MAIN SCORING
// ─────────────────────────────────────────────

export async function gradeScenario(
  scenarioName: string,
  scenarioDescription: string,
  turns: TurnSnapshot[],
): Promise<ScenarioScore> {
  const turn_scores: TurnScore[] = [];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const prev = i > 0 ? turns[i - 1].reply : undefined;
    // Pass tối đa 3 turn trước làm history cho judge có context
    const history = turns
      .slice(Math.max(0, i - 3), i)
      .map((h) => ({ input: h.input, reply: h.reply }));

    const detIssues = deterministicChecks(t, prev);
    const judge = await judgeTurn(t, scenarioDescription, history);

    // Trừ điểm cho deterministic issues (mỗi issue -1 điểm tự nhiên, min 0)
    const naturalAfterDet = Math.max(0, judge.natural - detIssues.length);

    const total =
      naturalAfterDet + judge.intent_match + judge.fsm_correct + judge.sale_tactic;

    turn_scores.push({
      turn: t.turn,
      natural: naturalAfterDet,
      intent_match: judge.intent_match,
      fsm_correct: judge.fsm_correct,
      sale_tactic: judge.sale_tactic,
      total,
      deterministic_issues: detIssues,
      judge_issues: judge.issues,
    });
  }

  const avg_score =
    turn_scores.reduce((acc, s) => acc + s.total, 0) / turn_scores.length;
  const min_turn_score = Math.min(...turn_scores.map((s) => s.total));

  const total_issues = turn_scores.flatMap((s) => [
    ...s.deterministic_issues.map((i) => `T${s.turn}: ${i}`),
    ...s.judge_issues.map((i) => `T${s.turn}: ${i}`),
  ]);

  return {
    name: scenarioName,
    turn_scores,
    avg_score: Math.round(avg_score * 100) / 100,
    min_turn_score,
    total_issues,
  };
}

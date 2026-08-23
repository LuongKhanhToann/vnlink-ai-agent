/**
 * engine/brain.ts — Một lượt hội thoại. Điều phối các tầng L0–L6 theo SDD_CHATBOT_FAMI.
 *
 *   L5 classify → L1 advanceStage → L2 needsMap → L3 selectScenarios → L4 retrieve(fact_query)
 *   → lắp prompt (L0 + time + stage + needs + scenario + facts) → generateReply → L6 complianceGate.
 *
 * Cờ SCENARIO_MODE=off → chạy đúng luồng RAG cũ (runTurnLegacy) làm lối thoát hiểm.
 * Fail-open theo tầng: mọi tầng phụ lỗi đều KHÔNG dừng lượt (xem từng call). KHÔNG cache.
 */

import { generateReply, type ChatMsg } from "../llm/gemini";
import { retrieveForTurn } from "../rag/retrieve";
import { loadRecent, appendMessage } from "../lib/history";
import { loadState, saveState } from "../lib/convState";
import { FAMI_SYSTEM } from "../prompts/fami";
import { vnParts, buildTimeBlock, stampFor } from "../lib/timeContext";
import { loadConfig } from "../lib/settings";
import { classify } from "./classifier";
import { advanceStage, stageDirective } from "./stages";
import { needsMap, needsBlock } from "./needs";
import { selectScenarios, scenarioBlock } from "./scenarios";
import { complianceGate } from "./compliance";
import { scheduleOutbound } from "./outbound";
import type { StageCode } from "./taxonomy";

export interface TurnInput {
  senderId: string;
  message: string;
  abortSignal?: AbortSignal;
}

export interface TurnDebug {
  service: string | null;
  segment: string | null;
  objections: string;
  stageFrom: StageCode;
  stageTo: StageCode;
  scenarios: string;
  factsLen: number;
  factQuery: string | null;
  facts?: string; // chỉ set khi SCENARIO_DEBUG — để smoke kiểm giá có thật trong tài liệu
}
export interface TurnResult {
  reply: string;
  debug?: TurnDebug;
}

const CONV_RESET_HOURS = (() => {
  const v = Number(process.env.CONV_RESET_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 6;
})();

/** Khách quay lại sau thời gian dài → coi như hội thoại mới, đưa về S1. */
function stageAfterReset(stage: StageCode, updatedAt: Date | null, nowMs: number): StageCode {
  if (!updatedAt) return stage;
  const gapH = (nowMs - updatedAt.getTime()) / 3_600_000;
  return gapH >= CONV_RESET_HOURS ? "S1" : stage;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  if ((process.env.SCENARIO_MODE || "").toLowerCase() === "off") return runTurnLegacy(input);
  return runTurnScenario(input);
}

async function runTurnScenario(input: TurnInput): Promise<TurnResult> {
  const { senderId, message, abortSignal } = input;

  const history = await loadRecent(senderId);
  const state = await loadState(senderId);
  const now = vnParts();
  const stage0 = stageAfterReset(state.stage, state.updatedAt, Date.now());

  // L5 — phân loại (fail-open bên trong).
  const cls = await classify(history, message, stage0, abortSignal);
  // L1 — tiến bước (không lùi).
  const stage = advanceStage(stage0, cls.stage_move);
  // L2 — nhu cầu dự báo theo service (có kế thừa).
  const needs = needsMap(cls.service);
  // L3 — chọn kịch bản nguyên văn theo phân loại (fail-open []).
  const scen = await selectScenarios(cls);
  // L4 — chỉ tra tài liệu khi lượt cần dữ kiện (fact_query).
  const facts = cls.fact_query
    ? await retrieveForTurn({ message, history, query: cls.fact_query })
    : "";

  // Lắp prompt (mục 8 SDD).
  const config = await loadConfig();
  const timeBlock = buildTimeBlock(now, config);
  const systemContent = [
    FAMI_SYSTEM,
    timeBlock,
    stageDirective(stage),
    needsBlock(needs),
    scenarioBlock(scen),
    facts,
  ]
    .filter(Boolean)
    .join("\n\n");

  const stamped: ChatMsg[] = history.map(
    (t) =>
      ({
        role: t.role,
        content: t.createdAt ? `(${stampFor(new Date(t.createdAt), now)}) ${t.content}` : t.content,
      }) as ChatMsg,
  );
  const userMsg: ChatMsg = { role: "user", content: `(${now.hhmm}) ${message}` };
  const baseMessages: ChatMsg[] = [{ role: "system", content: systemContent }, ...stamped, userMsg];

  const gen = (sys: string): Promise<string> =>
    generateReply([{ role: "system", content: sys }, ...stamped, userMsg], {
      temperature: 0.6,
      maxTokens: 700,
      abortSignal,
      purpose: "Trả lời khách",
    });

  let reply = (await generateReply(baseMessages, { temperature: 0.6, maxTokens: 700, abortSignal, purpose: "Trả lời khách" })).trim();
  if (!reply) throw new Error("model trả rỗng");

  // L6 — cổng tuân thủ (regenerate kèm chỉ thị sửa khi vi phạm).
  reply = await complianceGate(
    reply,
    { facts, stage, cls },
    (corrective) => gen(`${systemContent}\n\n⚠ SỬA LẠI CÂU TRẢ LỜI: ${corrective}`),
  );
  reply = reply.trim();
  if (!reply) throw new Error("reply rỗng sau compliance");

  await appendMessage(senderId, "user", message);
  await appendMessage(senderId, "assistant", reply);
  await saveState(senderId, stage);
  // L7 — đặt/huỷ job chủ động (no-op khi OUTBOUND_MODE=off). Best-effort, không chặn reply.
  scheduleOutbound({ senderId, stage, cls }).catch((e) =>
    console.warn("[brain] scheduleOutbound lỗi (bỏ qua):", (e as Error).message),
  );

  const debug: TurnDebug | undefined = process.env.SCENARIO_DEBUG
    ? {
        service: cls.service,
        segment: cls.segment,
        objections: cls.objections.map((o) => `${o.code}:${o.confidence.toFixed(2)}`).join(",") || "-",
        stageFrom: stage0,
        stageTo: stage,
        scenarios: scen.map((s) => s.id).join(",") || "(none)",
        factsLen: facts.length,
        factQuery: cls.fact_query,
        facts,
      }
    : undefined;
  return { reply, debug };
}

/**
 * Luồng RAG cũ (SCENARIO_MODE=off) — lối thoát hiểm giữ nguyên hành vi trước đây:
 * loadRecent → retrieveForTurn(tự rewriteQuery) → FAMI_SYSTEM + time + docs → 1 call.
 */
async function runTurnLegacy(input: TurnInput): Promise<{ reply: string }> {
  const { senderId, message, abortSignal } = input;
  const history = await loadRecent(senderId);
  const docBlock = await retrieveForTurn({ message, history });
  const now = vnParts();
  const config = await loadConfig();
  const timeBlock = buildTimeBlock(now, config);
  const systemContent = [FAMI_SYSTEM, timeBlock, docBlock].filter(Boolean).join("\n\n");
  const messages: ChatMsg[] = [
    { role: "system", content: systemContent },
    ...history.map(
      (t) =>
        ({
          role: t.role,
          content: t.createdAt ? `(${stampFor(new Date(t.createdAt), now)}) ${t.content}` : t.content,
        }) as ChatMsg,
    ),
    { role: "user", content: `(${now.hhmm}) ${message}` },
  ];
  const reply = (
    await generateReply(messages, { temperature: 0.6, maxTokens: 700, abortSignal, purpose: "Trả lời khách" })
  ).trim();
  if (!reply) throw new Error("model trả rỗng");
  await appendMessage(senderId, "user", message);
  await appendMessage(senderId, "assistant", reply);
  return { reply };
}

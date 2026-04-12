/**
 * workflows/router.ts
 *
 * KIẾN TRÚC FSM + Store-first — 2 flows: fitness & giai-co
 *
 * Luồng mỗi turn:
 *   1. Load state từ store
 *   2. Keyword pre-check flow (code, không tốn LLM)
 *   3. LLM classify: emotion, intent, flow (nếu ambiguous), slots còn null
 *   4. FSM tính stage tiếp theo (code)
 *   5. Temperature tính từ slots + intent (code)
 *   6. Build prefix từ deterministic state
 *   7. Agent generate response
 *   8. Save state mới vào store
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { fitnessAgent } from "../agents/fitness";
import { giaiCoAgent } from "../agents/giaiCo";

import { loadState, saveState, debugStorageApi } from "../lib/stateStore";
import { classify } from "../lib/classifier";
import { buildNextState, detectFlowByKeyword } from "../lib/stateMachine";
import { buildPrefix } from "../lib/prefixBuilder";

// ─────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────

const inputSchema = z.object({
  message: z.string(),
  threadId: z.string(),
  resourceId: z.string().default("customer"),
});

const outputSchema = z.object({
  reply: z.string(),
  mediaUrls: z.array(z.string()).nullable(),
  qrUrl: z.string().nullable(),
  nextStep: z
    .enum(["ask_info", "show_media", "show_qr", "confirm", "close"])
    .nullable(),
});

const agentReplySchema = z.object({
  text: z.string().describe("Nội dung phản hồi gửi tới khách hàng"),
  mediaUrls: z
    .array(z.string())
    .nullable()
    .describe("Danh sách URL ảnh/video nếu có, null nếu không"),
  qrUrl: z
    .string()
    .nullable()
    .describe("URL ảnh QR thanh toán nếu có, null nếu không"),
  nextStep: z
    .enum(["ask_info", "show_media", "show_qr", "confirm", "close"])
    .describe("Bước tiếp theo backend cần xử lý"),
});

const processedStateSchema = z.object({
  message: z.string(),
  threadId: z.string(),
  resourceId: z.string(),
  flow: z.enum(["fitness", "giai-co"]),
  prefix: z.string(),
  qrShown: z.boolean(),
  mediaShown: z.boolean(),
});

// ─────────────────────────────────────────────
// STEP 1: Process
// ─────────────────────────────────────────────

const processStep = createStep({
  id: "process",
  inputSchema,
  outputSchema: processedStateSchema,
  execute: async ({ inputData, mastra }) => {
    const { message, threadId, resourceId } = inputData;

    await debugStorageApi(mastra);

    // 1. Load persisted state
    const previousState = await loadState(mastra, threadId, resourceId);
    console.log(
      `[process] loaded: flow=${previousState.flow} stage=${previousState.stage} temp=${previousState.temperature}`
    );

    // 2. Keyword pre-check flow
    const keywordFlow = detectFlowByKeyword(message, previousState.flow);
    const needFlowLLM = keywordFlow === null;

    // 3. LLM classify
    const llmResult = await classify({
      message,
      previousFlow: previousState.flow,
      previousStage: previousState.stage,
      currentKnownInfo: previousState.knownInfo,
      needFlowClassification: needFlowLLM,
    });

    if (!needFlowLLM) {
      llmResult.flow = keywordFlow;
    }

    console.log(
      `[process] llm: flow=${llmResult.flow ?? "unchanged"} emotion=${llmResult.emotion} intent=${llmResult.intent}`
    );

    // 4. Build next state (FSM)
    const nextState = buildNextState(previousState, message, llmResult);
    console.log(
      `[process] next: flow=${nextState.flow} stage=${nextState.stage} temp=${nextState.temperature}`
    );

    // 5. Persist
    await saveState(mastra, threadId, resourceId, nextState);

    // 6. Build prefix
    const prefix = buildPrefix(nextState);
    console.log(`[process] prefix:\n${prefix}`);

    return {
      message,
      threadId,
      resourceId,
      flow: nextState.flow,
      prefix,
      qrShown: nextState.qrShown,
      mediaShown: nextState.mediaShown,
    };
  },
});

// ─────────────────────────────────────────────
// HELPER: Update flags sau khi agent run
// ─────────────────────────────────────────────

async function updateStateFlags(
  mastra: any,
  threadId: string,
  resourceId: string,
  nextStep: string | null,
  currentFlags: { qrShown: boolean; mediaShown: boolean }
): Promise<void> {
  const needQR    = nextStep === "show_qr"    && !currentFlags.qrShown;
  const needMedia = nextStep === "show_media" && !currentFlags.mediaShown;

  if (!needQR && !needMedia) return;

  try {
    const current = await loadState(mastra, threadId, resourceId);
    const updated = {
      ...current,
      qrShown:    needQR    ? true : current.qrShown,
      mediaShown: needMedia ? true : current.mediaShown,
    };
    await saveState(mastra, threadId, resourceId, updated);
    console.log(`[flags] updated → qrShown=${updated.qrShown} mediaShown=${updated.mediaShown}`);
  } catch (e) {
    console.error("[flags] updateStateFlags failed:", e);
  }
}

// ─────────────────────────────────────────────
// STEP 2a: FitnessAgent
// ─────────────────────────────────────────────

const callFitnessStep = createStep({
  id: "call-fitness",
  inputSchema: processedStateSchema,
  outputSchema,
  execute: async ({ inputData, mastra }) => {
    const { prefix, message, threadId, resourceId, qrShown, mediaShown } = inputData;
    const fullMessage = [prefix, message].filter(Boolean).join("\n");

    const result = await fitnessAgent.generate(fullMessage, {
      maxSteps: 10,
      memory: {
        thread: { id: threadId },
        resource: resourceId,
        options: { lastMessages: 40 },
      },
      structuredOutput: {
        schema: agentReplySchema,
        instructions:
          "Trích xuất phản hồi vào 'text'. " +
          "mediaUrls: mảng URL nếu vừa gọi get-media, null nếu không. " +
          "qrUrl: URL QR nếu vừa gọi get-qr, null nếu không. " +
          "nextStep: 'show_media' khi vừa gửi media, 'show_qr' khi vừa gửi QR, " +
          "'ask_info' khi hỏi tên/SĐT, 'confirm' khi tóm đơn, 'close' khi xong.",
      },
    });

    const obj = result.object ?? {
      text: result.text,
      mediaUrls: null,
      qrUrl: null,
      nextStep: null,
    };

    await updateStateFlags(mastra, threadId, resourceId, obj.nextStep, { qrShown, mediaShown });

    return {
      reply: obj.text,
      mediaUrls: obj.mediaUrls ?? null,
      qrUrl: obj.qrUrl ?? null,
      nextStep: obj.nextStep ?? null,
    };
  },
});

// ─────────────────────────────────────────────
// STEP 2b: GiaiCoAgent
// ─────────────────────────────────────────────

const callGiaiCoStep = createStep({
  id: "call-giai-co",
  inputSchema: processedStateSchema,
  outputSchema,
  execute: async ({ inputData, mastra }) => {
    const { prefix, message, threadId, resourceId, qrShown, mediaShown } = inputData;
    const fullMessage = [prefix, message].filter(Boolean).join("\n");

    const result = await giaiCoAgent.generate(fullMessage, {
      maxSteps: 10,
      memory: {
        thread: { id: threadId },
        resource: resourceId,
        options: { lastMessages: 40 },
      },
      structuredOutput: {
        schema: agentReplySchema,
        instructions:
          "Trích xuất phản hồi vào 'text'. " +
          "mediaUrls: mảng URL nếu vừa gọi get-media, null nếu không. " +
          "qrUrl: URL QR nếu vừa gọi get-qr, null nếu không. " +
          "nextStep: bước tiếp theo thực sự cần làm.",
      },
    });

    const obj = result.object ?? {
      text: result.text,
      mediaUrls: null,
      qrUrl: null,
      nextStep: null,
    };

    await updateStateFlags(mastra, threadId, resourceId, obj.nextStep, { qrShown, mediaShown });

    return {
      reply: obj.text,
      mediaUrls: obj.mediaUrls ?? null,
      qrUrl: obj.qrUrl ?? null,
      nextStep: obj.nextStep ?? null,
    };
  },
});

// ─────────────────────────────────────────────
// WORKFLOW
// ─────────────────────────────────────────────

export const routerWorkflow = createWorkflow({
  id: "health-router-workflow",
  inputSchema,
  outputSchema,
})
  .then(processStep)
  .branch([
    [async ({ inputData }) => inputData.flow === "fitness", callFitnessStep],
    [async ({ inputData }) => inputData.flow === "giai-co", callGiaiCoStep],
  ])
  .commit();
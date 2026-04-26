/**
 * workflows/router.ts
 *
 * KIẾN TRÚC FSM + Store-first — 2 flows: fitness & giai-co
 */

import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

import { fitnessAgent } from "../agents/fitness";
import { giaiCoAgent } from "../agents/giaiCo";

import { loadState, saveState } from "../lib/stateStore";
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
  text: z.string().describe(
    "Nội dung text phản hồi gửi tới khách hàng. " +
    "TUYỆT ĐỐI KHÔNG chứa URL, markdown image ![](url), hay link ảnh dưới bất kỳ hình thức nào. " +
    "Chỉ chứa văn bản thuần túy."
  ),
  mediaUrls: z
    .array(z.string())
    .nullable()
    .describe(
      "Mảng URL ảnh/video lấy TRỰC TIẾP từ kết quả tool get-media. " +
      "Nếu vừa gọi get-media thì PHẢI điền URL vào đây, KHÔNG điền vào text. " +
      "Null nếu không gọi get-media."
    ),
  qrUrl: z
    .string()
    .nullable()
    .describe(
      "URL ảnh QR lấy TRỰC TIẾP từ kết quả tool get-qr. " +
      "Null nếu không gọi get-qr."
    ),
  nextStep: z
    .enum(["ask_info", "show_media", "show_qr", "confirm", "close"])
    .describe(
      "Bước tiếp theo: " +
      "'show_media' khi vừa gọi get-media và có mediaUrls, " +
      "'show_qr' khi vừa gọi get-qr và có qrUrl, " +
      "'ask_info' khi đang hỏi tên/SĐT, " +
      "'confirm' khi tóm tắt đơn hàng, " +
      "'close' khi hoàn tất."
    ),
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

    const previousState = await loadState(mastra, threadId, resourceId);
    console.log(
      `[process] loaded: flow=${previousState.flow} stage=${previousState.stage} temp=${previousState.temperature}`
    );

    const keywordFlow = detectFlowByKeyword(message, previousState.flow);
    const needFlowLLM = keywordFlow === null;

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

    const nextState = buildNextState(previousState, message, llmResult);
    console.log(
      `[process] next: flow=${nextState.flow} stage=${nextState.stage} temp=${nextState.temperature}`
    );

    await saveState(mastra, threadId, resourceId, nextState);

    // Pass lastBotReply (từ turn trước) để buildPrefix tạo ANTI_LOOP hint
    const prefix = buildPrefix(nextState, message, previousState.lastBotReply);
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

async function updateStateAfterReply(
  mastra: any,
  threadId: string,
  resourceId: string,
  nextStep: string | null,
  currentFlags: { qrShown: boolean; mediaShown: boolean },
  botReply: string,
): Promise<void> {
  const needQR    = nextStep === "show_qr"    && !currentFlags.qrShown;
  const needMedia = nextStep === "show_media" && !currentFlags.mediaShown;

  try {
    const current = await loadState(mastra, threadId, resourceId);
    const updated = {
      ...current,
      qrShown:    needQR    ? true : current.qrShown,
      mediaShown: needMedia ? true : current.mediaShown,
      lastBotReply: botReply || current.lastBotReply,
    };
    await saveState(mastra, threadId, resourceId, updated);
    console.log(`[flags] saved → qrShown=${updated.qrShown} mediaShown=${updated.mediaShown} replyLen=${(botReply||'').length}`);
  } catch (e) {
    console.error("[flags] updateStateAfterReply failed:", e);
  }
}

// ─────────────────────────────────────────────
// SHARED INSTRUCTIONS CHO STRUCTURED OUTPUT
// ─────────────────────────────────────────────

const STRUCTURED_OUTPUT_INSTRUCTIONS =
  "Trích xuất phản hồi vào các trường sau:\n" +
  "- 'text': văn bản thuần túy gửi cho khách. TUYỆT ĐỐI KHÔNG chứa URL, markdown ![](url), hay link ảnh dưới bất kỳ hình thức nào.\n" +
  "- 'mediaUrls': nếu vừa gọi tool get-media thì copy TOÀN BỘ URL từ kết quả tool vào đây dưới dạng mảng string. Null nếu không gọi get-media. TUYỆT ĐỐI KHÔNG duplicate URL.\n" +
  "- 'qrUrl': nếu vừa gọi tool get-qr thì copy URL qrUrl từ kết quả tool vào đây. Null nếu không gọi get-qr.\n" +
  "- 'nextStep': 'show_media' khi mediaUrls có dữ liệu, 'show_qr' khi qrUrl có dữ liệu, 'ask_info' khi hỏi tên/SĐT, 'confirm' khi tóm đơn, 'close' khi xong.";

// ─────────────────────────────────────────────
// STEP 2: gọi agent (fitness hoặc giai-co) — DRY chung
// ─────────────────────────────────────────────

type ChatAgent = typeof fitnessAgent | typeof giaiCoAgent;

function buildAgentStep(
  id: "call-fitness" | "call-giai-co",
  agent: ChatAgent,
) {
  return createStep({
    id,
    inputSchema: processedStateSchema,
    outputSchema,
    execute: async ({ inputData, mastra }) => {
      const { prefix, message, threadId, resourceId, qrShown, mediaShown } =
        inputData;
      const fullMessage = [prefix, message].filter(Boolean).join("\n");

      const result = await agent.generate(fullMessage, {
        maxSteps: 4,
        memory: {
          thread: { id: threadId },
          resource: resourceId,
          options: { lastMessages: 20 },
        },
        structuredOutput: {
          schema: agentReplySchema,
          instructions: STRUCTURED_OUTPUT_INSTRUCTIONS,
        },
      });

      const obj = result.object ?? {
        text: result.text,
        mediaUrls: null,
        qrUrl: null,
        nextStep: "close" as const,
      };

      await updateStateAfterReply(
        mastra,
        threadId,
        resourceId,
        obj.nextStep,
        { qrShown, mediaShown },
        obj.text ?? "",
      );

      return {
        reply: obj.text,
        mediaUrls: obj.mediaUrls ?? null,
        qrUrl: obj.qrUrl ?? null,
        nextStep: obj.nextStep ?? null,
      };
    },
  });
}

const callFitnessStep = buildAgentStep("call-fitness", fitnessAgent);
const callGiaiCoStep  = buildAgentStep("call-giai-co",  giaiCoAgent);

// Safety net: nếu flow lạ (DB corrupt, edge case không lường) thì vẫn reply
// thay vì im lặng để khách bị bỏ rơi.
const fallbackStep = createStep({
  id: "fallback",
  inputSchema: processedStateSchema,
  outputSchema,
  execute: async ({ inputData }) => {
    console.error(
      `[router] flow không hợp lệ: "${inputData.flow}" — dùng fallback fitness`,
    );
    const { prefix, message, threadId, resourceId } = inputData;
    const fullMessage = [prefix, message].filter(Boolean).join("\n");
    const result = await fitnessAgent.generate(fullMessage, {
      maxSteps: 4,
      memory: {
        thread: { id: threadId },
        resource: resourceId,
        options: { lastMessages: 20 },
      },
      structuredOutput: {
        schema: agentReplySchema,
        instructions: STRUCTURED_OUTPUT_INSTRUCTIONS,
      },
    });
    const obj = result.object ?? {
      text: result.text,
      mediaUrls: null,
      qrUrl: null,
      nextStep: "close" as const,
    };
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
    // Safety net — flow lạ (DB corrupt) vẫn có reply thay vì im lặng.
    [
      async ({ inputData }) =>
        inputData.flow !== "fitness" && inputData.flow !== "giai-co",
      fallbackStep,
    ],
  ])
  .commit();
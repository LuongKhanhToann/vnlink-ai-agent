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
import {
  buildPrefix,
  buildPrefixWithMeta,
  computeSuggestedMediaKey,
  detectMentionedServiceKey,
} from "../lib/prefixBuilder";
import { logTurn, type PrefixMode } from "../lib/observability";
import { cleanReply } from "../lib/cleanReply";
import { validateReply, safeFallback, offTopicFallback } from "../lib/validator";
import { updateTracking } from "../lib/tracking";

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
    .nullable()
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
  /** Phase 7 telemetry: prefix mode + template id để log structured. */
  prefixMode: z.enum(["SCRIPT", "GATE", "PITCH"]),
  templateId: z.string().nullable(),
});

// ─────────────────────────────────────────────
// STEP 1: Process
// ─────────────────────────────────────────────

const processStep = createStep({
  id: "process",
  inputSchema,
  outputSchema: processedStateSchema,
  execute: async ({ inputData, mastra, abortSignal }) => {
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
      previousIntentTopic: previousState.intentTopic,
      abortSignal,
    });

    if (!needFlowLLM) {
      llmResult.flow = keywordFlow;
    }

    console.log(
      `[process] llm: flow=${llmResult.flow ?? "unchanged"} emotion=${llmResult.emotion} intent=${llmResult.intent} topic=${llmResult.intentTopic ?? "null"}`
    );

    const nextState = buildNextState(previousState, message, llmResult);
    // Set lastUserMessage = current message (sẽ là "user msg của turn trước" khi turn sau load state).
    nextState.lastUserMessage = message;
    console.log(
      `[process] next: flow=${nextState.flow} stage=${nextState.stage} temp=${nextState.temperature}`
    );

    await saveState(mastra, threadId, resourceId, nextState);

    // Pass lastBotReply (từ turn trước) để buildPrefix tạo ANTI_LOOP hint
    const prefixResult = buildPrefixWithMeta(nextState, message, previousState.lastBotReply);
    console.log(`[process] prefix:\n${prefixResult.prefix}`);

    return {
      message,
      threadId,
      resourceId,
      flow: nextState.flow,
      prefix: prefixResult.prefix,
      qrShown: nextState.qrShown,
      mediaShown: nextState.mediaShown,
      prefixMode: prefixResult.mode,
      templateId: prefixResult.templateId,
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
  customerMessage: string,
): Promise<void> {
  const needQR    = nextStep === "show_qr"    && !currentFlags.qrShown;
  // KHÔNG check !mediaShown ở đây — cho phép gửi media mới khi khách hỏi service khác.
  const needMedia = nextStep === "show_media";

  try {
    const current = await loadState(mastra, threadId, resourceId);
    // Ghi key vừa gửi vào mediaShownKeys (per-service tracking).
    // Ưu tiên key khách vừa mention (vd: "zumba") rồi mới fallback theo state.
    const currentKeys = current.mediaShownKeys ?? [];
    const sentKey = needMedia
      ? (detectMentionedServiceKey(customerMessage) ?? computeSuggestedMediaKey(current))
      : null;
    const updatedKeys =
      sentKey && !currentKeys.includes(sentKey)
        ? [...currentKeys, sentKey]
        : currentKeys;
    // Phase 6: detect câu hỏi đã hỏi + fact đã pitch → cập nhật tracking sets.
    const tracking = updateTracking(current, botReply);
    const updated = {
      ...current,
      qrShown:    needQR    ? true : current.qrShown,
      mediaShown: needMedia ? true : current.mediaShown,
      mediaShownKeys: updatedKeys,
      lastBotReply: botReply || current.lastBotReply,
      askedHistory: tracking.askedHistory,
      mentionedFacts: tracking.mentionedFacts,
    };
    await saveState(mastra, threadId, resourceId, updated);
    console.log(
      `[flags] saved → qrShown=${updated.qrShown} mediaShown=${updated.mediaShown} keys=[${updatedKeys.join(",")}] replyLen=${(botReply||'').length} asked=[${tracking.askedHistory.join(",")}] facts=[${tracking.mentionedFacts.join(",")}]`
    );
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
    execute: async ({ inputData, mastra, abortSignal }) => {
      const turnStart = Date.now();
      const { prefix, message, threadId, resourceId, qrShown, mediaShown, prefixMode, templateId } =
        inputData;
      const fullMessage = [prefix, message].filter(Boolean).join("\n");

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        result = await agent.generate(fullMessage, {
          // maxSteps 2: cho phép 1 LLM step + 1 tool call (get-media or get-qr).
          // Trước là 4 → bot đôi khi gọi tool 2-3 lần → duplicate media.
          maxSteps: 2,
          // temperature 0.85 + top_p 0.95: tăng tự nhiên, đa dạng phrasing.
          // Trước là 0.3 → bot output stiff như đọc script, comply nguyên văn rule.
          // cleanReply + structured schema vẫn bắt được output off-brand.
          modelSettings: { temperature: 0.85, topP: 0.95 },
          abortSignal,
          memory: {
            thread: { id: threadId },
            resource: resourceId,
            options: { lastMessages: 8 },
          },
          structuredOutput: {
            schema: agentReplySchema,
            instructions: STRUCTURED_OUTPUT_INSTRUCTIONS,
          },
        });
      } catch (e) {
        console.error(`[${id}] agent.generate failed:`, e);
        throw e;
      }

      const obj = result.object ?? {
        text: result.text,
        mediaUrls: null,
        qrUrl: null,
        nextStep: "close" as const,
      };

      // Dedupe mediaUrls (defensive — bot có thể gọi tool 2 lần trả URLs duplicate).
      // Quy trình: trim → Set → giữ MAX 3 image + 2 video (tổng tối đa 5 items).
      let dedupedMediaUrls: string[] | null = null;
      if (obj.mediaUrls && Array.isArray(obj.mediaUrls)) {
        const rawCount = obj.mediaUrls.length;
        const trimmed: string[] = (obj.mediaUrls as unknown[])
          .map((u) => (typeof u === "string" ? u.trim() : ""))
          .filter((u): u is string => u.length > 0);
        const cleaned: string[] = Array.from(new Set(trimmed));
        const isVideo = (u: string): boolean =>
          /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(u) ||
          u.toLowerCase().includes("/video/");
        const videos: string[] = cleaned.filter(isVideo).slice(0, 2);
        const images: string[] = cleaned
          .filter((u) => !isVideo(u))
          .slice(0, 3);
        const capped: string[] = [...images, ...videos];
        dedupedMediaUrls = capped.length > 0 ? capped : null;
        if (rawCount !== capped.length) {
          console.log(
            `[mediaCap] raw=${rawCount} unique=${cleaned.length} sent=${capped.length} (capped at 3img+2vid)`,
          );
        }
      }

      // Load prev reply để cleanReply strip pitch lặp
      const stateBeforeReply = await loadState(mastra, threadId, resourceId);
      const prevReply = stateBeforeReply.lastBotReply ?? "";

      // Deterministic post-process: strip khen giả, fake media offer, filler, markdown,
      // pitch lặp (nếu prev đã list package).
      const hasMedia = !!(dedupedMediaUrls && dedupedMediaUrls.length > 0);
      let cleanedText = cleanReply(obj.text ?? "", hasMedia, prevReply);

      // ═══════════ PHASE 5 — Output validator + graceful fallback ═══════════
      // Off-topic edge: classifier output edge/off_topic → fixed safe response, KHÔNG để bot bịa.
      const intentSig = stateBeforeReply.intentSignal;
      let validatorResult: "valid" | "off-topic-fallback" | string[] = "valid";
      if (
        intentSig &&
        intentSig.domain === "edge" &&
        intentSig.attribute === "off_topic"
      ) {
        const fallback = offTopicFallback(stateBeforeReply);
        console.warn(`[validator] off-topic fallback fired (was: "${cleanedText.slice(0, 60)}...")`);
        cleanedText = fallback;
        validatorResult = "off-topic-fallback";
      } else {
        // Validate reply — fail thì dùng safeFallback (3-layer pattern)
        const validation = validateReply(cleanedText, stateBeforeReply);
        if (!validation.valid) {
          const reasonsStr = validation.reasons.join(", ");
          console.warn(`[validator] FAIL — reasons: ${reasonsStr} → safe fallback`);
          cleanedText = safeFallback(stateBeforeReply);
          validatorResult = validation.reasons;
        }
      }

      await updateStateAfterReply(
        mastra,
        threadId,
        resourceId,
        obj.nextStep,
        { qrShown, mediaShown },
        cleanedText,
        message,
      );

      // ═══════════ PHASE 7 — Per-turn structured log ═══════════
      const stateAfterReply = await loadState(mastra, threadId, resourceId);
      logTurn({
        threadId,
        turn: stateAfterReply.turnCount,
        timestamp: new Date().toISOString(),
        message,
        flow: stateAfterReply.flow,
        stage: stateAfterReply.stage,
        classifier: {
          domain: intentSig?.domain ?? null,
          service: intentSig?.service ?? null,
          attribute: intentSig?.attribute ?? null,
          legacyTopic: stateAfterReply.intentTopic ?? null,
          emotion: stateAfterReply.emotion,
          intent: stateAfterReply.intent,
        },
        mode: prefixMode as PrefixMode,
        templateId,
        prefixChars: prefix.length,
        replyChars: cleanedText.length,
        hasMedia: hasMedia,
        hasQR: !!obj.qrUrl,
        validator: validatorResult,
        trackingCounts: {
          askedHistory: (stateAfterReply.askedHistory ?? []).length,
          mentionedFacts: (stateAfterReply.mentionedFacts ?? []).length,
        },
        durationMs: Date.now() - turnStart,
      });

      return {
        reply: cleanedText,
        mediaUrls: dedupedMediaUrls,
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
  execute: async ({ inputData, abortSignal }) => {
    console.error(
      `[router] flow không hợp lệ: "${inputData.flow}" — dùng fallback fitness`,
    );
    const { prefix, message, threadId, resourceId } = inputData;
    const fullMessage = [prefix, message].filter(Boolean).join("\n");
    const result = await fitnessAgent.generate(fullMessage, {
      maxSteps: 4,
      modelSettings: { temperature: 0.85, topP: 0.95 },
      abortSignal,
      memory: {
        thread: { id: threadId },
        resource: resourceId,
        options: { lastMessages: 8 },
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
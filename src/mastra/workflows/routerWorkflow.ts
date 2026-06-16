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
  detectMediaRequest,
  isTerseMessage,
  isBareGreetingOrFiller,
  computeDoubtMediaKey,
} from "../lib/prefixBuilder";
import { fetchMedia } from "../tools/media";
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
  secondaryAnswers: z
    .array(z.string())
    .nullable()
    .describe(
      "Mảng 1-2 câu NGẮN cover các SECONDARY intent khi prefix có hint [MULTI-INTENT]. " +
      "Mỗi entry là 1 câu hoàn chỉnh (vd: 'Phòng tập em mở 5h–22h ạ.'), KHÔNG trùng nội dung 'text' chính. " +
      "Null hoặc [] khi prefix KHÔNG có [MULTI-INTENT] hint (KH chỉ hỏi 1 thứ). " +
      "Post-process sẽ tự append vào cuối text — đừng tự nhét vào text."
    ),
});

/**
 * Salvage reply khi structured-output throw → fallback plain-text NHƯNG model vẫn in JSON thô
 * (bị prime bởi jsonPromptInjection ở lần generate đầu) → tránh rò `{"text":...,"mediaUrls":[...}`
 * ra cho khách (bug L5 T7/T8). result.object undefined + result.text là JSON → bóc field "text".
 * Dùng JSON.parse + string-ops (pure technical parsing), KHÔNG regex business-logic.
 */
function salvageReplyObject(raw: string): {
  text: string;
  mediaUrls: string[] | null;
  qrUrl: string | null;
  nextStep: "ask_info" | "show_media" | "show_qr" | "confirm" | "close" | null;
  secondaryAnswers: string[] | null;
} {
  const base = {
    text: raw ?? "",
    mediaUrls: null,
    qrUrl: null,
    nextStep: "close" as const,
    secondaryAnswers: null,
  };
  const t = (raw ?? "").trim();
  if (!t.startsWith("{")) return base;
  try {
    const o = JSON.parse(t);
    if (o && typeof o.text === "string") {
      return {
        text: o.text,
        mediaUrls: Array.isArray(o.mediaUrls) ? o.mediaUrls : null,
        qrUrl: typeof o.qrUrl === "string" ? o.qrUrl : null,
        nextStep: o.nextStep ?? "close",
        secondaryAnswers: Array.isArray(o.secondaryAnswers) ? o.secondaryAnswers : null,
      };
    }
  } catch {
    // JSON vỡ (model in dở) → bóc thủ công giá trị field "text".
  }
  const ki = t.indexOf('"text"');
  if (ki >= 0) {
    const colon = t.indexOf(":", ki + 6);
    const q1 = colon >= 0 ? t.indexOf('"', colon + 1) : -1;
    if (q1 >= 0) {
      let i = q1 + 1;
      let out = "";
      while (i < t.length) {
        const c = t[i];
        if (c === "\\" && i + 1 < t.length) {
          const nx = t[i + 1];
          out += nx === "n" ? "\n" : nx;
          i += 2;
          continue;
        }
        if (c === '"') break;
        out += c;
        i++;
      }
      if (out.trim()) return { ...base, text: out };
    }
  }
  return base;
}

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

    const secondaryCount = (llmResult.secondaryIntents ?? []).length;
    console.log(
      `[process] llm: flow=${llmResult.flow ?? "unchanged"} emotion=${llmResult.emotion} intent=${llmResult.intent} topic=${llmResult.intentTopic ?? "null"} secondary=${secondaryCount}`
    );
    if (secondaryCount > 0) {
      console.log(
        `[process] multi-intent secondary:`,
        (llmResult.secondaryIntents ?? []).map(
          (s) => `${s.domain}/${s.attribute ?? "—"}`,
        ),
      );
    }

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
  templateId: string | null,
  injectedGuardKey: string | null,
): Promise<void> {
  const needQR    = nextStep === "show_qr"    && !currentFlags.qrShown;
  // KHÔNG check !mediaShown ở đây — cho phép gửi media mới khi khách hỏi service khác.
  const needMedia = nextStep === "show_media";

  try {
    const current = await loadState(mastra, threadId, resourceId);
    // Ghi key vừa gửi vào mediaShownKeys (per-service tracking).
    const currentKeys = current.mediaShownKeys ?? [];
    let updatedKeys = currentKeys;
    if (injectedGuardKey) {
      // Doubt-media inject (deterministic): ghi guard sentinel + key thật để turn sau không gửi lại.
      const realKey = injectedGuardKey.startsWith("doubt:")
        ? injectedGuardKey.slice("doubt:".length)
        : injectedGuardKey;
      for (const k of [injectedGuardKey, realKey]) {
        if (!updatedKeys.includes(k)) updatedKeys = [...updatedKeys, k];
      }
    } else if (needMedia) {
      // Media do LLM tự gửi: ưu tiên key khách vừa mention (vd "zumba") rồi fallback theo state.
      const sentKey = detectMentionedServiceKey(customerMessage) ?? computeSuggestedMediaKey(current);
      if (sentKey && !updatedKeys.includes(sentKey)) updatedKeys = [...updatedKeys, sentKey];
    }
    // Phase 6: detect câu hỏi đã hỏi + fact đã pitch → cập nhật tracking sets.
    const tracking = updateTracking(current, botReply);
    // recentBotReplies: giữ tối đa 3 reply gần nhất (cho anti-parrot không-liền-kề ở cleanReply).
    const recent = (current.recentBotReplies ?? []).slice();
    if (botReply) {
      recent.push(botReply);
      while (recent.length > 3) recent.shift();
    }
    const updated = {
      ...current,
      qrShown:    needQR    ? true : current.qrShown,
      mediaShown: needMedia ? true : current.mediaShown,
      mediaShownKeys: updatedKeys,
      lastBotReply: botReply || current.lastBotReply,
      askedHistory: tracking.askedHistory,
      mentionedFacts: tracking.mentionedFacts,
      lastTemplateId: templateId ?? current.lastTemplateId ?? null,
      recentBotReplies: recent,
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
  "- 'nextStep': 'show_media' khi mediaUrls có dữ liệu, 'show_qr' khi qrUrl có dữ liệu, 'ask_info' khi hỏi tên/SĐT, 'confirm' khi tóm đơn, 'close' khi xong.\n" +
  "- 'secondaryAnswers': chỉ điền KHI prefix có hint [MULTI-INTENT: KH còn hỏi: X + Y]. " +
  "Mỗi entry 1 câu NGẮN cover 1 secondary intent (vd ['Phòng em mở 5h–22h ạ.', 'Có HLV nữ nha anh/chị.']). " +
  "KHÔNG nhét vào text — post-process sẽ append giúp. Null/[] khi không có hint MULTI-INTENT.";

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
            // DeepSeek không hỗ trợ response_format json_schema → inject schema vào
            // prompt + parse text (xem config/openai.ts). Bỏ dòng này = lỗi 'em gặp sự cố'.
            jsonPromptInjection: true,
            instructions: STRUCTURED_OUTPUT_INSTRUCTIONS,
          },
        });
      } catch (e) {
        // DeepSeek đôi khi trả JSON sai schema (STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED)
        // → structuredOutput throw, mất nguyên lượt. Fallback: generate PLAIN (không structured)
        // để vẫn có 1 câu trả lời tự nhiên (mất media/qr lượt đó, nhưng hội thoại không đứt).
        const eid = (e as any)?.id ?? (e as any)?.message ?? String(e);
        console.error(`[${id}] structured generate failed (${eid}) → fallback plain-text`);
        try {
          result = await agent.generate(fullMessage, {
            maxSteps: 1,
            modelSettings: { temperature: 0.7, topP: 0.95 },
            abortSignal,
            memory: {
              thread: { id: threadId },
              resource: resourceId,
              options: { lastMessages: 8 },
            },
          });
        } catch (e2) {
          console.error(`[${id}] plain-text fallback cũng fail:`, e2);
          throw e2;
        }
      }

      const obj = result.object ?? salvageReplyObject(result.text ?? "");

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

      // ═══════ NHỊP CỤT — chặn media chủ động (deterministic) ═══════
      // KH nhắn cụt (1-4 từ) mà KHÔNG xin xem ảnh → drop media dù agent lỡ gọi get-media.
      // Prefix đã bỏ [MEDIA] hint nhưng v4-pro đôi khi vẫn tự gọi tool → cần chặn cứng ở đây.
      // Set null TRƯỚC khi tính hasMedia → cleanReply tự strip luôn câu "em gửi hình" dangling.
      const customerWantsMedia =
        stateBeforeReply.intentTopic === "media_request" ||
        detectMediaRequest(message);
      if (
        dedupedMediaUrls &&
        isTerseMessage(message) &&
        !customerWantsMedia
      ) {
        console.log(
          `[nhịp] KH nhắn cụt ("${message.trim().slice(0, 20)}") → drop ${dedupedMediaUrls.length} media chủ động`,
        );
        dedupedMediaUrls = null;
      }

      // ═══════ MEDIA ĐÃ GỬI — chặn cứng spam (model tự gọi get-media lại) ═══════
      // Bug L5: model bơm media 3-4 lần dù mediaShown=true (block mềm trong prefix bị phớt).
      // Drop media model tự thêm khi: ĐÃ từng gửi + khách KHÔNG xin xem + KHÔNG nhắc DỊCH VỤ MỚI.
      // (Doubt-media inject chạy NGAY SAU vẫn tự bù đúng 1 lần cho moment nghi ngờ nếu cần.)
      if (dedupedMediaUrls && stateBeforeReply.mediaShown && !customerWantsMedia) {
        const mKey = detectMentionedServiceKey(message);
        const isNewSvc = mKey !== null && !(stateBeforeReply.mediaShownKeys ?? []).includes(mKey);
        if (!isNewSvc) {
          console.log(`[media-spam] đã gửi media trước → drop ${dedupedMediaUrls.length} media model tự thêm`);
          dedupedMediaUrls = null;
        }
      }

      // ═══════ DOUBT-MEDIA DETERMINISTIC (chống flaky tool-call) — CẢ 2 FLOW ═══════
      // Khách nghi ngờ kết quả (đọc emotion từ classifier) → media chứng minh là vũ khí chốt trust:
      // fitness=ảnh before-after, giai-co=ca mr-* trước/sau. gpt-5.4-mini phớt lệnh gọi get-media
      // (gửi khi không ai bảo, bỏ khi bảo gắt) → KHÔNG dựa vào LLM: fetch thẳng Cloudinary. Fetch
      // KỸ THUẬT (không cache); QUYẾT ĐỊNH gửi nằm ở classifier (emotion nghi ngờ), không heuristic.
      let effectiveNextStep = obj.nextStep;
      let injectedGuardKey: string | null = null;
      const doubtMedia = computeDoubtMediaKey(stateBeforeReply);
      if (
        doubtMedia &&
        !(stateBeforeReply.mediaShownKeys ?? []).includes(doubtMedia.guardKey)
      ) {
        try {
          const items = await fetchMedia(doubtMedia.key);
          const urls = items.map((it) => it.url).filter(Boolean);
          if (urls.length > 0) {
            dedupedMediaUrls = urls;
            effectiveNextStep = "show_media";
            injectedGuardKey = doubtMedia.guardKey;
            console.log(`[doubt-media] inject deterministic ${urls.length} media key=${doubtMedia.key} guard=${doubtMedia.guardKey}`);
          }
        } catch (e) {
          console.error("[doubt-media] deterministic fetch failed:", e);
        }
      }

      // Deterministic post-process: strip khen giả, fake media offer, filler, markdown,
      // pitch lặp (nếu prev đã list package).
      const hasMedia = !!(dedupedMediaUrls && dedupedMediaUrls.length > 0);
      let cleanedText = cleanReply(
        obj.text ?? "",
        hasMedia,
        prevReply,
        message,
        stateBeforeReply.recentBotReplies ?? [],
      );

      // ═══════ MULTI-INTENT — append secondaryAnswers (Fix #3) ═══════
      // Agent fill secondaryAnswers khi prefix có [MULTI-INTENT] hint.
      // Append vào cuối text để cover hết câu hỏi của KH trong CÙNG 1 reply,
      // dedup nếu trùng nội dung primary, bỏ entry rỗng. Max 2 entry để giữ ngắn.
      const rawSecondary = (obj as { secondaryAnswers?: string[] | null }).secondaryAnswers;
      if (Array.isArray(rawSecondary) && rawSecondary.length > 0) {
        const lowerText = cleanedText.toLowerCase();
        // Guard tuyệt đối: KHÔNG bao giờ append câu chào/cảm-ơn-đã-quan-tâm như secondary.
        // Câu chào đã nằm trong reply chính → append vào cuối = "mash" loạn (gym reply + "Dạ em chào...").
        // Đề phòng agent tự điền dù prefix đã lọc greeting khỏi MULTI-INTENT hint.
        const isGreetingLike = (s: string): boolean =>
          /(^|\b)(dạ\s+)?(em\s+)?chào\b/i.test(s) ||
          /cảm\s*ơn.{0,20}(đã\s+)?quan\s*tâm/i.test(s) ||
          /xin\s+chào/i.test(s);
        const extras = rawSecondary
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter((s) => s.length > 0)
          .filter((s) => !isGreetingLike(s))
          .filter((s) => !lowerText.includes(s.toLowerCase().slice(0, 20)))
          .slice(0, 2);
        if (extras.length > 0) {
          // Chỉ dùng space trơn khi text ĐÃ kết bằng dấu câu (. !). "ạ"/"nhé" là tiểu từ
          // kết câu nhưng KHÔNG phải dấu câu → vẫn cần ". " để tách câu, nếu không sẽ ra
          // run-on "...không ạ Buổi đầu..." (đúng pattern fitness.ts cấm). "?" đã bị cleanReply strip.
          const sep = /[.!]$/.test(cleanedText) ? " " : ". ";
          cleanedText = (cleanedText + sep + extras.join(" ")).trim();
          console.log(
            `[multi-intent] appended ${extras.length} secondary answer(s) → reply len=${cleanedText.length}`,
          );
        }
      }

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
        // Validate reply — fail thì dùng safeFallback (3-layer pattern).
        // Re-greeting/filler (KH chỉ "ới"/chào trống): reply CỰC NGẮN là ĐÚNG → bỏ length floor,
        // và nếu fail vì lý do khác thì fallback cũng phải NGẮN (KHÔNG đè template pitch dài).
        // allowShort cũng bật ở lượt ĐÓNG: retention (đã chốt) hoặc commitment khi khách nhắn cụt
        // (cảm ơn/chào tạm biệt) → câu chào ấm NGẮN ("Dạ vâng anh ạ") là ĐÚNG, đừng để floor 20
        // reject thành safeFallback lặp lại "giữ slot…" (bug L3 T18).
        const isReGreet = isBareGreetingOrFiller(message);
        const isClosingTurn =
          stateBeforeReply.stage === "retention" ||
          (stateBeforeReply.stage === "commitment" && isTerseMessage(message));
        const validation = validateReply(cleanedText, stateBeforeReply, {
          allowShort: isReGreet || isClosingTurn,
        });
        if (!validation.valid) {
          const reasonsStr = validation.reasons.join(", ");
          console.warn(`[validator] FAIL — reasons: ${reasonsStr} → safe fallback`);
          cleanedText = isReGreet
            ? "Dạ em đây ạ"
            : safeFallback(stateBeforeReply, message);
          validatorResult = validation.reasons;
        }
      }

      await updateStateAfterReply(
        mastra,
        threadId,
        resourceId,
        effectiveNextStep,
        { qrShown, mediaShown },
        cleanedText,
        message,
        templateId,
        injectedGuardKey,
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
          secondaryCount: (stateAfterReply.secondaryIntents ?? []).length,
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
        jsonPromptInjection: true, // DeepSeek: không json_schema (xem config/openai.ts)
        instructions: STRUCTURED_OUTPUT_INSTRUCTIONS,
      },
    });
    const obj = result.object ?? salvageReplyObject(result.text ?? "");
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
/**
 * pipeline.ts — MỘT lượt hội thoại của bản gemma4:12b, dùng CHUNG cho cả 3 nơi:
 *   • engine/gemmaBrain.ts  (prod, ENGINE=gemma qua Facebook)
 *   • vnlink-gemma4/run.ts  (chạy 16 kịch bản test luồng dài)
 *   • vnlink-gemma4/serve.ts (trang chat tay)
 *
 * Trước đây 3 file chép tay cùng một pipeline → trôi lệch nhau (bảng giá giáo viên chỉ có
 * ở 1 bản). Giờ chỉ còn 1 nguồn: test chạy ĐÚNG code mà prod chạy.
 *
 * File này chỉ còn NHỊP (song ánh với engine/brain.ts của bản 5.4), chi tiết ở module riêng:
 *   1. classifier LLM hiểu khách + chọn bộ ảnh      → classifier.ts
 *   2. FSM thuần code chuyển trạng thái             → state.ts
 *   3. cổng ảnh deterministic                       → mediaGate.ts
 *   4. system prompt theo nhánh + khối bối cảnh     → prompt.ts / state.ts / pricing.ts
 *   5. soát bản nháp, sinh lại 1 lần nếu phạm luật  → draftRules.ts
 *   6. hậu xử lý văn phong dùng chung với 5.4       → lib/cleanReply.ts + lib/replyGuards.ts
 * Gọi model (endpoint/key/retry) nằm ở llm.ts; mọi phép tính thứ-ngày ở dates.ts.
 */

import { cleanReply } from "../../lib/cleanReply";
import {
  ensureMediaCaption,
  lockHonorific,
  softenPrematureClose,
  stripQrMention,
  stripStaleGreeting,
} from "../../lib/replyGuards";
import { CLS_SCHEMA, buildClassifierMessages, type Classification } from "./classifier";
import { buildDateBlock, resolveDayLabel, resolveDayOptions } from "./dates";
import { reviewDraft } from "./draftRules";
import { callChat, callJson, resolveLlmConfig, type ChatMsg, type LlmConfig } from "./llm";
import { decideMedia } from "./mediaGate";
import { buildSystemPrompt, type GemmaFlow } from "./prompt";
import type { PriceBucket } from "./pricing";
import { buildTurnContext, updateState, type ConvState } from "./state";
import { extractQuestions, norm, stripMediaLine } from "./text";

// gemmaBrain.ts cần toGuardKey để ghi sổ ảnh vào state prod — re-export cho nó khỏi phải biết
// bố cục module bên trong. Các hàm khác của nhánh gemma thì import thẳng từ module gốc.
export { toGuardKey } from "./mediaGate";

export type Msg = { role: "user" | "assistant"; content: string };

const TEMP = 0.3;
/** Nhiệt cao hơn khi sinh lại: bản nháp cũ đã hỏng, cần model đi hướng khác hẳn. */
const TEMP_REGEN = 0.7;
const HISTORY_MSGS = 16;
const MAX_CLS_TOKENS = 450;
const MAX_REPLY_TOKENS = 500;
/** Sổ câu hỏi đã dùng — giữ 30 câu gần nhất là đủ chống lặp, không phình state lưu DB. */
const ASKED_MEMORY = 30;

/** Xưng hô dạng chuỗi mà replyGuards hiểu ("anh" | "chị" | khác = chưa rõ). */
function honorificOf(conv: ConvState): string {
  return conv.xung === "anh" ? "anh" : conv.xung === "chi" ? "chị" : "anh/chị";
}

export interface TurnOutcome {
  reply: string;
  /** Bộ ảnh hệ thống quyết gửi lượt này (đã chặn tin đầu + dedup). null = không gửi. */
  mediaKey: string | null;
  cls: Classification | null;
  notes: string[];
  clsSeconds: number;
  genSeconds: number;
}

/**
 * Bước "đưa khách chọn 1 trong 2 ngày" (luật CHỐT LỊCH #2): khi khách nói khung mơ hồ, HOẶC
 * đã hỏi mở 1 lượt mà khách vẫn chưa ra ngày. Ngày do code tính, model chỉ việc chép.
 */
function dayOptionsFor(conv: ConvState, cls: Classification | null): string[] {
  const need = conv.wantsCome && !conv.ngayChot && (!!cls?.khung_ngay || conv.wantsComeTurns >= 2);
  return need ? resolveDayOptions(cls?.khung_ngay ?? "") : [];
}

export async function runGemmaTurn(opts: {
  conv: ConvState;
  /** Lịch sử thô (không kèm khối [BỐI CẢNH]) — hàm này TỰ push user + assistant khi xong. */
  history: Msg[];
  message: string;
  /** guardKey ảnh đã gửi ở nơi khác (state prod) — để không gửi trùng khi đổi engine. */
  alreadySentGuardKeys?: string[];
  endpoint?: string;
  model?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TurnOutcome> {
  const { conv, history, message } = opts;
  const cfg = resolveLlmConfig(opts);
  const notes: string[] = [];
  const prevBotReply = [...history].reverse().find((m) => m.role === "assistant")?.content ?? "";

  // 1. classifier — hiểu khách + chọn bộ ảnh
  const { cls, seconds: clsSeconds } = await classify(conv, prevBotReply, message, cfg, notes);

  // 2. FSM thuần code
  if (cls) updateState(conv, cls, resolveDayLabel(cls.ngay_hen_chuan ?? ""));
  else conv.turnCount += 1;

  // 3. cổng ảnh deterministic
  const media = decideMedia(conv, cls?.media ?? null, opts.alreadySentGuardKeys);
  if (media.note) notes.push(media.note);

  // 3b. SĐT gõ dở, khách không hỏi gì khác → tin này CHỈ có đúng một nội dung đúng, code viết thẳng.
  // Dặn bằng prompt không giữ được: cả 2 vòng test, chỉ thị ⛔⛔ nằm ngay đầu khối mà 12B vẫn đáp
  // "em nhận được số điện thoại của mình rồi ạ" cho một số 7 chữ số — khách tưởng xong, thực tế
  // chưa có gì. Ý ĐỊNH của khách vẫn do classifier quyết (các cờ dưới đây); code chỉ viết câu.
  const chiDuaSdtHong =
    conv.sdtThieuSo &&
    !conv.hoiGiaTurn &&
    !conv.hoiThongTinTurn &&
    !conv.keDauTurn &&
    !conv.ngoaiPhamViTurn &&
    !conv.doiNguoiThatTurn;
  if (chiDuaSdtHong) {
    const xung = honorificOf(conv);
    const Xung = xung.charAt(0).toUpperCase() + xung.slice(1);
    const reply =
      `Dạ số của mình hình như còn thiếu vài số, ${xung} gửi lại giúp em số đầy đủ với ạ.` +
      (conv.ten ? "" : ` ${Xung} cho em xin thêm tên để em giữ chỗ luôn ạ.`);
    notes.push("tin do code viết (SĐT thiếu số)");
    history.push({ role: "user", content: message }, { role: "assistant", content: reply });
    return { reply, mediaKey: null, cls, notes: [...new Set(notes)], clsSeconds, genSeconds: 0 };
  }

  // 4-6. sinh reply → hậu xử lý văn phong → soát (sinh lại tối đa 1 lần)
  // ⚠ polish CHẠY BÊN TRONG vòng soát: luật phải soi đúng chuỗi khách nhận, vì cleanReply cắt
  // tin quá dài ở ranh giới câu và có thể xoá mất chính con số mà luật vừa ép model viết ra.
  const flow: GemmaFlow = conv.flow === "giai-co" ? "giai-co" : "fitness";
  const finalize = (draft: string): string =>
    polish(draft, { conv, message, history, flow, mediaKey: media.mediaKey, prevBotReply, notes });

  const draftRun = await draftReply({
    conv,
    history,
    message,
    flow,
    mediaKey: media.mediaKey,
    priceBucket: (cls?.gia_hoi_ve ?? "") as PriceBucket,
    dayOptions: dayOptionsFor(conv, cls),
    cfg,
    notes,
    finalize,
  });
  const reply = draftRun.reply;

  // ⚠ Nhặt câu hỏi từ BẢN NHÁP, không phải tin đã polish: cleanReply strip sạch dấu "?" (luật
  // văn phong 5.4) nên soi sau đó sẽ không bắt được câu nào → sổ chống-lặp rỗng vĩnh viễn.
  const askedThisTurn = extractQuestions(draftRun.draft);

  // 7. sổ câu hỏi đã dùng + cờ sau-chốt + lịch sử
  for (const q of askedThisTurn) conv.askedQuestions.push({ raw: q, norm: norm(q) });
  if (conv.askedQuestions.length > ASKED_MEMORY) {
    conv.askedQuestions = conv.askedQuestions.slice(-ASKED_MEMORY);
  }
  if (!conv.closed && conv.ngayChot && conv.ten && conv.sdt) conv.closed = true;

  history.push({ role: "user", content: message }, { role: "assistant", content: reply });

  // polish chạy vài lần trong vòng soát nên ghi chú của nó có thể lặp — gộp lại cho dễ đọc log.
  return {
    reply,
    mediaKey: media.mediaKey,
    cls,
    notes: [...new Set(notes)],
    clsSeconds,
    genSeconds: draftRun.seconds,
  };
}

// ── các bước ──────────────────────────────────────────────────────────────────

/** Classifier hỏng KHÔNG làm hỏng lượt: FSM giữ nguyên trạng thái cũ, bot vẫn trả lời được. */
async function classify(
  conv: ConvState,
  prevBotReply: string,
  message: string,
  cfg: LlmConfig,
  notes: string[],
): Promise<{ cls: Classification | null; seconds: number }> {
  try {
    const r = await callJson<Classification>(
      buildClassifierMessages(conv, prevBotReply, message),
      CLS_SCHEMA,
      { maxTokens: MAX_CLS_TOKENS },
      cfg,
    );
    return { cls: r.value, seconds: r.seconds };
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    notes.push(`classifier lỗi: ${(e as Error)?.message}`);
    console.error("[gemma] classifier failed (FSM giữ trạng thái cũ):", (e as Error)?.message);
    return { cls: null, seconds: 0 };
  }
}

/** Sinh bản nháp → polish → soát bằng draftRules; phạm luật thì sinh lại ĐÚNG 1 lần. */
async function draftReply(p: {
  conv: ConvState;
  history: Msg[];
  message: string;
  flow: GemmaFlow;
  mediaKey: string | null;
  priceBucket: PriceBucket;
  dayOptions: string[];
  cfg: LlmConfig;
  notes: string[];
  /** cleanReply + guard — biến bản nháp thành đúng chuỗi khách nhận. */
  finalize: (draft: string) => string;
}): Promise<{ draft: string; reply: string; seconds: number }> {
  const system = buildSystemPrompt(buildDateBlock(), p.flow);
  const context = buildTurnContext(p.conv, {
    mediaKey: p.mediaKey,
    dayOptions: p.dayOptions,
    priceBucket: p.priceBucket,
  });
  const messages = (extraDirective?: string): ChatMsg[] => [
    { role: "system", content: system },
    ...p.history.slice(-HISTORY_MSGS),
    {
      role: "user",
      content: `${context}${extraDirective ? `\n${extraDirective}` : ""}\n\n[TIN KHÁCH]\n${p.message}`,
    },
  ];

  const askedNorms = p.conv.askedQuestions.map((q) => q.norm);
  const prevReplyNorms = p.history.filter((m) => m.role === "assistant").map((m) => norm(m.content));
  const review = (draft: string, final: string) =>
    reviewDraft({ conv: p.conv, draft, final, askedNorms, prevReplyNorms });

  let r = await callChat(messages(), { temperature: TEMP, maxTokens: MAX_REPLY_TOKENS }, p.cfg);
  let draft = stripMediaLine(r.text);
  let seconds = r.seconds;

  let reply = p.finalize(draft);
  const verdict = review(draft, reply);
  if (!verdict) return { draft, reply, seconds };

  p.notes.push(verdict.note);
  r = await callChat(
    messages(verdict.directive),
    { temperature: TEMP_REGEN, maxTokens: MAX_REPLY_TOKENS },
    p.cfg,
  );
  seconds += r.seconds;
  const retry = stripMediaLine(r.text);
  // Bản sinh lại rỗng thì giữ bản nháp đầu — tin trắng tệ hơn tin phạm luật văn phong.
  if (retry.length >= 15) draft = retry;
  else p.notes.push("bản sinh lại rỗng → giữ bản nháp đầu");

  const repaired = verdict.repair?.(draft);
  if (repaired) {
    draft = repaired.text;
    p.notes.push(repaired.note);
  }
  reply = p.finalize(draft);
  return { draft, reply, seconds };
}

/** Hậu xử lý văn phong: cleanReply + 4 guard của bản 5.4, kèm 2 lưới an toàn riêng của gemma. */
function polish(
  draft: string,
  p: {
    conv: ConvState;
    message: string;
    history: Msg[];
    flow: GemmaFlow;
    mediaKey: string | null;
    prevBotReply: string;
    notes: string[];
  },
): string {
  const { conv, mediaKey } = p;
  const honorific = honorificOf(conv);
  const hasMedia = !!mediaKey;
  const recentBotReplies = p.history
    .filter((m) => m.role === "assistant")
    .map((m) => m.content)
    .slice(-4);

  let reply = cleanReply(draft, hasMedia, p.prevBotReply, p.message, recentBotReplies);
  // ⚠ cleanReply có nhánh HARD-LOOP: reply gần trùng tin cũ → thay TRẮNG bằng câu mẫu
  // "phần này em vừa chia sẻ ở trên rồi…". Ở gemma nhánh đó nguy hiểm hơn bên 5.4 vì ta ĐÃ
  // sinh lại một lần trước đó: bắt được ca khách hỏi "thế gói yoga nhiêu" mà bot đáp câu mẫu
  // → NÉ HẲN câu hỏi giá, mất đơn. Dính câu mẫu thì bỏ lớp anti-loop, giữ nội dung thật.
  if (reply.startsWith("Dạ phần này em vừa chia sẻ ở trên rồi")) {
    p.notes.push("bỏ pivot HARD-LOOP để không né câu khách hỏi");
    reply = cleanReply(draft, hasMedia, "", p.message, []);
  }
  if (conv.turnCount > 1) reply = stripStaleGreeting(reply, conv.closed, honorific);
  if (hasMedia) reply = ensureMediaCaption(reply, mediaKey, honorific);
  reply = stripQrMention(reply);
  reply = lockHonorific(reply, honorific);
  const hasContact = !!(conv.ten && conv.sdt);
  reply = softenPrematureClose(reply, {
    flow: p.flow,
    intent: conv.ngayChot && hasContact ? "ready" : conv.wantsCome || conv.gioHen ? "selecting" : "explore",
    preferredTime: conv.gioHen || conv.ngayChot || null,
    hasContact,
    honorific,
  });

  // Lưới cuối: sau mọi guard mà reply rỗng thì trả lại bản nháp — TUYỆT ĐỐI không để khách
  // nhận tin trắng (facebook.ts gửi đúng cái gì mình trả về).
  if (!reply.trim() && draft.trim()) {
    p.notes.push("reply rỗng sau guard → dùng lại bản nháp");
    return draft.trim();
  }
  return reply;
}

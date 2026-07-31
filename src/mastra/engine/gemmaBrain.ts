/**
 * engine/gemmaBrain.ts — bộ não gemma4:12b SELF-HOST (ENGINE=gemma).
 *
 * File này giờ CHỈ còn phần "gắn vào hệ prod": load/save state, fetch ảnh Cloudinary,
 * map sang ConversationState để Sheets + followup + admin chạy y nguyên.
 * Toàn bộ NHỊP HỘI THOẠI (classifier → FSM → cổng ảnh → sinh reply → guard văn phong)
 * nằm ở `engine/gemma/pipeline.ts` — dùng CHUNG với harness test (vnlink-gemma4/run.ts,
 * serve.ts) để test chạy đúng code prod, không còn 3 bản chép tay trôi lệch nhau.
 *
 * Tích hợp seam ENGINE (facebook.ts): trả CÙNG shape { reply, mediaUrls, qrUrl }.
 *   • Media: classifier quyết bộ ảnh (cổng deterministic như bản 5.4) → fetchMedia (Cloudinary).
 *   • Lead: tên/SĐT/ngày chốt từ FSM gemma được map vào ConversationState.knownInfo
 *     → tryWriteLeadIfReady (ghi Google Sheets) + followup ở facebook.ts chạy y nguyên.
 *   • QR: gemma-mode KHÔNG gửi QR (kịch bản sale cấm gợi thanh toán sau chốt) → luôn null.
 *
 * Trạng thái hội thoại gemma (ConvState + history thô) lưu ở thread metadata riêng
 * `<threadId>-gemma-state` — không đụng FSM state cũ (`-fsm-state`) để rollback ENGINE
 * về legacy/agent là state GPT còn nguyên.
 *
 * Env:  GEMMA_ENDPOINT (mặc định http://127.0.0.1:11439/api/chatplus — qua reverse tunnel
 *       tới máy GPU), GEMMA_MODEL (mặc định gemma4:12b).
 */

import { loadState, saveState } from "../lib/stateStore";
import type { ConversationState, KnownInfo } from "../lib/stateMachine";
import { isLeadComplete } from "../lib/sheetsWriter";
import { fetchMedia } from "../tools/media";
import { newState, type ConvState } from "./gemma/state";
import { runGemmaTurn as runPipelineTurn, toGuardKey, type Msg } from "./gemma/pipeline";

export interface BrainOutput {
  reply: string;
  mediaUrls: string[] | null;
  qrUrl: string | null;
}

// ── store trạng thái gemma (thread metadata riêng, không đụng -fsm-state) ─────

const STORE_NAME = "memory";
const GEMMA_SUFFIX = "-gemma-state";

async function loadGemma(
  mastra: any,
  threadId: string,
): Promise<{ conv: ConvState; history: Msg[] }> {
  try {
    const storage = mastra?.getStorage?.();
    const store = storage ? await storage.getStore(STORE_NAME) : null;
    const thread = store ? await store.getThreadById({ threadId: threadId + GEMMA_SUFFIX }) : null;
    const m = thread?.metadata as any;
    if (m?.conv) {
      return {
        // merge lên newState: field mới thêm sau này có default, state cũ không vỡ
        conv: { ...newState(), ...m.conv },
        history: Array.isArray(m.history) ? m.history : [],
      };
    }
  } catch (e) {
    console.error("[gemma] loadGemma failed — dùng state mới:", e);
  }
  return { conv: newState(), history: [] };
}

async function saveGemma(
  mastra: any,
  threadId: string,
  resourceId: string,
  conv: ConvState,
  history: Msg[],
): Promise<void> {
  try {
    const storage = mastra?.getStorage?.();
    const store = storage ? await storage.getStore(STORE_NAME) : null;
    if (!store) {
      console.error("[gemma] saveGemma: store không khả dụng — state KHÔNG được lưu");
      return;
    }
    await store.saveThread({
      thread: {
        id: threadId + GEMMA_SUFFIX,
        resourceId,
        title: "gemma-state",
        // history cap 24 tin (12 lượt) — đủ ngữ cảnh trong num_ctx, không phình DB
        metadata: { conv, history: history.slice(-24) } as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[gemma] saveGemma failed:", e);
  }
}

// Hàng đợi nối tiếp theo threadId: 2 tin echo/off-message đến gần nhau (vd khách gõ liền 2 tin
// lúc AI tắt) mà cùng load→sửa→save `history` KHÔNG xếp hàng thì lượt 2 load state CŨ (chưa
// thấy ghi của lượt 1) → save đè mất lượt 1 (lost update). Cùng kiểu nguy cơ mà silentClassify.ts
// đã xử lý cho classify (xem `chains` ở đó) — áp dụng lại đây cho riêng history của gemma.
const appendChains = new Map<string, Promise<void>>();

/**
 * Nối thêm tin vào lịch sử RIÊNG của gemma mà KHÔNG qua 1 lượt hội thoại đầy đủ (không classify,
 * không sinh reply) — dùng cho facebook.ts khi:
 *   (1) nhân viên trả lời tay qua FB inbox lúc AI tắt/xen ngang (source:"staff")
 *   (2) khách nhắn lúc AI đang tắt (role:"user", không cần source)
 * Thiếu bước này thì gemma (bộ não LIVE) không bao giờ thấy những gì thực sự đã xảy ra trong
 * lúc AI tắt — bật lại có thể hỏi lại/lặp lại đúng thứ nhân viên vừa nói. Cap -24 giống saveGemma.
 * Xếp hàng theo threadId (xem appendChains) để 2 lệnh gọi gần nhau không đè mất nhau.
 * Best-effort — lỗi không được chặn webhook.
 */
export async function appendGemmaHistory(
  mastra: any,
  threadId: string,
  resourceId: string,
  entries: Msg[],
): Promise<void> {
  const prev = appendChains.get(threadId) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // lỗi lượt trước không chặn lượt sau
    .then(async () => {
      const { conv, history } = await loadGemma(mastra, threadId);
      await saveGemma(mastra, threadId, resourceId, conv, [...history, ...entries].slice(-24));
    })
    .catch((e) => {
      console.error(`[gemma] appendGemmaHistory failed for ${threadId}:`, e);
    });
  appendChains.set(threadId, next);
  void next.finally(() => {
    if (appendChains.get(threadId) === next) appendChains.delete(threadId);
  });
  return next;
}

// ── tin nhắc chủ động (followup) ──────────────────────────────────────────────

/**
 * Sinh TIN NHẮC bằng CHÍNH bộ não gemma (không phải agent 5.4).
 *
 * Vì sao cần: facebook.ts:generateFollowupReply luôn gọi `fitnessBrainAgent` (gpt-5.4 + prompts.ts)
 * kể cả khi ENGINE=gemma → khách đang được gemma tư vấn lại nhận tin nhắc do một model khác viết,
 * theo bảng kiến thức khác. Đo LIVE 26/07 (convo 27608560335468856): tin nhắc nói "bể mở từ 6h
 * đến 20h" trong khi giờ thật là 20h30 — sai vì prompts.ts của 5.4 còn số cũ.
 *
 * KHÔNG chạy classifier và KHÔNG đụng state: khách chưa nói gì mới, phân loại lại chỉ tốn ~7s GPU
 * và có nguy cơ coi chính chỉ thị nội bộ là lời khách. Chỉ 1 lần gọi model, có ngân sách token nhỏ.
 * Trả null = không có gì đáng nhắc → caller im lặng.
 */
/**
 * Chỉ thị nhắc RIÊNG cho gemma, mỗi lần nhắc một GÓC KHÁC.
 *
 * ⚠ Bản chỉ thị viết cho gpt-5.4 (facebook.ts) đưa nguyên si sang gemma thì 12B chọn cửa
 * "__IMLANG__" 3/3 lần ở mọi ngữ cảnh test → tính năng nhắc chết hẳn. 12B cần lệnh THẲNG
 * ("cứ nhắn 1 câu, chỉ im khi thật sự không nên nhắn") + góc nhìn cụ thể cho từng lần,
 * nếu không 3 lần nhắc sẽ ra 3 câu na ná nhau (đo được: cả 3 đều là "bể có mái che…").
 */
function chiThiNhacGemma(knownLine: string, attempt: number): string {
  const goc = [
    "một chi tiết CỤ THỂ có ích bám đúng mạch vừa nói (thứ khách đang cân nhắc, điều gì tiện cho họ)",
    "hỏi nhẹ MỘT câu xem mình còn băn khoăn gì để em giải đáp thêm",
    "mời khách ghé qua xem cơ sở / tập thử một buổi, nhẹ nhàng, không giục",
  ][Math.min(attempt, 2)];
  return (
    `${knownLine}` +
    `[VIỆC CỦA EM LÚC NÀY — khách chưa trả lời tin trước, em chủ động nhắn THÊM 1 TIN. ` +
    `Viết ĐÚNG 1 CÂU NGẮN, đời thường, ấm như nhân viên thật: ${goc}. ` +
    `KHÔNG lặp lại câu hỏi/lời mời vừa gửi, KHÔNG lặp ý các tin nhắc trước, KHÔNG marketing sáo rỗng, KHÔNG xin lỗi vì nhắn lại, KHÔNG giục chốt, KHÔNG nhắc lại giá. ` +
    `CHỈ trả về đúng từ __IMLANG__ khi thật sự KHÔNG NÊN nhắn gì (khách đã chốt xong, khách bảo đừng nhắn nữa) — còn lại cứ nhắn 1 câu. ` +
    `Kết "ạ".]`
  );
}

export async function runGemmaFollowup(opts: {
  mastra: any;
  threadId: string;
  /** Dòng "Đã biết về khách: …" do facebook.ts dựng ("" nếu chưa biết gì). */
  knownLine: string;
  /** Lần nhắc thứ mấy (0-based) — mỗi lần một góc khác nhau. */
  attempt: number;
}): Promise<string | null> {
  const { mastra, threadId } = opts;
  const chiThi = chiThiNhacGemma(opts.knownLine, opts.attempt);
  const { conv, history } = await loadGemma(mastra, threadId);
  const { callChat, resolveLlmConfig } = await import("./gemma/llm");
  const { buildDateBlock } = await import("./gemma/dates");
  const { buildSystemPrompt } = await import("./gemma/prompt");
  const { stripMediaLine } = await import("./gemma/text");
  const { cleanReply } = await import("../lib/cleanReply");
  const { lockHonorific } = await import("../lib/replyGuards");

  const flow = conv.flow === "giai-co" ? "giai-co" : "fitness";
  const r = await callChat(
    [
      { role: "system", content: buildSystemPrompt(buildDateBlock(), flow) },
      ...history.slice(-8),
      { role: "user", content: chiThi },
    ],
    { temperature: 0.7, maxTokens: 220 },
    // timeout ngắn hơn lượt thật: tin nhắc trễ 3 phút thì vô nghĩa, thà bỏ lượt nhắc.
    resolveLlmConfig({ timeoutMs: 60_000 }),
  );
  const raw = stripMediaLine(r.text).trim();
  if (!raw || raw.includes("__IMLANG__")) return null;
  const honorific = conv.xung === "anh" ? "anh" : conv.xung === "chi" ? "chị" : "anh/chị";
  const recent = history.filter((m) => m.role === "assistant").map((m) => m.content).slice(-4);
  const cleaned = lockHonorific(cleanReply(raw, false, recent.at(-1) ?? "", "", recent), honorific);
  return cleaned.trim().length >= 5 ? cleaned.trim() : null;
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function runGemmaTurn(opts: {
  mastra: any;
  message: string;
  threadId: string;
  resourceId: string;
  abortSignal?: AbortSignal;
}): Promise<BrainOutput> {
  const { mastra, message, threadId, resourceId, abortSignal } = opts;
  const turnStart = Date.now();

  const prodState = await loadState(mastra, threadId, resourceId);
  const { conv, history } = await loadGemma(mastra, threadId);
  const prodShown = prodState.mediaShownKeys ?? [];

  const out = await runPipelineTurn({
    conv,
    history,
    message,
    alreadySentGuardKeys: prodShown,
    abortSignal,
    timeoutMs: 120_000,
  });
  const { reply, mediaKey, cls, notes } = out;

  console.log(
    `[gemma] cls: flow=${conv.flow} xưng=${conv.xung} hỏi-giá=${conv.hoiGiaTurn} chê-đắt=${conv.cheDatTurn} media=${cls?.media ?? "—"} ` +
      `đến=${conv.wantsCome} ngày=${conv.ngayChot || "—"} an-toàn=${conv.anToan} chốt=${conv.closed}` +
      (notes.length ? ` · ${notes.join(" · ")}` : ""),
  );

  // ── ảnh: key đã được cổng deterministic duyệt → lấy URL thật từ Cloudinary ──
  let mediaUrls: string[] | null = null;
  let sentGuardKey: string | null = null;
  if (mediaKey) {
    try {
      const items = await fetchMedia(mediaKey);
      const urls = items.map((it) => it.url).filter(Boolean);
      if (urls.length) {
        mediaUrls = urls;
        sentGuardKey = toGuardKey(mediaKey);
      }
    } catch (e) {
      console.error("[gemma] fetchMedia failed:", (e as Error)?.message);
    }
    if (!mediaUrls) {
      // không lấy được ảnh → trả key về sổ để lượt sau còn cơ hội gửi
      conv.mediaSent = conv.mediaSent.filter((k) => k !== toGuardKey(mediaKey));
    }
  }

  await saveGemma(mastra, threadId, resourceId, conv, history);

  // ── map sang ConversationState prod: Sheets + followup + admin chạy y nguyên ──
  const next: ConversationState = { ...prodState };
  next.turnCount = (prodState.turnCount ?? 0) + 1;
  next.lastUserMessage = message;
  if (conv.flow !== "chua-ro") next.flow = conv.flow;
  if (conv.xung === "anh") next.honorific = "anh";
  else if (conv.xung === "chi") next.honorific = "chị";
  const info: KnownInfo = { ...prodState.knownInfo };
  if (conv.ten) info.name = conv.ten;
  if (conv.sdt) info.phone = conv.sdt;
  if (conv.boMon) info.serviceType = conv.boMon;
  if (conv.mucTieu) info.fitnessGoal = conv.mucTieu;
  if (conv.theTrang) info.bodyStats = conv.theTrang;
  if (conv.vungDau) info.painArea = conv.vungDau;
  if (conv.tinhChatDau) info.painSpread = conv.tinhChatDau;
  if (conv.thoiGianDau) info.painDuration = conv.thoiGianDau;
  if (conv.doiTuong !== "chua-ro") info.memberType = conv.doiTuong;
  if (conv.gioHen || conv.ngayChot) {
    // preferredTime = mốc giờ/buổi khách nêu; chưa có giờ thì dùng nhãn ngày (facebook.ts đọc
    // field này để TẮT tin nhắc khi khách đã chốt lịch).
    // ⚠ Bỏ vế giờ khi nó đã nằm sẵn trong nhãn ngày — 12B thỉnh thoảng nhét "chủ nhật" vào
    // gio_hen, ghép thẳng ra "chủ nhật Chủ nhật 26/07" rồi trôi nguyên vào Google Sheets.
    const gio = conv.gioHen.trim();
    const ngay = conv.ngayChot.trim();
    const trung = !!gio && !!ngay && ngay.toLowerCase().includes(gio.toLowerCase());
    info.preferredTime = (trung ? [ngay] : [gio, ngay]).filter(Boolean).join(" ");
  }
  if (conv.ngayChot) {
    // "Chủ nhật 26/07" → appointmentDate "26/07" (appointmentDateKey lấy 5 ký tự đầu)
    const parts = conv.ngayChot.trim().split(" ");
    const datePart = parts[parts.length - 1];
    if (datePart.includes("/")) info.appointmentDate = datePart;
  }
  next.knownInfo = info;
  next.intent = isLeadComplete(next) ? "ready" : conv.wantsCome ? "selecting" : "explore";
  next.stage = isLeadComplete(next)
    ? (next.sheetsWritten ? "retention" : "commitment")
    : prodState.stage;
  if (sentGuardKey) {
    next.mediaShown = true;
    if (!prodShown.includes(sentGuardKey)) next.mediaShownKeys = [...prodShown, sentGuardKey];
  }
  next.lastBotReply = reply;
  next.lastReplySource = "bot";
  next.recentBotReplies = [...(prodState.recentBotReplies ?? []), reply].slice(-4);
  next.recentUserMessages = [...(prodState.recentUserMessages ?? []), message].slice(-5);
  // reset bộ đếm follow-up khi funnel THẬT SỰ tiến triển (state-diff, không keyword)
  const infoCount = (k: KnownInfo) =>
    Object.values(k).filter((v) => v !== null && v !== undefined && `${v}`.trim()).length;
  const advanced =
    next.flow !== prodState.flow ||
    next.stage !== prodState.stage ||
    next.intent !== prodState.intent ||
    infoCount(next.knownInfo) > infoCount(prodState.knownInfo);
  next.followupCount = advanced ? 0 : (prodState.followupCount ?? 0);
  await saveState(mastra, threadId, resourceId, next);

  console.log(
    `[gemma] turn xong ${Date.now() - turnStart}ms (cls ${out.clsSeconds.toFixed(1)}s + gen ${out.genSeconds.toFixed(1)}s): ` +
      `replyLen=${reply.length} media=${mediaKey ?? "—"} lead=${info.name ?? "—"}/${info.phone ?? "—"}/${info.preferredTime ?? "—"}`,
  );
  return { reply, mediaUrls, qrUrl: null };
}

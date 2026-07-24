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
    `[gemma] cls: flow=${conv.flow} xưng=${conv.xung} hỏi-giá=${conv.hoiGiaTurn} media=${cls?.media ?? "—"} ` +
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

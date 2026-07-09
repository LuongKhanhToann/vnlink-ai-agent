/**
 * engine/brain.ts — bộ não engine mới (thay classifier + stateMachine + prefixBuilder + routerWorkflow).
 *
 * 1 turn = 2 lần gọi LLM (bằng legacy): (1) turnRouter chọn nhánh + bộ ảnh, (2) brain-agent sinh reply + gọi tool.
 * Không FSM, không prefix overlay động. Phần deterministic:
 *   • media       → turnRouter quyết THẲNG bộ ảnh → fetchMedia cưỡng chế (chống trùng 1 lần/cuộc).
 *                   KHÔNG phó mặc reply-agent gọi tool (model nhỏ hay bỏ nhịp gửi ảnh).
 *   • recordLead  → (tool) merge slot vào knownInfo (dedup/ghi Sheets do facebook.ts:tryWriteLeadIfReady lo — GIỮ NGUYÊN)
 *   • sendQR      → (tool) resolve qrUrl (chặn nếu chưa có tên+SĐT)
 * State snapshot ghi lại đúng khung cũ → followup + dedup ở facebook.ts chạy y nguyên.
 *
 * Output KHỚP seam cũ: { reply, mediaUrls, qrUrl } — facebook.ts chỉ thêm 1 nhánh if(ENGINE).
 */

import { z } from "zod";
import { loadState, saveState } from "../lib/stateStore";
import type { ConversationState, KnownInfo } from "../lib/stateMachine";
import { isLeadComplete } from "../lib/sheetsWriter";
import { cleanReply } from "../lib/cleanReply";
import {
  ensureMediaCaption,
  lockHonorific,
  stripQrMention,
  stripStaleGreeting,
  softenGiaiCoPrematureClose,
} from "../lib/replyGuards";
import { fetchMedia } from "../tools/media";
import { fitnessBrainAgent, giaiCoBrainAgent, flowRouterAgent } from "./agents";

type Flow = "fitness" | "giai-co";

/** 9 bộ ảnh + "none" — turnRouter chọn THẲNG (cổng deterministic, thay cho reply-agent gọi tool). */
const MEDIA_KEYS = [
  "fitness-gym",
  "fitness-yoga",
  "fitness-zumba",
  "fitness-pool",
  "fitness-before-after-gain",
  "fitness-before-after-loss",
  "mr-neck-shoulder",
  "mr-sport",
  "mr-general",
] as const;
type MediaKey = (typeof MEDIA_KEYS)[number];

export interface BrainOutput {
  reply: string;
  mediaUrls: string[] | null;
  qrUrl: string | null;
}

const QR_BASE = process.env.BASE_URL ?? "http://localhost:4112";
const QR_URLS: Record<Flow, string> = {
  fitness: `${QR_BASE}/public/qr/fitness-qr.png`,
  "giai-co": `${QR_BASE}/public/qr/muscle-release-qr.png`,
};

const WEEKDAYS = ["chủ nhật", "thứ 2", "thứ 3", "thứ 4", "thứ 5", "thứ 6", "thứ 7"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Ngày hôm nay + 7 ngày tới (cho chốt-ngày "thứ 2 (8/7)"). Runtime server → new Date() dùng bình thường. */
function buildDateContext(): string {
  const now = new Date();
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const label = i === 0 ? "HÔM NAY" : i === 1 ? "mai" : WEEKDAYS[d.getDay()];
    parts.push(`${label} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
  }
  return `NGÀY: ${parts.join(" · ")}`;
}

/** Tóm tắt info đã biết — để bot không hỏi lại slot đã có. Chỉ liệt kê field có giá trị. */
function buildKnownSummary(info: KnownInfo): string {
  const bits: string[] = [];
  const add = (label: string, v: string | number | null) => {
    if (v !== null && v !== undefined && `${v}`.trim()) bits.push(`${label}=${v}`);
  };
  add("tên", info.name);
  add("SĐT", info.phone);
  add("bộ môn", info.serviceType);
  add("mục tiêu", info.fitnessGoal);
  add("đối tượng", info.memberType);
  add("vùng đau", info.painArea);
  add("tính chất đau", info.painSpread);
  add("giờ hẹn", info.preferredTime);
  add("ngày hẹn", info.appointmentDate);
  return bits.length ? `[ĐÃ BIẾT: ${bits.join(" · ")} — KHÔNG hỏi lại các mục này]` : "";
}

/** Header ĐỘNG ngắn nối cuối prompt tĩnh: ngày + info đã biết + cờ sau-chốt. */
function buildHeader(state: ConversationState): string {
  const lines = [buildDateContext()];
  const known = buildKnownSummary(state.knownInfo);
  if (known) lines.push(known);
  if (state.sheetsWritten)
    lines.push("[ĐÃ CHỐT ĐƠN — chế độ chăm khách sau chốt: trả answer-first, KHÔNG xin lại tên/SĐT/giờ, KHÔNG pitch lại gói đã chốt]");
  return lines.join("\n");
}

/** Bối cảnh gọn cho router: mục tiêu / bộ môn / vùng đau đã biết (để chọn đúng chiều media). */
function buildRouterContext(info: KnownInfo): string {
  const bits: string[] = [];
  if (info.fitnessGoal) bits.push(`mục tiêu=${info.fitnessGoal}`);
  if (info.serviceType) bits.push(`bộ môn=${info.serviceType}`);
  if (info.painArea) bits.push(`vùng đau=${info.painArea}`);
  return bits.length ? bits.join(" · ") : "chưa rõ";
}

/**
 * Turn router — 1 lần gọi classifier quyết CẢ (flow, media). Sticky flow; media là cổng
 * deterministic (thay reply-agent gọi tool). Thấy tin khách gần đây → chọn đúng chiều
 * before-after / vùng mr-* dù tin hiện tại không nêu lại. Lỗi → giữ flow cũ, media "none".
 */
async function classifyTurn(
  state: ConversationState,
  message: string,
): Promise<{ flow: Flow; media: MediaKey | null; ready: boolean }> {
  const fresh = (state.turnCount ?? 0) === 0;
  const current: Flow = state.flow;
  const currentLabel = fresh ? "chưa xác định (tin đầu)" : current;
  const recent = (state.recentUserMessages ?? []).slice(-4);
  const recentBlock = recent.length ? `Tin khách gần đây: ${recent.map((m) => `"${m}"`).join(" · ")}\n` : "";
  try {
    const res: any = await flowRouterAgent.generate(
      `Nhánh hiện tại: ${currentLabel}\n` +
        `Bối cảnh đã biết: ${buildRouterContext(state.knownInfo)}\n` +
        recentBlock +
        `Tin khách: "${message}"`,
      {
        modelSettings: { temperature: 0 },
        structuredOutput: {
          schema: z.object({
            flow: z.enum(["fitness", "giai-co"]).catch(current),
            media: z.enum([...MEDIA_KEYS, "none"]).catch("none"),
            ready: z.boolean().catch(false),
          }),
          jsonPromptInjection: true,
        },
      },
    );
    const pickedFlow = res?.object?.flow;
    const flow: Flow = pickedFlow === "fitness" || pickedFlow === "giai-co" ? pickedFlow : current;
    const pickedMedia = res?.object?.media;
    const media = (MEDIA_KEYS as readonly string[]).includes(pickedMedia) ? (pickedMedia as MediaKey) : null;
    return { flow, media, ready: res?.object?.ready === true };
  } catch (e) {
    console.error("[brain] classifyTurn failed → giữ nhánh cũ, media none:", (e as Error).message);
    return { flow: current, media: null, ready: false };
  }
}

/** Merge slot từ recordLead vào knownInfo (store-first cho tên/SĐT; re-extract cho slot hay đổi). */
function mergeLead(info: KnownInfo, args: any): void {
  const set = (k: keyof KnownInfo, v: unknown) => {
    if (typeof v === "string" && v.trim()) (info as any)[k] = v.trim();
  };
  // Tên/SĐT: chỉ điền khi chưa có (store-first) — tránh ghi đè do model nhắc lại lệch.
  if (!info.name) set("name", args.name);
  if (!info.phone) set("phone", args.phone);
  // Bảo toàn LỊCH ĐÃ CHỐT ở bước đưa liên hệ: khi tin này mang SĐT (chốt contact) mà đã có
  // ngày hẹn → KHÔNG cho model ghi đè ngày/giờ. Chống case tên trùng âm thời gian ("Mai" → "mai
  // 10/07") phá ngày đã chốt. Reschedule thật đến ở tin riêng (không kèm SĐT) nên vẫn cập nhật được.
  const freezeSchedule = typeof args.phone === "string" && !!args.phone.trim() && !!info.appointmentDate;
  if (!freezeSchedule) {
    set("preferredTime", args.preferredTime);
    set("appointmentDate", args.appointmentDate);
  }
  set("serviceType", args.service);
  set("fitnessGoal", args.goal);
  set("painArea", args.painArea);
}

export async function runAgentTurn(opts: {
  mastra: any;
  message: string;
  threadId: string;
  resourceId: string;
  abortSignal?: AbortSignal;
}): Promise<BrainOutput> {
  const { mastra, message, threadId, resourceId, abortSignal } = opts;
  const state = await loadState(mastra, threadId, resourceId);

  const { flow, media: mediaDecision, ready: routerReady } = await classifyTurn(state, message);
  const flowChanged = flow !== state.flow && (state.turnCount ?? 0) > 0;
  const agent = flow === "giai-co" ? giaiCoBrainAgent : fitnessBrainAgent;

  // ── build next state khung ──
  const next: ConversationState = { ...state, flow };
  next.turnCount = (state.turnCount ?? 0) + 1;
  next.flowTurnCount = flowChanged ? 1 : (state.flowTurnCount ?? 0) + 1;
  next.lastUserMessage = message;
  if (flowChanged) {
    // Đổi business = đơn khác → reset slot booking (giữ tên/SĐT), reset media.
    next.knownInfo = {
      ...state.knownInfo,
      serviceType: null, memberType: null, durationMonths: null, schedule: null,
      fitnessGoal: null, bodyStats: null, painArea: null, painSpread: null,
      painDuration: null, pastMethod: null, sessionPackage: null,
      preferredTime: null, appointmentDate: null,
    };
    next.mediaShown = false;
    next.mediaShownKeys = [];
  } else {
    next.knownInfo = { ...state.knownInfo };
  }

  // ── generate reply + thu toolCalls ──
  const header = buildHeader(next);
  const fullMessage = [header, message].filter(Boolean).join("\n");
  const toolCalls: { name: string; args: any }[] = [];
  // finalText = text của ITERATION CUỐI (câu trả lời thật). KHÔNG dùng result.text vì khi tool
  // fire (recordLead / updateWorkingMemory của working-memory) thì result.text GỘP text các vòng
  // → nhân đôi câu. Mỗi vòng model re-emit reply → lấy vòng cuối là đúng, đơn.
  let finalText = "";
  const result: any = await agent.generate(fullMessage, {
    maxSteps: 4,
    modelSettings: { temperature: 0.85, topP: 0.95 },
    abortSignal,
    memory: { thread: { id: threadId }, resource: resourceId, options: { lastMessages: 8 } },
    onIterationComplete: ({ toolCalls: tc, text }: { toolCalls: Array<{ name: string; args: Record<string, unknown> }>; text: string }) => {
      for (const c of tc) toolCalls.push({ name: c.name, args: c.args });
      if (typeof text === "string" && text.trim()) finalText = text;
    },
  });

  // ── pass 1: recordLead (cập nhật knownInfo trước để media/qr đọc đúng) ──
  for (const c of toolCalls) if (c.name === "recordLead") mergeLead(next.knownInfo, c.args ?? {});

  // intent phục vụ gate ghi Sheets + guard giục-chốt. routerReady = model phán khách đã tỏ ý
  // muốn đến/thử/đặt (đồng ý thử, hỏi lịch, nêu ngày-giờ, đưa liên hệ) — dùng để intent chuyển
  // "selecting" NGAY cả khi chưa có giờ cụ thể → guard soft (giai-co) không bắn nhầm lúc khách đã sẵn.
  const hasContact = !!(next.knownInfo.name && next.knownInfo.phone);
  next.intent = isLeadComplete(next)
    ? "ready"
    : next.knownInfo.preferredTime || routerReady
      ? "selecting"
      : "explore";
  next.stage = isLeadComplete(next)
    ? (next.sheetsWritten ? "retention" : "commitment")
    : next.stage;

  // ── media: turnRouter đã quyết THẲNG bộ ảnh (cổng deterministic) → fetch cưỡng chế 1 lần/cuộc ──
  // Không phó mặc reply-agent gọi tool (model nhỏ hay bỏ nhịp). guardKey gộp gain/loss thành 1
  // để không gửi cả 2 chiều before-after cho 1 người. flowChanged đã reset mediaShownKeys ở trên.
  let mediaUrls: string[] | null = null;
  let sentMediaKey: string | null = null;
  if (mediaDecision) {
    // guardKey gộp các biến thể cùng "concept" để 1 khách chỉ nhận 1 lần:
    //   • before-after gain/loss → 1 (không gửi cả 2 chiều)
    //   • mọi mr-* (giải cơ result) → 1 (không gửi nhiều video giải cơ dù router đổi subset)
    //   • ảnh bộ môn (gym/pool/yoga/zumba) giữ riêng — khách có thể muốn xem nhiều môn.
    const guardKey = mediaDecision.startsWith("fitness-before-after")
      ? "fitness-before-after"
      : mediaDecision.startsWith("mr-")
        ? "mr"
        : mediaDecision;
    if (!(next.mediaShownKeys ?? []).includes(guardKey)) {
      try {
        const items = await fetchMedia(mediaDecision);
        const urls = items.map((it) => it.url).filter(Boolean);
        if (urls.length) {
          mediaUrls = urls;
          sentMediaKey = mediaDecision;
          next.mediaShown = true;
          next.mediaShownKeys = [...(next.mediaShownKeys ?? []), guardKey];
        }
      } catch (e) {
        console.error("[brain] fetchMedia failed:", (e as Error).message);
      }
    }
  }

  // ── QR: reply-agent gọi tool sendQR (gate hasContact) ──
  let qrUrl: string | null = null;
  for (const c of toolCalls) {
    if (c.name === "sendQR" && hasContact) {
      qrUrl = QR_URLS[flow];
      next.qrShown = true;
    }
  }

  // ── làm sạch reply (tái dùng cleanReply + guards khoá cứng) ──
  const hasMedia = !!(mediaUrls && mediaUrls.length);
  let reply = cleanReply(
    finalText || result?.text || "",
    hasMedia,
    state.lastBotReply ?? "",
    message,
    state.recentBotReplies ?? [],
  );
  if (next.turnCount > 1) reply = stripStaleGreeting(reply, !!next.sheetsWritten, next.honorific);
  if (hasMedia) reply = ensureMediaCaption(reply, sentMediaKey, next.honorific);
  if (!qrUrl) reply = stripQrMention(reply);
  reply = lockHonorific(reply, next.honorific);
  if (flow === "giai-co") {
    reply = softenGiaiCoPrematureClose(reply, {
      flow,
      intent: next.intent,
      preferredTime: next.knownInfo.preferredTime,
      hasContact,
      honorific: next.honorific,
    });
  }

  // ── ghi state snapshot (followup + dedup ở facebook.ts đọc field này) ──
  next.lastBotReply = reply;
  next.recentBotReplies = [...(state.recentBotReplies ?? []), reply].slice(-4);
  next.recentUserMessages = [...(state.recentUserMessages ?? []), message].slice(-5);
  await saveState(mastra, threadId, resourceId, next);

  return { reply, mediaUrls, qrUrl };
}

/**
 * lib/followup.ts
 *
 * Schedule tin follow-up khi khách ghost (1 timer 10 phút).
 * Tin follow-up DỰA TRÊN state đã thu thập (serviceType, fitnessGoal, painArea...)
 * + gửi kèm ảnh/video + show pricing cụ thể.
 *
 * Triết lý: khi khách ghost 10p, họ có thể quên hoặc đang phân vân.
 * Nhắn warm + show hết info phục vụ nhu cầu cụ thể của họ → tăng cơ hội pull lại.
 *
 * In-memory only. Mất khi server restart — acceptable.
 */

import type { ConversationState } from "./stateMachine";

export const FOLLOWUP_MS = Number(process.env.FOLLOWUP_MS ?? 10 * 60 * 1000);

export interface FollowupHandlers {
  sendText: (text: string) => Promise<void>;
  sendMedia: (url: string) => Promise<void>;
}

const followupTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedule follow-up. Khi timer expire (10p mặc định) → gửi tin warm
 * + media (nếu có) phục vụ nhu cầu khách dựa trên state.
 */
export function scheduleFollowup(
  senderId: string,
  state: ConversationState,
  handlers: FollowupHandlers,
  mediaUrls: string[] = [],
): void {
  cancelFollowup(senderId);

  const timer = setTimeout(async () => {
    try {
      const text = buildFollowupText(state);
      await handlers.sendText(text);

      // Gửi kèm ảnh/video (đã pre-fetch khi schedule).
      // Cap MAX 3 image + 2 video — đủ visual cho khách hình dung.
      const isVideo = (u: string) =>
        /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(u) ||
        u.toLowerCase().includes("/video/");
      const uniq = [...new Set(mediaUrls.map((u) => u.trim()).filter(Boolean))];
      const fImages = uniq.filter((u) => !isVideo(u)).slice(0, 3);
      const fVideos = uniq.filter(isVideo).slice(0, 2);
      const toSend = [...fImages, ...fVideos];
      for (const url of toSend) {
        await handlers.sendMedia(url);
      }
      console.log(
        `[followup] sent to ${senderId} after 10p ghost — text + ${toSend.length}/${mediaUrls.length} media (capped 3img+2vid)`,
      );
    } catch (e) {
      console.error("[followup] send failed:", e);
    } finally {
      followupTimers.delete(senderId);
    }
  }, FOLLOWUP_MS);

  followupTimers.set(senderId, timer);
}

export function cancelFollowup(senderId: string): void {
  const t = followupTimers.get(senderId);
  if (t) {
    clearTimeout(t);
    followupTimers.delete(senderId);
  }
}

// ─────────────────────────────────────────────
// Build content theo state
// ─────────────────────────────────────────────

const SERVICE_LABEL: Record<string, string> = {
  gym: "Gym",
  yoga: "Yoga",
  zumba: "Zumba",
  boi: "bể bơi",
  pilates: "Pilates",
  full: "thẻ Full 4 dịch vụ",
};

const GOAL_LABEL: Record<string, string> = {
  "giam-mo": "giảm mỡ",
  "tang-co": "tăng cơ",
  "thu-gian": "thư giãn",
  "hoc-boi": "học bơi",
  "suc-khoe": "sức khỏe tổng thể",
};

// Phát hiện những gì bot đã pitch ở tin trước → tránh lặp.
function alreadyMentions(prev: string, patterns: RegExp[]): boolean {
  if (!prev) return false;
  return patterns.some((p) => p.test(prev));
}

const HAS_SERVICES_LIST = [
  /\b(gym|bơi|yoga|zumba)\b.*\b(gym|bơi|yoga|zumba)\b/i, // ≥2 dịch vụ trong 1 tin
  /4\s*dịch\s*vụ/i,
];
const HAS_PRICING = [/\d+\s*(tr|triệu|k)\b.*\d+\s*(tr|triệu|k)\b/i]; // ≥2 mức giá
const HAS_INBODY = [/inbody/i];
const HAS_MEDIA_OFFER = [/em\s+gửi\s+(thêm\s+)?(vài\s+)?(hình|ảnh|video)/i];

/**
 * Build followup TEXT — soft re-engagement.
 *
 * NGUYÊN TẮC:
 *   - Đọc lastBotReply để né lặp nội dung (services list / pricing / InBody / media offer).
 *   - Càng có nhiều info đã pitch → followup càng SHORT (chỉ check-in).
 *   - Càng ít info → có thể đính kèm câu khơi gợi nhẹ.
 *   - KHÔNG bao giờ list lại 4 dịch vụ / liệt kê giá ở followup — đó là job của reply chính.
 */
export function buildFollowupText(state: ConversationState): string {
  const honor =
    state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
  const ki = state.knownInfo;
  const prev = state.lastBotReply ?? "";

  const prevHasServices = alreadyMentions(prev, HAS_SERVICES_LIST);
  const prevHasPricing = alreadyMentions(prev, HAS_PRICING);
  const prevHasInBody = alreadyMentions(prev, HAS_INBODY);

  // ── FITNESS ──
  if (state.flow === "fitness") {
    // Đã đủ goal + service → check-in về quyết định
    if (ki.serviceType && ki.fitnessGoal) {
      const svcLabel = SERVICE_LABEL[ki.serviceType.toLowerCase()] ?? ki.serviceType;
      const goalLabel = GOAL_LABEL[ki.fitnessGoal] ?? ki.fitnessGoal;
      const inbodyLine =
        !prevHasInBody && !ki.preferredTime
          ? ` Bên em đo InBody miễn phí lần đầu, ${honor} ghé thử buổi nào tiện nha.`
          : ` ${honor} thấy hợp em note giữ slot luôn nha.`;
      return `Dạ ${honor}, ${honor} thấy hướng ${svcLabel} cho ${goalLabel} có ổn không ạ.${inbodyLine}`;
    }

    // Có service, chưa goal → hỏi mục tiêu nhẹ
    if (ki.serviceType) {
      const svcLabel = SERVICE_LABEL[ki.serviceType.toLowerCase()] ?? ki.serviceType;
      return `Dạ ${honor}, ${honor} muốn tập ${svcLabel} cho mục tiêu cụ thể nào để em tư vấn lộ trình sát hơn ạ (giảm cân, tăng cơ hay thư giãn).`;
    }

    // Có goal, chưa service → gợi 1 hướng theo goal
    if (ki.fitnessGoal) {
      const goalLabel = GOAL_LABEL[ki.fitnessGoal] ?? ki.fitnessGoal;
      return `Dạ ${honor}, ${honor} thấy hướng ${goalLabel} sao rồi ạ, có gì cần em sẵn sàng tư vấn thêm ạ.`;
    }

    // Chưa có gì — soft check-in. Nếu prev đã list 4 dịch vụ → KHÔNG nhắc lại.
    if (prevHasServices) {
      return `Dạ ${honor}, ${honor} đang phân vân ở dịch vụ nào không, em sẵn sàng tư vấn thêm ạ.`;
    }
    return `Dạ ${honor}, ${honor} có nhu cầu cụ thể nào (giảm cân, tăng cơ, thư giãn) để em gợi gói chuẩn nha.`;
  }

  // ── GIẢI CƠ ──
  // Có painArea → check-in về vùng đau, đề xuất thử 1 buổi
  if (ki.painArea) {
    const tryLine =
      !prevHasPricing
        ? ` ${honor} thử 1 buổi để KTV đánh giá rồi mới tư vấn lộ trình nha.`
        : ` ${honor} sắp xếp được buổi nào em note slot giúp.`;
    return `Dạ ${honor}, vùng ${ki.painArea} ${honor} thấy sao rồi, có cần em hỗ trợ đặt lịch không ạ.${tryLine}`;
  }

  // Chưa có painArea — hỏi vùng đau
  return `Dạ ${honor}, ${honor} có vùng nào đang đau hay mỏi cần em tư vấn không ạ, em sẵn sàng hỗ trợ.`;
}

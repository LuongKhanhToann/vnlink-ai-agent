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
// Cooldown: chỉ gửi tối đa 1 followup/khách trong khoảng thời gian này (default 24h).
// Tránh case khách ghost → bot followup → khách reply ngắn → ghost tiếp → bot followup tiếp = phiền.
export const FOLLOWUP_COOLDOWN_MS = Number(
  process.env.FOLLOWUP_COOLDOWN_MS ?? 24 * 60 * 60 * 1000,
);
// Quiet hours (giờ VN): không gửi followup trong khoảng [QUIET_START, QUIET_END).
// Default: 22h tối → 8h sáng. Nếu timer fire trong khung này → defer đến 8h sáng.
const QUIET_START_HOUR = Number(process.env.FOLLOWUP_QUIET_START ?? "22");
const QUIET_END_HOUR = Number(process.env.FOLLOWUP_QUIET_END ?? "8");

/**
 * Trả về số ms cần defer nếu giờ hiện tại nằm trong quiet hours, hoặc 0 nếu OK gửi ngay.
 */
function deferMsIfQuiet(now: Date = new Date()): number {
  const vnHour = Number(
    now.toLocaleString("en-US", {
      timeZone: "Asia/Ho_Chi_Minh",
      hour: "numeric",
      hour12: false,
    }),
  );
  const vnMinute = Number(
    now.toLocaleString("en-US", {
      timeZone: "Asia/Ho_Chi_Minh",
      minute: "numeric",
    }),
  );

  const inQuiet =
    QUIET_START_HOUR < QUIET_END_HOUR
      ? vnHour >= QUIET_START_HOUR && vnHour < QUIET_END_HOUR
      : vnHour >= QUIET_START_HOUR || vnHour < QUIET_END_HOUR; // wrap qua nửa đêm

  if (!inQuiet) return 0;

  // Tính ms đến QUIET_END_HOUR:00 sáng mai (hoặc cùng ngày nếu chưa qua midnight).
  const minutesUntilEnd =
    QUIET_END_HOUR > vnHour
      ? (QUIET_END_HOUR - vnHour) * 60 - vnMinute
      : (24 - vnHour + QUIET_END_HOUR) * 60 - vnMinute;
  return minutesUntilEnd * 60 * 1000;
}

export interface FollowupHandlers {
  sendText: (text: string) => Promise<void>;
  sendMedia: (url: string) => Promise<void>;
}

const followupTimers = new Map<string, NodeJS.Timeout>();
// Track timestamp followup gửi gần nhất / khách → chặn gửi lặp trong cooldown window.
const lastFollowupSent = new Map<string, number>();

/**
 * Schedule follow-up. Khi timer expire (10p mặc định) → gửi tin warm
 * + media (nếu có) phục vụ nhu cầu khách dựa trên state.
 *
 * Cooldown: nếu đã gửi followup trong FOLLOWUP_COOLDOWN_MS (24h default) → SKIP schedule.
 */
export function scheduleFollowup(
  senderId: string,
  state: ConversationState,
  handlers: FollowupHandlers,
  mediaUrls: string[] = [],
): void {
  cancelFollowup(senderId);

  const lastSent = lastFollowupSent.get(senderId);
  if (lastSent && Date.now() - lastSent < FOLLOWUP_COOLDOWN_MS) {
    const minsLeft = Math.round(
      (FOLLOWUP_COOLDOWN_MS - (Date.now() - lastSent)) / 60000,
    );
    console.log(
      `[followup] skip ${senderId} — cooldown còn ${minsLeft}p (đã gửi gần nhất ${Math.round((Date.now() - lastSent) / 60000)}p trước)`,
    );
    return;
  }

  const fire = async () => {
    // Nếu fire trúng quiet hours [22h, 8h sáng) → defer đến 8h sáng.
    const deferMs = deferMsIfQuiet();
    if (deferMs > 0) {
      console.log(
        `[followup] ${senderId} quiet hours — defer ${Math.round(deferMs / 60000)}p tới 8h sáng`,
      );
      const t2 = setTimeout(fire, deferMs);
      followupTimers.set(senderId, t2);
      return;
    }

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
      lastFollowupSent.set(senderId, Date.now());
      console.log(
        `[followup] sent to ${senderId} after ghost — text + ${toSend.length}/${mediaUrls.length} media (capped 3img+2vid)`,
      );
    } catch (e) {
      console.error("[followup] send failed:", e);
    } finally {
      followupTimers.delete(senderId);
    }
  };

  followupTimers.set(senderId, setTimeout(fire, FOLLOWUP_MS));
}

export function cancelFollowup(senderId: string): void {
  const t = followupTimers.get(senderId);
  if (t) {
    clearTimeout(t);
    followupTimers.delete(senderId);
  }
}

/**
 * Reset toàn bộ state in-memory của followup — dùng cho admin /reset.
 * Cancel mọi timer đang pending + clear cooldown để admin có thể test lại từ đầu.
 */
export function resetAllFollowupState(): void {
  for (const t of followupTimers.values()) clearTimeout(t);
  followupTimers.clear();
  lastFollowupSent.clear();
  console.log("[followup] resetAllFollowupState: cleared all timers + cooldowns");
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

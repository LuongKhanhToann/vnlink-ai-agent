/**
 * lib/followup.ts
 *
 * Nhắc CHỦ ĐỘNG khi khách im (ghost) — như 1 saler thật không bỏ lửng cuộc thoại.
 *
 * Nhịp TĂNG DẦN: mặc định 2 phút → 10 phút → 1 giờ rồi DỪNG (tối đa 3 lần/episode).
 * Mỗi lần khách nhắn lại → cancelFollowup() reset cả chuỗi (xem facebook.ts enqueueMessage).
 *
 * Nội dung do LLM tự viết (handlers.generate) dựa trên state + lịch sử — KHÔNG template,
 * KHÔNG regex. Nếu LLM fail/null → bỏ qua lần đó, không gửi tin cứng.
 *
 * In-memory only. Mất khi server restart — acceptable.
 */

// Nhịp nhắc tăng dần (ms), gap TRƯỚC mỗi lần nhắc. Override qua env FOLLOWUP_DELAYS_MS="120000,600000,3600000".
export const FOLLOWUP_DELAYS_MS: number[] = (() => {
  const raw = process.env.FOLLOWUP_DELAYS_MS;
  if (raw) {
    const parsed = raw.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
    if (parsed.length) return parsed;
  }
  return [2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
})();

// Quiet hours (giờ VN): không nhắc trong [QUIET_START, QUIET_END). Default 22h → 8h sáng.
const QUIET_START_HOUR = Number(process.env.FOLLOWUP_QUIET_START ?? "22");
const QUIET_END_HOUR = Number(process.env.FOLLOWUP_QUIET_END ?? "8");

function deferMsIfQuiet(now: Date = new Date()): number {
  const vnHour = Number(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", hour12: false }),
  );
  const vnMinute = Number(
    now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", minute: "numeric" }),
  );
  const inQuiet =
    QUIET_START_HOUR < QUIET_END_HOUR
      ? vnHour >= QUIET_START_HOUR && vnHour < QUIET_END_HOUR
      : vnHour >= QUIET_START_HOUR || vnHour < QUIET_END_HOUR;
  if (!inQuiet) return 0;
  const minutesUntilEnd =
    QUIET_END_HOUR > vnHour
      ? (QUIET_END_HOUR - vnHour) * 60 - vnMinute
      : (24 - vnHour + QUIET_END_HOUR) * 60 - vnMinute;
  return minutesUntilEnd * 60 * 1000;
}

export interface FollowupHandlers {
  sendText: (text: string) => Promise<void>;
  sendMedia: (url: string) => Promise<void>;
  /** LLM-driven: sinh tin nhắc cho lần thứ `attempt` (0-based). Trả null/"" = bỏ qua lần này. */
  generate: (attempt: number) => Promise<string | null>;
}

const followupTimers = new Map<string, NodeJS.Timeout>();

/**
 * Bắt đầu (hoặc reset) chuỗi nhắc cho khách. Gọi sau MỖI reply của bot khi khách chưa chốt.
 * cancelFollowup ở đầu đảm bảo không chồng chuỗi cũ.
 */
export function scheduleFollowup(
  senderId: string,
  handlers: FollowupHandlers,
  mediaUrls: string[] = [],
): void {
  cancelFollowup(senderId);
  scheduleAttempt(senderId, 0, handlers, mediaUrls);
}

function scheduleAttempt(
  senderId: string,
  attempt: number,
  handlers: FollowupHandlers,
  mediaUrls: string[],
): void {
  if (attempt >= FOLLOWUP_DELAYS_MS.length) {
    cancelFollowup(senderId);
    return;
  }
  const delay = FOLLOWUP_DELAYS_MS[attempt];

  const fire = async () => {
    // Trúng quiet hours → defer tới 8h sáng, GIỮ nguyên attempt index.
    const deferMs = deferMsIfQuiet();
    if (deferMs > 0) {
      console.log(`[followup] ${senderId} quiet hours — defer ${Math.round(deferMs / 60000)}p`);
      followupTimers.set(senderId, setTimeout(fire, deferMs));
      return;
    }

    try {
      const text = await handlers.generate(attempt);
      if (text && text.trim()) {
        await handlers.sendText(text);
        // Media CHỈ gửi lần nhắc đầu (attempt 0) để khỏi spam ảnh mỗi lần.
        if (attempt === 0 && mediaUrls.length) {
          const isVideo = (u: string) =>
            /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(u) || u.toLowerCase().includes("/video/");
          const uniq = [...new Set(mediaUrls.map((u) => u.trim()).filter(Boolean))];
          const toSend = [
            ...uniq.filter((u) => !isVideo(u)).slice(0, 3),
            ...uniq.filter(isVideo).slice(0, 2),
          ];
          for (const url of toSend) await handlers.sendMedia(url);
        }
        console.log(`[followup] sent to ${senderId} (attempt ${attempt + 1}/${FOLLOWUP_DELAYS_MS.length})`);
      } else {
        console.log(`[followup] ${senderId} attempt ${attempt + 1}: generate trả rỗng → bỏ qua`);
      }
    } catch (e) {
      console.error("[followup] send failed:", e);
    } finally {
      followupTimers.delete(senderId);
      // Lên lịch lần nhắc kế (gap tăng dần). Nếu khách đã nhắn lại, cancelFollowup đã clear → fire này không chạy.
      scheduleAttempt(senderId, attempt + 1, handlers, mediaUrls);
    }
  };

  followupTimers.set(senderId, setTimeout(fire, delay));
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
 */
export function resetAllFollowupState(): void {
  for (const t of followupTimers.values()) clearTimeout(t);
  followupTimers.clear();
  console.log("[followup] resetAllFollowupState: cleared all timers");
}

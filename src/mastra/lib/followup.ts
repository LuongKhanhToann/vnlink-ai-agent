/**
 * lib/followup.ts
 *
 * Schedule tin follow-up khi khách ghost (escalating 5p / 15p / 30p).
 * - Khi bot gửi reply, schedule 3 timers.
 * - Nếu khách reply trước → cancel TẤT CẢ timers.
 * - Mỗi timer fire → bot gửi tin riêng, content khác nhau.
 *
 * In-memory only. Mất khi server restart — acceptable vì follow-up là nhẹ.
 */

interface FollowupStage {
  delayMs: number;
  text: string;
}

// 3 stages escalating: nhắc nhẹ → quan tâm → close-out
const STAGES: FollowupStage[] = [
  {
    delayMs: 5 * 60 * 1000,
    text: "Dạ anh/chị có cần em hỗ trợ thêm thông tin gì không ạ.",
  },
  {
    delayMs: 15 * 60 * 1000,
    text: "Em vẫn đây nha anh/chị, có gì cần em giải đáp thêm em sẵn sàng nha.",
  },
  {
    delayMs: 30 * 60 * 1000,
    text: "Anh/chị có thể qua center thử trực tiếp 1 buổi để cảm nhận thực tế nha. Em note ưu đãi tháng này lại cho anh/chị, có gì cần em sẵn lòng tư vấn.",
  },
];

// Cho phép override delays qua env (vd test fast: FOLLOWUP_STAGES_MS=10000,30000,60000)
const stagesEnv = process.env.FOLLOWUP_STAGES_MS;
if (stagesEnv) {
  const customDelays = stagesEnv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  if (customDelays.length === STAGES.length) {
    customDelays.forEach((ms, i) => (STAGES[i].delayMs = ms));
  }
}

const followupTimers = new Map<string, NodeJS.Timeout[]>();

/**
 * Schedule 3-stage follow-up. Mỗi stage gửi text khác nhau.
 * Nếu đã có timers cho senderId → cancel tất cả trước.
 */
export function scheduleFollowup(
  senderId: string,
  sendFn: (text: string) => Promise<void>,
): void {
  cancelFollowup(senderId);

  const timers: NodeJS.Timeout[] = [];
  for (const stage of STAGES) {
    const timer = setTimeout(async () => {
      try {
        await sendFn(stage.text);
        console.log(
          `[followup] sent stage (${stage.delayMs / 60000}p) to ${senderId}`,
        );
      } catch (e) {
        console.error("[followup] send failed:", e);
      }
    }, stage.delayMs);
    timers.push(timer);
  }

  followupTimers.set(senderId, timers);
}

/**
 * Cancel TẤT CẢ pending follow-up timers cho senderId. Gọi khi khách reply mới.
 */
export function cancelFollowup(senderId: string): void {
  const timers = followupTimers.get(senderId);
  if (timers) {
    for (const t of timers) clearTimeout(t);
    followupTimers.delete(senderId);
  }
}

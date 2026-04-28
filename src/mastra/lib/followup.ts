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

      // Gửi kèm ảnh/video (đã pre-fetch khi schedule)
      for (const url of mediaUrls.slice(0, 3)) {
        await handlers.sendMedia(url);
      }
      console.log(
        `[followup] sent to ${senderId} after 10p ghost — text + ${mediaUrls.length} media`,
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

// Pricing snippets ngắn theo serviceType
const FITNESS_PRICING: Record<string, string> = {
  gym: "Gym fulltime 12 tháng 5tr | 3 buổi/tuần 12 tháng 4.5tr | PT 20 buổi 5tr (1-1) hoặc 20b 2 mom 6tr",
  yoga: "Yoga 12 tháng 5.8tr fulltime | 4.5tr (3 buổi/tuần), GV người Ấn Độ 4 ca/ngày",
  zumba: "Zumba 12 tháng 5.8tr fulltime | 4.5tr (3 buổi/tuần)",
  boi: "Bơi NL fulltime: 12m=5tr | 24m=8.6tr | Học bơi 1-1 (12 buổi) 3tr+3 tháng bể, cam kết biết bơi",
  pilates: "Pilates thảm 10b=1.5tr | máy(1:6) 10b=1.9tr/20b=3.6tr | nhóm(1:3) 10b=3tr/20b=5.8tr | 1-1 10b=4.5tr/20b=8.6tr",
  full: "Thẻ Full 4 dịch vụ: 1.2tr/tháng | 3tr/3 tháng | 7tr/12 tháng (~19k/ngày)",
};

const GIAICO_PRICING =
  "Lẻ: 45p (1-2 vùng) 200k | 75p 330k | CS-VIP1 480k | CS-VIP2 590k. Liệu trình VIP1×10 buổi 4.2tr (tặng 1 buổi)";

export function buildFollowupText(state: ConversationState): string {
  const honor =
    state.honorific === "anh/chị" ? "anh/chị" : state.honorific;
  const ki = state.knownInfo;

  // ── FITNESS — đã có serviceType + goal ──
  if (state.flow === "fitness" && ki.serviceType && ki.fitnessGoal) {
    const svcKey = ki.serviceType.toLowerCase();
    const svcLabel = SERVICE_LABEL[svcKey] ?? ki.serviceType;
    const goalLabel = GOAL_LABEL[ki.fitnessGoal] ?? ki.fitnessGoal;
    const pricing = FITNESS_PRICING[svcKey] ?? FITNESS_PRICING.full;
    return (
      `Dạ ${honor}, em gửi thêm hình ảnh thực tế bên em + thông tin chi tiết về ${svcLabel} cho ${goalLabel} để ${honor} tham khảo nha. ` +
      `${pricing}. ` +
      `Bên em đo InBody miễn phí lần đầu, HLV tư vấn lộ trình chuẩn theo cơ thể ${honor}. ${honor} ghé bất kỳ buổi sáng (5h-11h) hoặc chiều tối nha.`
    );
  }

  // ── FITNESS — có serviceType, chưa có goal ──
  if (state.flow === "fitness" && ki.serviceType) {
    const svcKey = ki.serviceType.toLowerCase();
    const svcLabel = SERVICE_LABEL[svcKey] ?? ki.serviceType;
    const pricing = FITNESS_PRICING[svcKey] ?? FITNESS_PRICING.full;
    return (
      `Dạ ${honor}, em gửi thêm hình ảnh ${svcLabel} bên em để ${honor} hình dung nha. ` +
      `${pricing}. ` +
      `${honor} ghé bất kỳ lúc nào để cảm nhận thực tế, HLV tư vấn miễn phí.`
    );
  }

  // ── FITNESS — chưa có gì ──
  if (state.flow === "fitness") {
    return (
      `Dạ ${honor}, bên em là Fami Fitness & Yoga Center có 4 dịch vụ chính: Gym (700m2), Bơi (bể 4 mùa duy nhất Vĩnh Yên), Yoga & Zumba (GV Ấn Độ), Pilates. ` +
      `Thẻ Full dùng cả 4: 7tr/12 tháng (~19k/ngày). ` +
      `Em gửi vài hình bên em, ${honor} xem xong có gì cần em sẵn sàng tư vấn nha.`
    );
  }

  // ── GIẢI CƠ — có painArea ──
  if (state.flow === "giai-co" && ki.painArea) {
    const past = ki.pastMethod
      ? `Em hiểu ${honor} đã thử ${ki.pastMethod} chưa đỡ — `
      : "";
    return (
      `Dạ ${honor}, em gửi thêm hình ảnh thực tế giải cơ vùng ${ki.painArea} bên em để ${honor} hình dung quy trình nha. ` +
      `${past}giải cơ chuyên sâu xử lý nút thắt sâu trong cơ (Trigger Points), không vuốt bề mặt như massage. ` +
      `${GIAICO_PRICING}. ` +
      `${honor} thử 1 buổi để cảm nhận thực tế, KTV đánh giá rồi mới tư vấn lộ trình phù hợp nha.`
    );
  }

  // ── GIẢI CƠ — chưa có painArea ──
  return (
    `Dạ ${honor}, bên em là Trung tâm Hoa Sen — chuyên giải cơ chuyên sâu xử lý nút thắt cơ (Trigger Points), khác massage thông thường. ` +
    `${GIAICO_PRICING}. ` +
    `Em gửi vài hình thực tế, ${honor} xem có gì cần em sẵn lòng tư vấn thêm nha.`
  );
}

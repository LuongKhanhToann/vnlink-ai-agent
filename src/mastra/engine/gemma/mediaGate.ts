/**
 * mediaGate.ts — cổng ảnh DETERMINISTIC (song ánh với engine/brain.ts của bản 5.4).
 *
 * Classifier LLM chọn BỘ ảnh (việc hiểu khách); code chỉ quyết CÓ GỬI HAY KHÔNG theo 2 luật
 * cứng: không bắn ảnh ở tin đầu, và mỗi "concept" chỉ gửi 1 lần trong cả cuộc.
 */

import type { ConvState } from "./state";

/** guardKey gộp các biến thể cùng "concept" (đồng bộ convention engine/brain.ts). */
export function toGuardKey(key: string): string {
  if (key.startsWith("fitness-before-after")) return "fitness-before-after";
  if (key.startsWith("mr-")) return "mr";
  return key;
}

/**
 * Quyết bộ ảnh gửi kèm lượt này. GHI SỔ vào `conv.mediaSent` khi đã duyệt gửi.
 * @param picked bộ ảnh classifier chọn ("none"/rỗng = không đề xuất gì)
 * @param alreadySent guardKey đã gửi ở nơi khác (state prod) — tránh gửi trùng khi đổi engine
 */
export function decideMedia(
  conv: ConvState,
  picked: string | null,
  alreadySent: string[] = [],
): { mediaKey: string | null; note: string | null } {
  if (!picked || picked === "none") return { mediaKey: null, note: null };
  const guardKey = toGuardKey(picked);
  if (conv.turnCount <= 1) return { mediaKey: null, note: `chặn ảnh tin đầu (${picked})` };
  // Khách vừa chấn thương, đang sưng nóng → tin phải là lời khuyên an toàn, không phải ca thành
  // công. Bắt được ở CAPTINH 23/07: khách "lật cổ chân sưng vù" mà bot mở tin bằng "em gửi anh
  // xem vài ca bên em làm" → đọc như đang chào mời làm luôn.
  if (conv.anToan === "cap-tinh") return { mediaKey: null, note: `chặn ảnh (khách chấn thương cấp)` };
  if (conv.mediaSent.includes(guardKey) || alreadySent.includes(guardKey)) {
    return { mediaKey: null, note: `chặn gửi lại ảnh (${picked})` };
  }
  conv.mediaSent.push(guardKey);
  return { mediaKey: picked, note: null };
}

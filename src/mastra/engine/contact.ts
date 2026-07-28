/**
 * contact.ts — SỐ HOTLINE THẬT của Fami Fitness (chủ page đưa 27/07/2026).
 *
 * Vì sao tách riêng 1 file: số này được nhắc ở 3 nơi (prompt gemma, prompt 5.4, chỉ thị theo lượt
 * trong state.ts). Số điện thoại chép tay ở nhiều chỗ mà lệch 1 chữ số là khách gọi nhầm người —
 * lỗi tệ hơn hẳn việc không đưa số. Sửa số ở ĐÂY, không sửa rải rác.
 *
 * ⚠ Giữ NGUYÊN cách nhóm số chủ page viết — prompt bắt model chép nguyên văn chuỗi này, không tự
 *   gộp/tách nhóm (12B rất hay "làm đẹp" dãy số rồi ra số khác).
 * ⚠ Chủ page xác nhận 27/07: CẢ HAI cơ sở (Fami Fitness và Hoa Sen) dùng CHUNG số này — không tách
 *   theo nhánh.
 */
export const HOTLINE = "096 404 44 51";

/**
 * Số này đã xác nhận dùng được Zalo/Viber chưa? CHƯA ai xác nhận → bot chỉ được nói đây là số để
 * GỌI. 12B rất hay tự thêm "hoặc nhắn qua Zalo" (đo 2/3 lần chạy smoke 27/07) — nếu chủ page xác
 * nhận số có Zalo thì bật cờ này lên true, luật soát nháp tự nới theo, không phải sửa chỗ nào khác.
 */
export const HOTLINE_CO_ZALO = false;

/** Chuỗi chỉ gồm chữ số của hotline — dùng để soi tin bot bất kể nó nhóm số kiểu gì. */
export const HOTLINE_DIGITS = HOTLINE.replace(/\D/g, "");

/** Tin đã có ĐÚNG số hotline chưa (chấp nhận mọi cách nhóm số, chỉ cần đủ chữ số liền mạch). */
export function coSoHotline(text: string): boolean {
  return text.replace(/\D/g, "").includes(HOTLINE_DIGITS);
}

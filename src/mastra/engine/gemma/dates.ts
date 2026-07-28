/**
 * dates.ts — mọi phép tính THỨ/NGÀY của nhánh gemma.
 *
 * Model 12B tự tính thứ-ngày là lệch (đã bắt được ca "thứ Hai 28/07 hay thứ Ba 29/07" trong
 * khi 28/07 mới là thứ Ba → khách chọn xong lệch lịch hẹn). Đây là việc PHẢI ĐÚNG 100% nên
 * code tính hết, model chỉ chép lại chuỗi đã tính sẵn.
 */

export const WEEKDAYS = ["Chủ nhật", "thứ Hai", "thứ Ba", "thứ Tư", "thứ Năm", "thứ Sáu", "thứ Bảy"];

/** Nửa đêm hôm nay (giờ máy) — mốc gốc của mọi phép cộng ngày. */
function today(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Nhãn ngày cách hôm nay `offset` ngày, dạng "thứ Bảy 25/07". */
function labelOf(offset: number): string {
  const d = new Date(today().getTime() + offset * 86_400_000);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${dd}/${mm}`;
}

/**
 * BẢNG NGÀY bơm vào system prompt: model tra bảng thay vì tự tính.
 * Đánh dấu cả HÔM NAY lẫn NGÀY MAI: chỉ đánh dấu hôm nay thì 12B vẫn viết nhầm ra câu
 * "vì ngày mai là thứ Năm 23/07…" trong khi 23/07 chính là hôm nay (bắt được ở LUNGTUNG lượt 1).
 */
export function buildDateBlock(days = 14): string {
  const mark = (i: number) => (i === 0 ? " ← HÔM NAY" : i === 1 ? " ← NGÀY MAI" : "");
  return Array.from({ length: days }, (_, i) => `- ${labelOf(i)}${mark(i)}`).join("\n");
}

/**
 * TUỔI BÉ tính bằng CODE từ dữ liệu khách cho (năm sinh / tháng-năm sinh / lớp đang học).
 *
 * Vì sao code làm: 12B tính tuổi SAI và dùng số sai đó để CHỐI khách — đo LIVE + replay 26/07
 * (khách: "cháu sinh tháng 8/2019", bot: "bé vừa tròn 5 tuổi… trung tâm nhận từ 6 tuổi"; thực tế
 * bé đã 6 tuổi, ĐỦ điều kiện). Mốc nhận lớp bơi là 6 tuổi nên sai một tuổi = mất khách thật.
 * Model chỉ trích SỐ khách nói (việc hiểu ngôn ngữ), phép trừ là việc của code (như BẢNG NGÀY).
 *
 * Trả `null` khi không đủ dữ liệu. `min`/`max` là khoảng tuổi có thể (chỉ có NĂM sinh thì lệch 1
 * tuổi tuỳ đã qua sinh nhật chưa); `nguon` để ghi vào chỉ thị cho minh bạch.
 */
export interface TuoiBe {
  min: number;
  max: number;
  nguon: string;
}

/** Lấy dãy chữ số đầu tiên có ≤4 chữ số (parse kỹ thuật, không phán đoán nghĩa). */
function soDau(raw: string, maxLen: number): number | null {
  let s = "";
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") s += ch;
    else if (s) break;
  }
  if (!s || s.length > maxLen) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function tinhTuoiBe(input: { namSinh?: string; lop?: string }): TuoiBe | null {
  const now = today();
  const namNay = now.getFullYear();
  const thangNay = now.getMonth() + 1;

  const rawNam = (input.namSinh ?? "").trim();
  if (rawNam) {
    // "8/2019" | "tháng 8 năm 2019" | "2019" → nhặt mọi cụm số, năm là cụm 4 chữ số.
    const cum = rawNam.match(/\d{1,4}/g) ?? [];
    const nam = cum.map(Number).find((n) => n >= 1900 && n <= namNay);
    if (nam) {
      const thang = cum.map(Number).find((n) => n >= 1 && n <= 12 && n !== nam);
      if (thang) {
        const tuoi = namNay - nam - (thangNay < thang ? 1 : 0);
        return { min: tuoi, max: tuoi, nguon: `sinh ${thang}/${nam}` };
      }
      // chỉ có NĂM → chưa biết đã qua sinh nhật chưa → khoảng 1 tuổi
      return { min: namNay - nam - 1, max: namNay - nam, nguon: `sinh năm ${nam}` };
    }
  }

  const lop = soDau((input.lop ?? "").trim(), 2);
  // Lớp 1 ở Việt Nam vào 6 tuổi → lớp N ứng với 5+N đến 6+N tuổi (tuỳ đã sinh nhật chưa).
  if (lop && lop >= 1 && lop <= 12) return { min: 5 + lop, max: 6 + lop, nguon: `đang học lớp ${lop}` };
  return null;
}

/** Số ngày từ hôm nay tới lần tới của thứ `target` (0=CN…6=T7); hôm nay → tuần sau. */
function daysUntilWeekday(target: number): number {
  const off = (target - today().getDay() + 7) % 7;
  return off === 0 ? 7 : off;
}

/** Nhãn ngày chính xác từ `ngay_hen_chuan` của classifier ("thu-7" → "thứ Bảy 25/07"). */
export function resolveDayLabel(chuan: string): string {
  if (!chuan) return "";
  if (chuan === "hom-nay") return labelOf(0);
  if (chuan === "ngay-mai") return labelOf(1);
  const target = chuan === "chu-nhat" ? 0 : Number(chuan.slice("thu-".length)) - 1;
  if (Number.isNaN(target) || target < 0 || target > 6) return "";
  return labelOf(daysUntilWeekday(target));
}

/**
 * 2 ngày CỤ THỂ để khách chọn 1-trong-2, tính theo khung mơ hồ khách vừa nói
 * ("cuối tuần" → thứ Bảy + Chủ nhật sắp tới…). Rỗng/không khớp → mai + ngày kia.
 */
export function resolveDayOptions(khung: string): string[] {
  if (khung === "cuoi-tuan") {
    const sat = daysUntilWeekday(6);
    return [labelOf(sat), labelOf(sat + 1)];
  }
  if (khung === "dau-tuan-sau" || khung === "tuan-sau") {
    const mon = daysUntilWeekday(1);
    return [labelOf(mon), labelOf(mon + 1)];
  }
  if (khung === "trong-tuan") {
    // 2 ngày làm việc gần nhất kể từ mai
    const dow = today().getDay();
    const out: string[] = [];
    for (let i = 1; out.length < 2 && i <= 9; i++) {
      const wd = (dow + i) % 7;
      if (wd !== 0 && wd !== 6) out.push(labelOf(i));
    }
    return out;
  }
  return [labelOf(1), labelOf(2)];
}

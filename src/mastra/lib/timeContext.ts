/**
 * lib/timeContext.ts — Bối cảnh THỜI GIAN THẬT + KÍP TRỰC cho tư vấn viên.
 *
 * Vì sao cần: model không tự biết "bây giờ là mấy giờ". Trước đây lịch sử đưa vào không có mốc
 * thời gian → bot nhầm "tối nay" thành "hôm qua" (case 23:08 ngày 14/08 bot lại nói "như hôm qua").
 * File này tính giờ Việt Nam thật, chọn tên nhân viên đang trực theo ca, và dựng khối bối cảnh để
 * chèn vào system prompt mỗi lượt. KHÔNG cache — tính lại mỗi request (giờ luôn tươi).
 *
 * Toàn bộ mốc giờ quy về Asia/Ho_Chi_Minh (server có thể ở TZ bất kỳ).
 */

import { DEFAULT_CONFIG, type BotRuntimeConfig, type ShiftCfg } from "./settings";

const VN_TZ = "Asia/Ho_Chi_Minh";

const WEEKDAY_VI: Record<string, string> = {
  Monday: "Thứ Hai",
  Tuesday: "Thứ Ba",
  Wednesday: "Thứ Tư",
  Thursday: "Thứ Năm",
  Friday: "Thứ Sáu",
  Saturday: "Thứ Bảy",
  Sunday: "Chủ Nhật",
};

export interface VNParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekdayVi: string; // "Thứ Sáu"
  dayKey: string; // "2026-08-14" (theo lịch VN) — để so sánh cùng ngày
  hhmm: string; // "23:17"
  ddmm: string; // "14/08"
  ddmmyyyy: string; // "14/08/2026"
}

/** Bóc các thành phần lịch VN của 1 mốc thời gian (mặc định: bây giờ). */
export function vnParts(d: Date = new Date()): VNParts {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: VN_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(d)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // một số môi trường trả "24" lúc nửa đêm
  const minute = Number(map.minute);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekdayVi: WEEKDAY_VI[map.weekday] ?? map.weekday,
    dayKey: `${year}-${pad(month)}-${pad(day)}`,
    hhmm: `${pad(hour)}:${pad(minute)}`,
    ddmm: `${pad(day)}/${pad(month)}`,
    ddmmyyyy: `${pad(day)}/${pad(month)}/${year}`,
  };
}

export interface Shift {
  name: string; // tên nhân viên đang trực
  label: string; // "ca đêm" — mô tả ca
}

/** Giờ thuộc khung [start,end)? Hỗ trợ khung QUA ĐÊM (start > end, VD 22 → 6). start==end → rỗng. */
export function inHourRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Kíp trực theo giờ VN — chọn ca đầu tiên khớp giờ hiện tại. Tên/giờ từng ca do admin cấu hình
 * (mặc định: Trang/Xuân/Thảo/Vân/Liên). Cùng khung giờ luôn ra cùng người → nhất quán trong 1 buổi
 * chat. Không ca nào khớp (admin cấu hình lệch/lỗ hổng) → lấy ca đầu danh sách làm lưới an toàn.
 */
export function shiftFor(hour: number, shifts: ShiftCfg[] = DEFAULT_CONFIG.shifts): Shift {
  const list = shifts.length ? shifts : DEFAULT_CONFIG.shifts;
  const hit = list.find((s) => inHourRange(hour, s.start, s.end));
  const s = hit ?? list[0];
  return { name: s.name, label: s.label };
}

/** Trong khung "nghỉ đêm" → giục khách đi ngủ, không cố bán thêm. Hỗ trợ khung qua đêm. */
export function isLateNight(hour: number, start = DEFAULT_CONFIG.lateNightStart, end = DEFAULT_CONFIG.lateNightEnd): boolean {
  return inHourRange(hour, start, end);
}

/**
 * Dấu thời gian gọn đặt đầu mỗi tin lịch sử để model hiểu đúng mốc:
 *   - cùng ngày với "bây giờ" → chỉ "HH:MM"
 *   - khác ngày → "HH:MM DD/MM"
 */
export function stampFor(created: Date, now: VNParts): string {
  const p = vnParts(created);
  return p.dayKey === now.dayKey ? p.hhmm : `${p.hhmm} ${p.ddmm}`;
}

/** Khối bối cảnh thời gian + kíp trực để chèn vào system prompt (giờ/ca/nghỉ đêm theo config admin). */
export function buildTimeBlock(now: VNParts = vnParts(), config: BotRuntimeConfig = DEFAULT_CONFIG): string {
  const shift = shiftFor(now.hour, config.shifts);
  const lines = [
    "[BỐI CẢNH THỜI GIAN & KÍP TRỰC — SỰ THẬT, đọc kỹ trước khi trả lời]",
    `- Bây giờ là ${now.weekdayVi}, ${now.hhmm} ngày ${now.ddmmyyyy} (giờ Việt Nam).`,
    `- Em đang trực ${shift.label}, tên em là ${shift.name}. Nếu khách hỏi tên thì xưng đúng tên "${shift.name}" một cách tự nhiên, không né tránh.`,
    "- Mỗi tin trong lịch sử bên dưới có dấu (HH:MM) ở đầu là GIỜ GỬI THẬT. Dựa vào đó để hiểu đúng mốc thời gian: những gì vừa trao đổi trong buổi chat này là của HÔM NAY — TUYỆT ĐỐI đừng gọi nhầm thành \"hôm qua\"/\"mấy hôm trước\". Chỉ nói \"hôm qua\" khi dấu thời gian thật sự ở ngày trước đó.",
    "- Dấu (HH:MM) chỉ là ghi chú hệ thống — KHÔNG được lặp lại trong câu trả lời của em.",
  ];
  if (isLateNight(now.hour, config.lateNightStart, config.lateNightEnd)) {
    // Tham chiếu giờ config (KHÔNG hard-code "23h") — admin đổi khung thì câu lệnh vẫn khớp giờ thật,
    // tránh mâu thuẫn "bây giờ 13:30" mà lại bảo "đã quá 23h" khiến model bỏ qua.
    lines.push(
      `- BÂY GIỜ ĐÃ TRONG KHUNG NGHỈ ĐÊM (từ ${config.lateNightStart}h khuya tới ${config.lateNightEnd}h sáng): muộn rồi, hãy nhẹ nhàng giục khách đi ngủ sớm, hẹn mai tư vấn tiếp; KHÔNG cố chốt/bán thêm. Khách còn nhắn thì vẫn ưu tiên khuyên nghỉ ngơi, giữ 1-2 câu ấm áp rồi hẹn mai.`,
    );
  }
  return lines.join("\n");
}

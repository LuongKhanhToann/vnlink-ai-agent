// lib/dateHelper.ts
// Trả về ngày hiện tại theo múi giờ Việt Nam, kèm helpers resolve tương đối

const VN_TZ = "Asia/Ho_Chi_Minh";

const DAY_NAMES = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];

export function getNowVN(): Date {
  // Tạo Date đúng múi giờ VN
  return new Date(new Date().toLocaleString("en-US", { timeZone: VN_TZ }));
}

export function formatDate(d: Date): string {
  // "Thứ 4, 23/04/2025"
  const dow = DAY_NAMES[d.getDay()];
  const dd  = String(d.getDate()).padStart(2, "0");
  const mm  = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dow}, ${dd}/${mm}/${yyyy}`;
}

/**
 * Trả về context ngày để inject vào LLM prompt.
 * Ví dụ:
 *   Hôm nay: Thứ 4, 23/04/2025
 *   Ngày mai: Thứ 5, 24/04/2025
 *   Thứ 2 tuần này: 21/04/2025 (đã qua)
 *   Thứ 2 tuần sau: 28/04/2025
 *   Cuối tuần này: Thứ 7 26/04 | Chủ nhật 27/04
 */
export function buildDateContext(): string {
  const now = getNowVN();
  const today = formatDate(now);

  // Mốc Thứ 2 của TUẦN HIỆN TẠI (lịch Thứ 2–Chủ nhật) để gán nhãn tuần CHÍNH XÁC,
  // KHỚP với suggestDatePair / nextWeekMonday. KHÔNG dùng cửa sổ trượt 7 ngày — vì
  // nếu hôm nay là Thứ 6 thì Thứ 2 (sau 3 ngày) phải là "tuần sau", không phải "tuần này".
  const dayMon = now.getDay() === 0 ? 7 : now.getDay(); // T2=1..CN=7
  const mondayThisWeek = new Date(now);
  mondayThisWeek.setDate(now.getDate() - (dayMon - 1));
  mondayThisWeek.setHours(0, 0, 0, 0);

  const weekLabel = (d: Date): string => {
    const wk = Math.floor((d.getTime() - mondayThisWeek.getTime()) / (7 * 86400000));
    if (wk <= 0) return "tuần này";
    if (wk === 1) return "tuần sau";
    if (wk === 2) return "tuần sau nữa";
    return `${wk} tuần nữa`;
  };

  // Tạo map thứ → ngày trong 14 ngày tới để LLM tham chiếu.
  // Mỗi dòng đều có thứ rõ ràng để classifier không nhầm khi resolve "ngày mai" / "thứ 7".
  const upcoming: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dow = DAY_NAMES[d.getDay()];
    const prefix =
      i === 1
        ? `Ngày mai (${dow})`
        : `${dow} ${weekLabel(d)}`;
    upcoming.push(`  ${prefix}: ${dd(d)}/${mm(d)}/${d.getFullYear()}`);
  }

  return `Hôm nay: ${today}\n${upcoming.join("\n")}`;
}

function dd(d: Date) { return String(d.getDate()).padStart(2, "0"); }
function mm(d: Date) { return String(d.getMonth() + 1).padStart(2, "0"); }

/**
 * Resolve thứ-trong-tuần từ chuỗi DD/MM. Năm tự suy: nếu DD/MM đã qua trong năm
 * hiện tại thì +1 năm.
 *
 * Trả về tên thứ tiếng Việt: "thứ 2"..."thứ 7" hoặc "chủ nhật". Trả null nếu invalid.
 */
export function weekdayOf(ddmm: string): string | null {
  const m = ddmm.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  const now = getNowVN();
  let date = new Date(now.getFullYear(), month - 1, day);
  // Nếu ngày đã qua hơn 1 tuần trước → giả định năm sau (tránh trường hợp khách
  // báo lịch trong quá khứ).
  if (date.getTime() < now.getTime() - 7 * 86400000) {
    date = new Date(now.getFullYear() + 1, month - 1, day);
  }
  return DAY_NAMES[date.getDay()].toLowerCase();
}

/**
 * Verify + sửa thứ-trong-tuần trong chuỗi preferredTime.
 * Nếu chuỗi có cả "thứ X" / "chủ nhật" / "cn" và "DD/MM" mà 2 thứ này không khớp
 * → giữ DD/MM, sửa lại tên thứ cho đúng.
 *
 * VD: "9h sáng thứ 7 26/04" với 26/04 là CN → "9h sáng chủ nhật 26/04".
 */
export function verifyWeekdayInTime(s: string | null): string | null {
  if (!s) return s;
  const ddmmMatch = s.match(/(\d{1,2})\/(\d{1,2})/);
  if (!ddmmMatch) return s;

  const correct = weekdayOf(`${ddmmMatch[1]}/${ddmmMatch[2]}`);
  if (!correct) return s;

  const weekdayRegex = /(thứ\s?[2-7]|chủ\s?nhật|\bcn\b)/i;
  const stated = s.match(weekdayRegex);
  if (!stated) return s; // chuỗi không có thứ → không cần verify

  const statedNorm = stated[0]
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^cn$/, "chủ nhật");

  if (statedNorm === correct) return s; // đã khớp
  return s.replace(weekdayRegex, correct);
}

// ─────────────────────────────────────────────
// CHỐT NGÀY — đề xuất 2 NGÀY cụ thể (đòn bán hàng "chọn 1 trong 2")
// 22/07 — DỌN LEGACY: gỡ hasConcreteDate / hasDateWindow / DatePair / suggestDatePair.
// Cả 4 chỉ phục vụ prefixBuilder + routerWorkflow (đã xoá) — engine mới để LLM tự chốt ngày
// từ khối NGÀY do brain.ts dựng, không cần bộ đề-xuất-2-ngày bằng regex nữa.

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(base.getDate() + n);
  return d;
}

/** Thứ 2 của TUẦN SAU (tuần kế tiếp tuần hiện tại). */
function nextWeekMonday(from: Date): Date {
  const dayMon = from.getDay() === 0 ? 7 : from.getDay(); // T2=1..CN=7
  return addDays(from, 8 - dayMon);
}

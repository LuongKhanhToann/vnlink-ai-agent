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

  // Tạo map thứ → ngày trong 14 ngày tới để LLM tham chiếu.
  // Mỗi dòng đều có thứ rõ ràng để classifier không nhầm khi resolve "ngày mai" / "thứ 7".
  const upcoming: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const dow = DAY_NAMES[d.getDay()];
    const week = i <= 7 ? "tuần này" : "tuần sau";
    const prefix =
      i === 1
        ? `Ngày mai (${dow})`
        : `${dow} ${week}`;
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
//
// Sale cần ngày chuẩn để biết khách đến lúc nào / gọi xác nhận. Khi khách nói
// mơ hồ ("đầu tuần sau", "đầu tháng", "tầm chiều") → tính ra cửa sổ ngày dựa
// vào hôm nay rồi đưa khách 2 lựa chọn ngày cụ thể. Bị buộc chọn → khách dễ chốt.
// ─────────────────────────────────────────────

/** preferredTime đã có ngày cụ thể (DD/MM) chưa. */
export function hasConcreteDate(s: string | null | undefined): boolean {
  return !!s && /\d{1,2}\/\d{1,2}/.test(s);
}

/**
 * preferredTime đã có CỬA SỔ ngày (tuần/tháng/hôm tương đối) chưa — để phân biệt
 * với trường hợp khách MỚI chỉ nói buổi ("sáng"/"chiều") hoặc chưa nói gì về ngày.
 *
 * Quy trình chốt lịch 2 bước (theo phản hồi sale):
 *   1. Khách chưa nói ngày (null / chỉ buổi)  → HỎI MỞ "qua hôm nào" trước.
 *   2. Khách nói cửa sổ mơ hồ ("đầu tháng sau", "tuần sau", "cuối tuần", "mai"...)
 *      → MỚI ÉP CHỌN 1-trong-2 ngày cụ thể trong cửa sổ đó (dùng suggestDatePair).
 *
 * hasConcreteDate (DD/MM) → đã chốt, không cần bước nào nữa.
 */
export function hasDateWindow(s: string | null | undefined): boolean {
  if (!s) return false;
  return /(đầu\s*tuần|giữa\s*tuần|cuối\s*tuần|tuần\s*(sau|tới|này)|đầu\s*tháng|giữa\s*tháng|cuối\s*tháng|tháng\s*(sau|tới|này)|(vài|mấy)\s*hôm|hôm\s*nào|ngày\s*kia|\bmai\b|\bmốt\b|thứ\s*[2-7]|chủ\s*nhật|\bcn\b)/i.test(
    s,
  );
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(base.getDate() + n);
  return d;
}

/** Ngày kế tiếp có thứ = targetDow (0=CN..6=T7), luôn ở TƯƠNG LAI (>= mai). */
function upcomingDow(from: Date, targetDow: number): Date {
  let diff = (targetDow - from.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return addDays(from, diff);
}

/** Thứ 2 của TUẦN SAU (tuần kế tiếp tuần hiện tại). */
function nextWeekMonday(from: Date): Date {
  const dayMon = from.getDay() === 0 ? 7 : from.getDay(); // T2=1..CN=7
  return addDays(from, 8 - dayMon);
}

/** Tên thứ viết thường: "thứ 2" / "chủ nhật". */
function weekdayLower(d: Date): string {
  return DAY_NAMES[d.getDay()].toLowerCase();
}

/**
 * Format 1 lựa chọn ngày.
 *   - withDate=false (cửa sổ GẦN — trong/đầu/giữa/cuối tuần) → chỉ thứ: "thứ 2".
 *     Tuần gần khách hiểu ngay, kèm "(8/7)" là thừa.
 *   - withDate=true  (cửa sổ XA — theo tháng) → kèm ngày: "thứ 2 (8/7)".
 */
function fmtDayOption(d: Date, withDate: boolean): string {
  const dow = weekdayLower(d);
  return withDate ? `${dow} (${d.getDate()}/${d.getMonth() + 1})` : dow;
}

export interface DatePair {
  /** 2 chuỗi hiển thị (proximity-aware): gần → "thứ 2"; xa → "thứ 2 (8/7)". */
  options: [string, string];
  /** 2 tên thứ thuần (luôn không kèm ngày) — tiện cho mustInclude/validator. */
  weekdays: [string, string];
}

/**
 * Từ cụm thời gian (mơ hồ hoặc null) của khách → đề xuất 2 NGÀY cụ thể để khách
 * chọn 1-trong-2. Mốc là getNowVN(). KHÔNG bao giờ trả null — nếu không nhận
 * diện được cụm thì fallback "ngày mai" & "ngày kia".
 *
 * Quy ước cửa sổ: đầu tuần=T2&T3, giữa tuần=T4&T5, cuối tuần=T7&CN,
 *   đầu tháng=ngày 1-5, giữa tháng=13-17, cuối tháng=25-28.
 *   Có "sau"/"tới" → dịch sang tuần kế tiếp.
 *
 * Định dạng hiển thị theo độ XA: cửa sổ theo TUẦN → chỉ nói thứ ("thứ 2 hay thứ 3");
 *   cửa sổ theo THÁNG → kèm ngày cụ thể ("thứ 2 (1/7) hay thứ 3 (2/7)").
 */
export function suggestDatePair(phrase: string | null | undefined): DatePair {
  const now = getNowVN();
  const p = (phrase ?? "").toLowerCase();

  // 2 ngày gần nhất chưa qua trong khoảng ngày-trong-tháng [lo, hi];
  // ưu tiên tháng này, hết thì sang tháng sau.
  const monthPick = (lo: number, hi: number): [Date, Date] => {
    const picks: Date[] = [];
    for (let mOff = 0; mOff <= 1 && picks.length < 2; mOff++) {
      for (let day = lo; day <= hi && picks.length < 2; day++) {
        const d = new Date(now.getFullYear(), now.getMonth() + mOff, day);
        if (d.getTime() > now.getTime()) picks.push(d);
      }
    }
    return picks.length >= 2 ? [picks[0], picks[1]] : [addDays(now, 1), addDays(now, 2)];
  };

  const nextWeek = /tuần\s*(sau|tới)/.test(p);

  let a: Date;
  let b: Date;
  let withDate: boolean;

  // ── Cửa sổ theo TUẦN (gần → chỉ nói thứ) ──
  if (/cuối\s*tuần/.test(p)) {
    a = nextWeek ? addDays(nextWeekMonday(now), 5) : upcomingDow(now, 6);
    b = addDays(a, 1); // T7 & CN
    withDate = false;
  } else if (/giữa\s*tuần/.test(p)) {
    a = nextWeek ? addDays(nextWeekMonday(now), 2) : upcomingDow(now, 3);
    b = addDays(a, 1); // T4 & T5
    withDate = false;
  } else if (/đầu\s*tuần/.test(p)) {
    a = nextWeek ? nextWeekMonday(now) : upcomingDow(now, 1);
    b = addDays(a, 1); // T2 & T3
    withDate = false;
  } else if (nextWeek) {
    a = nextWeekMonday(now);
    b = addDays(a, 2); // T2 & T4
    withDate = false;

  // ── Cửa sổ theo THÁNG (xa → kèm ngày cụ thể) ──
  } else if (/tháng\s*(sau|tới)/.test(p)) {
    a = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    b = new Date(now.getFullYear(), now.getMonth() + 1, 2);
    withDate = true;
  } else if (/đầu\s*tháng/.test(p)) {
    [a, b] = monthPick(1, 5);
    withDate = true;
  } else if (/giữa\s*tháng/.test(p)) {
    [a, b] = monthPick(13, 17);
    withDate = true;
  } else if (/cuối\s*tháng/.test(p)) {
    [a, b] = monthPick(25, 28);
    withDate = true;

  // ── "vài hôm nữa" / "mấy hôm nữa" / "hôm nào đó" (gần) ──
  } else if (/(vài|mấy)\s*hôm|hôm\s*nào/.test(p)) {
    a = addDays(now, 2);
    b = addDays(now, 3);
    withDate = false;

  // ── Mặc định: ngày mai & ngày kia (gần) ──
  } else {
    a = addDays(now, 1);
    b = addDays(now, 2);
    withDate = false;
  }

  return {
    options: [fmtDayOption(a, withDate), fmtDayOption(b, withDate)],
    weekdays: [weekdayLower(a), weekdayLower(b)],
  };
}
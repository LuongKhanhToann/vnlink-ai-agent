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

/** Format 1 lựa chọn ngày: "thứ 2 (8/7)". */
function fmtDayOption(d: Date): string {
  const dow = DAY_NAMES[d.getDay()].toLowerCase();
  return `${dow} (${d.getDate()}/${d.getMonth() + 1})`;
}

export interface DatePair {
  /** 2 chuỗi ngày cụ thể, vd ["thứ 2 (8/7)", "thứ 3 (9/7)"]. */
  options: [string, string];
}

/**
 * Từ cụm thời gian (mơ hồ hoặc null) của khách → đề xuất 2 NGÀY cụ thể để khách
 * chọn 1-trong-2. Mốc là getNowVN(). KHÔNG bao giờ trả null — nếu không nhận
 * diện được cụm thì fallback "ngày mai" & "ngày kia".
 *
 * Quy ước cửa sổ: đầu tuần=T2&T3, giữa tuần=T4&T5, cuối tuần=T7&CN,
 *   đầu tháng=ngày 1-5, giữa tháng=13-17, cuối tháng=25-28.
 *   Có "sau"/"tới" → dịch sang tuần kế tiếp.
 */
export function suggestDatePair(phrase: string | null | undefined): DatePair {
  const now = getNowVN();
  const p = (phrase ?? "").toLowerCase();
  const mk = (a: Date, b: Date): DatePair => ({
    options: [fmtDayOption(a), fmtDayOption(b)],
  });

  // 2 ngày gần nhất chưa qua trong khoảng ngày-trong-tháng [lo, hi];
  // ưu tiên tháng này, hết thì sang tháng sau.
  const monthRange = (lo: number, hi: number): DatePair => {
    const picks: Date[] = [];
    for (let mOff = 0; mOff <= 1 && picks.length < 2; mOff++) {
      for (let day = lo; day <= hi && picks.length < 2; day++) {
        const d = new Date(now.getFullYear(), now.getMonth() + mOff, day);
        if (d.getTime() > now.getTime()) picks.push(d);
      }
    }
    return picks.length >= 2
      ? mk(picks[0], picks[1])
      : mk(addDays(now, 1), addDays(now, 2));
  };

  const nextWeek = /tuần\s*(sau|tới)/.test(p);

  // ── Cửa sổ theo TUẦN ──
  if (/cuối\s*tuần/.test(p)) {
    const sat = nextWeek ? addDays(nextWeekMonday(now), 5) : upcomingDow(now, 6);
    return mk(sat, addDays(sat, 1)); // T7 & CN
  }
  if (/giữa\s*tuần/.test(p)) {
    const wed = nextWeek ? addDays(nextWeekMonday(now), 2) : upcomingDow(now, 3);
    return mk(wed, addDays(wed, 1)); // T4 & T5
  }
  if (/đầu\s*tuần/.test(p)) {
    const mon = nextWeek ? nextWeekMonday(now) : upcomingDow(now, 1);
    return mk(mon, addDays(mon, 1)); // T2 & T3
  }
  if (nextWeek) {
    const mon = nextWeekMonday(now);
    return mk(mon, addDays(mon, 2)); // T2 & T4
  }

  // ── Cửa sổ theo THÁNG ──
  if (/tháng\s*(sau|tới)/.test(p)) {
    return mk(
      new Date(now.getFullYear(), now.getMonth() + 1, 1),
      new Date(now.getFullYear(), now.getMonth() + 1, 2),
    );
  }
  if (/đầu\s*tháng/.test(p)) return monthRange(1, 5);
  if (/giữa\s*tháng/.test(p)) return monthRange(13, 17);
  if (/cuối\s*tháng/.test(p)) return monthRange(25, 28);

  // ── "vài hôm nữa" / "mấy hôm nữa" / "hôm nào đó" ──
  if (/(vài|mấy)\s*hôm|hôm\s*nào/.test(p)) {
    return mk(addDays(now, 2), addDays(now, 3));
  }

  // ── Mặc định: ngày mai & ngày kia ──
  return mk(addDays(now, 1), addDays(now, 2));
}
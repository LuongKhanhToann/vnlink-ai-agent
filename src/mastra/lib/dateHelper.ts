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

  // Tạo map thứ → ngày trong 14 ngày tới để LLM tham chiếu
  const upcoming: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const label = i === 1 ? "Ngày mai" : formatDate(d);
    upcoming.push(`  ${i === 1 ? "Ngày mai" : DAY_NAMES[d.getDay()] + " " + (i <= 7 ? "tuần này" : "tuần sau")}: ${dd(d)}/${mm(d)}/${d.getFullYear()}`);
  }

  return `Hôm nay: ${today}\n${upcoming.join("\n")}`;
}

function dd(d: Date) { return String(d.getDate()).padStart(2, "0"); }
function mm(d: Date) { return String(d.getMonth() + 1).padStart(2, "0"); }
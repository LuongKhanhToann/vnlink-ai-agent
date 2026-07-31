/**
 * bodyStats.ts — tra BẢNG CÂN CHUẨN bằng CODE cho mạch giảm/tăng cân.
 *
 * Vì sao code làm thay model (giống dates.tinhTuoiBe): 12B đọc được bảng cân trong prompt nhưng
 * làm phép trừ ra số SAI và mỗi lượt một số khác. Đo LIVE 30/07 (convo 28073559118992079) và
 * replay trên prod: khách 1m70 - 75kg → bot nói "dư khoảng 4-5kg", chạy lại nói "dư 5-6kg";
 * bảng chuẩn của trung tâm cho mốc 1m70 là 55-72kg → đúng phải là DƯ khoảng 3kg. Bot còn bỏ hẳn
 * việc NÊU MỐC cân đối (prompt bắt nêu) nên khách chỉ nhận được một con số trơ không rõ căn cứ.
 *
 * Model vẫn làm phần của model: nó TRÍCH chiều cao - cân nặng khách nói vào slot `the_trang`
 * (hiểu ngôn ngữ). Ở đây chỉ có ĐỌC ĐƠN VỊ + tra bảng + phép trừ — không phán đoán ý khách.
 */

/** Khoảng cân chuẩn theo chiều cao (cm) — khớp BẢNG CÂN CHUẨN trong prompt.ts. */
const BANG: { cm: number; nam: [number, number]; nu: [number, number] }[] = [
  { cm: 150, nam: [47, 56], nu: [43, 52] },
  { cm: 155, nam: [50, 60], nu: [46, 55] },
  { cm: 160, nam: [54, 64], nu: [49, 59] },
  { cm: 165, nam: [57, 68], nu: [52, 63] },
  { cm: 170, nam: [61, 72], nu: [55, 66] },
  { cm: 175, nam: [64, 77], nu: [58, 70] },
  { cm: 180, nam: [68, 81], nu: [62, 75] },
  { cm: 185, nam: [72, 86], nu: [65, 79] },
];

export interface TheTrang {
  cm: number;
  kg: number;
}

/**
 * Đọc chiều cao (cm) + cân nặng (kg) từ slot `the_trang` khách vừa nói.
 * Chỉ nhận khi CHẮC CHẮN cả 2 vế; thiếu/không rõ → null (khi đó hệ thống không bơm mốc nào,
 * bot chạy y như trước chứ không đoán bừa).
 */
export function docTheTrang(raw: string): TheTrang | null {
  const s = (raw ?? "").toLowerCase().replace(/,/g, ".");

  let cm: number | null = null;
  // "1m70" / "1m7" / "1 m 58"
  const mCm = s.match(/(\d)\s*m\s*(\d{1,2})(?!\d)/);
  if (mCm) {
    const le = mCm[2];
    cm = Number(mCm[1]) * 100 + (le.length === 1 ? Number(le) * 10 : Number(le));
  }
  // "1.7m" / "1.58 m"
  if (cm === null) {
    const mM = s.match(/(\d\.\d{1,2})\s*m(?![a-z])/);
    if (mM) cm = Math.round(Number(mM[1]) * 100);
  }
  // "170cm" / "170 cm"
  if (cm === null) {
    const mCmDon = s.match(/(\d{3})\s*cm/);
    if (mCmDon) cm = Number(mCmDon[1]);
  }
  // số trần 3 chữ số trong khoảng chiều cao người ("cao 165 nặng 60")
  if (cm === null) {
    const mTran = s.match(/(?:^|[^\d.])(1[2-9]\d|2[0-2]\d)(?![\d.])/);
    if (mTran) cm = Number(mTran[1]);
  }

  let kg: number | null = null;
  const mKg = s.match(/(\d{2,3})(?:\.\d)?\s*(?:kg|kí|ký|ki lô|kilo)/);
  if (mKg) kg = Number(mKg[1]);
  if (kg === null) {
    const mNang = s.match(/nặng\s*(?:khoảng\s*)?(\d{2,3})/);
    if (mNang) kg = Number(mNang[1]);
  }

  if (cm === null || kg === null) return null;
  if (cm < 120 || cm > 220 || kg < 25 || kg > 250) return null;
  return { cm, kg };
}

/** Nội suy khoảng chuẩn theo chiều cao (ngoài bảng thì kẹp về đầu/cuối bảng). */
function khoangChuan(cm: number, gioi: "anh" | "chi" | "chua-ro"): [number, number] {
  const lay = (row: (typeof BANG)[number]): [number, number] =>
    gioi === "anh" ? row.nam : gioi === "chi" ? row.nu : [Math.min(row.nu[0], row.nam[0]), Math.max(row.nu[1], row.nam[1])];

  if (cm <= BANG[0].cm) return lay(BANG[0]);
  if (cm >= BANG[BANG.length - 1].cm) return lay(BANG[BANG.length - 1]);
  for (let i = 0; i < BANG.length - 1; i++) {
    const a = BANG[i];
    const b = BANG[i + 1];
    if (cm >= a.cm && cm <= b.cm) {
      const [aLo, aHi] = lay(a);
      const [bLo, bHi] = lay(b);
      const t = (cm - a.cm) / (b.cm - a.cm);
      return [Math.round(aLo + (bLo - aLo) * t), Math.round(aHi + (bHi - aHi) * t)];
    }
  }
  return lay(BANG[BANG.length - 1]);
}

/** Chiều cao dạng người đọc: 170 → "1m70". */
function nhanChieuCao(cm: number): string {
  const m = Math.floor(cm / 100);
  const le = String(cm % 100).padStart(2, "0");
  return `${m}m${le}`;
}

export interface CanChuan {
  cm: number;
  kg: number;
  /** Mép dưới / mép trên của khoảng cân đối theo chiều cao (+ giới nếu đã biết). */
  lo: number;
  hi: number;
  /** Số kg lệch tới MÉP GẦN NHẤT (0 khi đang trong khoảng). */
  lech: number;
  huong: "du" | "thieu" | "trong";
}

/** Tra bảng + trừ ra số lệch. null = không đọc được thể trạng → hệ thống không bơm gì. */
export function tinhCanChuan(theTrang: string, gioi: "anh" | "chi" | "chua-ro"): CanChuan | null {
  const doc = docTheTrang(theTrang);
  if (!doc) return null;
  const [lo, hi] = khoangChuan(doc.cm, gioi);
  if (doc.kg > hi) return { ...doc, lo, hi, lech: doc.kg - hi, huong: "du" };
  if (doc.kg < lo) return { ...doc, lo, hi, lech: lo - doc.kg, huong: "thieu" };
  return { ...doc, lo, hi, lech: 0, huong: "trong" };
}

/**
 * Câu chốt về thể trạng để bơm vào khối bối cảnh — model chỉ việc chép số, không tự tính.
 * Trả "" khi không đọc được thể trạng (bot giữ nguyên hành vi cũ).
 */
export function motaTheTrang(theTrang: string, gioi: "anh" | "chi" | "chua-ro"): string {
  const t = tinhCanChuan(theTrang, gioi);
  if (!t) return "";
  const dau = `khách cao ${nhanChieuCao(t.cm)} nặng ${t.kg}kg → mốc cân đối ${t.lo}-${t.hi}kg`;
  if (t.huong === "du") return `${dau} → đang DƯ khoảng ${t.lech}kg`;
  if (t.huong === "thieu") return `${dau} → đang THIẾU khoảng ${t.lech}kg`;
  return `${dau} → khách ĐANG TRONG mức cân đối (không dư không thiếu)`;
}

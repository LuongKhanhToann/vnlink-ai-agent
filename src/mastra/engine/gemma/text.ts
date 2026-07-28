/**
 * text.ts — tiện ích SOI HÌNH THỨC bản nháp (thuần kỹ thuật, không phán đoán nghiệp vụ).
 *
 * Mọi hàm ở đây chỉ trả lời câu hỏi dạng "chuỗi này có bao nhiêu câu hỏi / có con số tiền
 * không / có gần trùng chuỗi kia không" — việc HIỂU khách vẫn là của classifier LLM.
 */

/** Model không còn được phép tự ghi "MEDIA: key" — nhưng vẫn gỡ phòng khi nó bắt chước. */
export function stripMediaLine(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("MEDIA:"))
    .join("\n")
    .trim();
}

/** Các câu kết thúc bằng "?" trong bản nháp (dùng cho sổ chống-lặp-câu-hỏi). */
export function extractQuestions(text: string): string[] {
  const qs: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "\n") start = i + 1;
    else if (ch === "?") {
      const q = text.slice(start, i + 1).trim();
      if (q.length > 8) qs.push(q);
      start = i + 1;
    }
  }
  return qs;
}

/** Chuẩn hoá để so trùng: thường hoá, bỏ dấu câu, gộp khoảng trắng. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Độ trùng từ vựng 2 chuỗi đã norm; chuỗi quá ngắn (<5 từ) coi như không so được. */
function jaccard(a: string, b: string): number {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  if (A.size < 5 || B.size < 5) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Câu hỏi đầu tiên trong `draft` trùng/na ná một câu đã hỏi trước đó — null nếu không có. */
export function findRepeatedQuestion(draft: string, askedNorms: string[]): string | null {
  for (const q of extractQuestions(draft)) {
    const n = norm(q);
    if (askedNorms.some((s) => s === n || jaccard(n, s) >= 0.72)) return q;
  }
  return null;
}

/**
 * Cả tin gần trùng một tin bot đã nhắn trước đó.
 *
 * Ngưỡng 0.66 chứ không phải 0.75: ca CAPTINH lượt 3 chép lại gần nguyên tin lượt 2 (chỉ đổi
 * "vùng cơ" thành "vùng cổ chân", bỏ vế "hạn chế đi lại") đo được đúng ~0.75 nên lọt lưới.
 * Hạ ngưỡng làm tăng số lần sinh lại, nhưng sinh lại rẻ hơn nhiều so với việc khách hỏi câu
 * mới mà nhận lại y nguyên tin cũ.
 */
export function isRepeatedReply(draft: string, prevReplyNorms: string[]): boolean {
  const n = norm(draft);
  return prevReplyNorms.some((p) => n === p || jaccard(n, p) >= 0.66);
}

/**
 * CHỖ TRỐNG ĐỂ ĐIỀN còn sót trong tin ("[Số điện thoại của bạn]", "[tên trung tâm]") — model
 * bắt chước mẫu điền form rồi gửi thẳng cho khách (bắt được LIVE 26/07 convo 38412582635006991:
 * "Số điện thoại của em là [Số điện thoại của bạn]" — gửi 2 lần).
 *
 * Thuần SOI HÌNH THỨC: văn phong đã cấm markdown/link nên không có ngoặc vuông hợp lệ nào trong
 * tin gửi khách. Trả nguyên cụm bắt được (kể cả ngoặc) để ghi log + vá cơ học.
 */
export function findPlaceholderSlot(text: string): string | null {
  const m = text.match(/\[[^\]\n]{1,60}\]/);
  return m ? m[0] : null;
}

/**
 * Tin có KHẲNG ĐỊNH MỘT NGÀY CỤ THỂ không ("ngày mai", "thứ Bảy", "chủ nhật", "hôm nay")?
 *
 * Dùng cho luật: state CHƯA có ngày hẹn nào mà tin lại nói "vậy ngày mai mình qua nhé" = tự chốt
 * hộ khách một ngày họ chưa chọn (đo LIVE 26/07: khách nói "hôm sau mình sẽ ghé qua" → bot đáp
 * "vậy ngày mai bạn ghé qua…"). Thuần SOI TỪ trong tin bot, không phán đoán ý khách.
 */
export function findNgayKhangDinh(text: string): string | null {
  const low = text.toLowerCase();
  const tu = ["ngày mai", "hôm nay", "ngày kia", "thứ hai", "thứ ba", "thứ tư", "thứ năm", "thứ sáu", "thứ bảy", "chủ nhật", "thứ 2", "thứ 3", "thứ 4", "thứ 5", "thứ 6", "thứ 7"];
  for (const t of tu) if (low.includes(t)) return t;
  // "mai" đứng RIÊNG (không phải "ngày mai" đã bắt ở trên, không nằm trong từ khác)
  const m = low.match(/(^|[\s,.:;"“(])mai([\s,.:;"”)!?]|$)/);
  return m ? "mai" : null;
}

/**
 * Tin CHỈ có lời chào/cảm ơn, không có nội dung nào khác?
 *
 * Lượt ĐẦU là lượt quan trọng nhất mà 12B thỉnh thoảng chỉ chào rồi im (đo ở replay LIVE
 * 26/07 convo 28112002548394082: khách hỏi "Học bơi trong bao lâu?" nhận lại đúng câu
 * "Dạ em chào anh/chị, cảm ơn anh/chị đã quan tâm đến dịch vụ của trung tâm ạ."). Soi hình thức:
 * bỏ các câu chào/cảm ơn/giới thiệu, còn lại gần như rỗng nghĩa là tin không nói gì.
 */
export function chiLaLoiChao(text: string): boolean {
  const conLai = text
    .split(/(?<=[.!?\n])\s*/)
    .filter((cau) => {
      const s = cau.toLowerCase();
      return !(
        s.includes("em chào") ||
        s.includes("cảm ơn") ||
        s.includes("cám ơn") ||
        s.trim().length === 0
      );
    })
    .join(" ")
    .trim();
  return text.trim().length > 0 && conLai.length < 15;
}

/**
 * Tin ĐÃ CÓ lời dặn y tế chưa (hỏi bác sĩ / giấy khám / theo dõi ở bệnh viện)?
 *
 * Nhận cả cách nói tương đương chứ không chỉ đúng câu mẫu: YTE#2 dặn "vẫn nên duy trì thăm khám
 * tại bệnh viện" — đó LÀ lời dặn y tế, nếu không tính thì lượt sau bị ép nhét thêm câu "nhớ hỏi
 * bác sĩ trước khi tập" vào một câu trả lời chẳng liên quan (khách hỏi có bán thuốc giảm cân).
 */
export function coVeAnToan(text: string): boolean {
  return /bác sĩ|giấy khám|bệnh viện|cơ sở y tế|thăm khám/i.test(text);
}

/** Bỏ CẢ CÂU chứa cụm `frag` (cắt ở ranh giới câu) — dùng để vá cơ học khi sinh lại vẫn dính. */
export function dropSentenceContaining(text: string, frag: string): string {
  const idx = text.indexOf(frag);
  if (idx < 0) return text;
  const isEnd = (ch: string) => ch === "." || ch === "!" || ch === "?" || ch === "\n";
  let start = idx;
  while (start > 0 && !isEnd(text[start - 1])) start--;
  let end = idx + frag.length;
  while (end < text.length && !isEnd(text[end])) end++;
  if (end < text.length) end++; // nuốt luôn dấu kết câu
  return (text.slice(0, start) + text.slice(end)).replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
}

/**
 * Đếm số MỐC TIỀN xuất hiện trong tin ("500 nghìn", "4.5 triệu", "330k").
 * Thuần đếm dạng chữ — dùng cho luật văn phong "1 tin = 1 mốc giá", không suy diễn ý khách.
 */
export function countMoneyMentions(text: string): number {
  return (text.match(/\d+([.,]\d+)?\s*(nghìn|ngàn|triệu|tr\b|k\b|đồng)/gi) ?? []).length;
}

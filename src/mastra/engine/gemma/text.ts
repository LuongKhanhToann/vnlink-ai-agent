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
 * Đếm số MỐC TIỀN xuất hiện trong tin ("500 nghìn", "4.5 triệu", "330k").
 * Thuần đếm dạng chữ — dùng cho luật văn phong "1 tin = 1 mốc giá", không suy diễn ý khách.
 */
export function countMoneyMentions(text: string): number {
  return (text.match(/\d+([.,]\d+)?\s*(nghìn|ngàn|triệu|tr\b|k\b|đồng)/gi) ?? []).length;
}

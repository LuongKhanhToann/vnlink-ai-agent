/**
 * lib/cleanReply.ts
 *
 * Post-process reply từ agent để strip các pattern không tự nhiên / vi phạm rule:
 *  - Khen giả "Tuyệt vời / Tuyệt quá / Chắc chắn rồi..." → thay bằng "Dạ vâng" hoặc bỏ
 *  - Hứa giả "em sẽ gửi hình" mà không thật sự có media → cắt câu đó
 *  - Markdown bold/italic
 *  - URL leak vào text
 *  - Whitespace dư
 *
 * Deterministic: zero cost, không tăng variance.
 */

const FAKE_PRAISE_PATTERNS: Array<[RegExp, string]> = [
  // Cum đầu câu — thay bằng "Dạ vâng,"
  [/^(Tuyệt\s+vời|Tuyệt\s+quá|Chắc\s+chắn\s+rồi|Quá\s+hợp\s+lý|Hay\s+quá|Chuẩn\s+rồi|Lựa\s+chọn\s+tuyệt\s+vời|Rất\s+tuyệt|Rất\s+vui\s+được\s+hỗ\s+trợ)\s*[!,.]?\s*/i, "Dạ vâng, "],
  // Cum giữa câu — bỏ luôn (nhẹ nhàng)
  [/\s+(Tuyệt\s+vời|Tuyệt\s+quá|Chắc\s+chắn\s+rồi|Quá\s+hợp\s+lý|Hay\s+quá|Chuẩn\s+rồi|Lựa\s+chọn\s+tuyệt\s+vời|Rất\s+tuyệt)\s*[!,.]?/gi, ""],
];

// "em (sẽ/có thể) gửi hình/ảnh/video..." — cắt cả câu chứa cụm này
const FAKE_MEDIA_OFFER = /[^.?!]*\b(em|để\s+em|chị|anh)\s+(sẽ\s+)?(có\s+thể\s+)?gửi.{0,30}(hình|ảnh|video|clip)[^.?!]*[.?!]/gi;

// Filler sáo rỗng — cắt cụm
const FILLER_PATTERNS: RegExp[] = [
  /[^.?!]*\b(em\s+(có\s+thể\s+)?(sẽ\s+)?tư\s+vấn\s+thêm|nếu\s+cần\s+em\s+sẽ\s+tư\s+vấn|em\s+rất\s+mong\s+được\s+hỗ\s+trợ)[^.?!]*[.?!]/gi,
];

// Markdown bold/italic
const MARKDOWN_BOLD = /\*\*([^*]+)\*\*/g;
const MARKDOWN_ITALIC = /(?<!\*)\*([^*]+)\*(?!\*)/g;

// URL leak (khác qrUrl/mediaUrls đã ở field riêng)
const URL_PATTERN = /https?:\/\/\S+/gi;
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]+\)/g;

/**
 * Clean reply text. `hasMedia` = bot có thực sự gửi media qua tool — nếu false,
 * cắt cụm "em gửi hình" giả.
 */
export function cleanReply(text: string, hasMedia: boolean = false): string {
  if (!text) return text;

  let r = text;

  // 1. Khen giả
  for (const [pattern, replacement] of FAKE_PRAISE_PATTERNS) {
    r = r.replace(pattern, replacement);
  }

  // 2. Fake media offer (chỉ cắt khi không có media)
  if (!hasMedia) {
    r = r.replace(FAKE_MEDIA_OFFER, "");
  }

  // 3. Filler
  for (const pattern of FILLER_PATTERNS) {
    r = r.replace(pattern, "");
  }

  // 4. Markdown
  r = r.replace(MARKDOWN_BOLD, "$1");
  r = r.replace(MARKDOWN_ITALIC, "$1");
  r = r.replace(MARKDOWN_LINK, "$1");

  // 5. URL leak (giữ fanpage facebook.com/... vì là plain text)
  r = r.replace(URL_PATTERN, (m) =>
    /facebook\.com/i.test(m) ? m.replace(/^https?:\/\//, "") : "",
  );

  // 6. Whitespace cleanup
  r = r
    .replace(/\s+([,.!?])/g, "$1")  // remove space before punctuation
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 7. Capitalize first letter (sau khi strip "Tuyệt vời" có thể bắt đầu bằng lowercase)
  if (r && /^[a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ]/i.test(r)) {
    r = r[0].toUpperCase() + r.slice(1);
  }

  return r;
}

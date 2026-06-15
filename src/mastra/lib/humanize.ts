/**
 * lib/humanize.ts
 *
 * Lớp "NGƯỜI HOÁ" output — chạy ở SEND layer (routes/facebook.ts), SAU cleanReply.
 *
 * Mục tiêu: sale Zalo/Messenger thật KHÔNG gửi 1 đoạn dài hoàn chỉnh — họ gõ
 * NHIỀU bong bóng ngắn liên tiếp, có "đang soạn tin…", có độ trễ gõ. Bot gửi 1
 * tin tròn vành là dấu hiệu lộ AI rõ nhất. Module này:
 *   1) splitIntoBubbles(): tách reply (đã clean) thành 1-3 bóng ngắn tự nhiên.
 *   2) typingDelayMs(): tính độ trễ "gõ" theo độ dài bóng (cảm giác đang nhập).
 *
 * NGUYÊN TẮC AN TOÀN:
 *   - CHỈ tách, KHÔNG đổi 1 ký tự nội dung → không vỡ mustInclude / không bịa.
 *   - KHÔNG đụng câu kết "ạ" / dấu "?" (đã khoá ở cleanReply).
 *   - List nhiều dòng (\n) → GIỮ nguyên 1 bóng (tách dòng đã đủ "người", cắt rời nhìn vỡ).
 *   - Tách câu hỏi cuối thành bóng riêng (câu hỏi "ping" riêng = rất giống người thật).
 *   - Tối đa 3 bóng; gộp mảnh quá ngắn để không có bóng "Dạ" trơ.
 */

// Số bóng tối đa 1 reply — quá nhiều bóng nhỏ lại thành spam, kém tự nhiên.
const MAX_BUBBLES = 3;
// Mỗi bóng "câu kể" gom tới ~ ngưỡng này thì sang bóng mới (gộp câu ngắn liên tiếp).
const SOFT_BUBBLE_CHARS = 150;
// Bóng ngắn hơn ngưỡng này (mà không phải bóng duy nhất) → gộp với bóng kế cận.
const MIN_BUBBLE_CHARS = 14;

/**
 * Split sentences — copy logic từ cleanReply (không export ở đó) để dùng độc lập.
 * `.` KHÔNG phải hết câu khi đứng giữa 2 chữ số ("1.2 triệu") hoặc marker "(1). ".
 */
function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?])(?!\d)\s+(?=\S)/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isQuestionSentence(s: string): boolean {
  return /[?]\s*$/.test(s.trim());
}

/**
 * Tách reply thành các bong bóng chat. Deterministic — cùng input cho cùng output.
 * Trả [] nếu rỗng. Luôn trả ít nhất 1 phần tử khi có nội dung.
 */
export function splitIntoBubbles(reply: string): string[] {
  const text = (reply ?? "").trim();
  if (!text) return [];

  // List / multi-line → 1 bóng (giữ nguyên, không cắt ngang list).
  if (text.includes("\n")) return [text];

  // Ngắn → 1 bóng.
  if (text.length <= 70) return [text];

  const sentences = splitSentences(text);
  if (sentences.length <= 1) return [text];

  // Tách câu hỏi CUỐI ra (nếu câu cuối là câu hỏi) → bóng riêng.
  let question: string | null = null;
  let statements = sentences;
  if (isQuestionSentence(sentences[sentences.length - 1])) {
    question = sentences[sentences.length - 1];
    statements = sentences.slice(0, -1);
  }

  // Gom các câu kể thành bóng (greedy, mỗi bóng tới SOFT_BUBBLE_CHARS).
  const bubbles: string[] = [];
  let cur = "";
  for (const sent of statements) {
    const next = cur ? `${cur} ${sent}` : sent;
    if (cur && next.length > SOFT_BUBBLE_CHARS) {
      bubbles.push(cur);
      cur = sent;
    } else {
      cur = next;
    }
  }
  if (cur) bubbles.push(cur);
  if (question) bubbles.push(question);

  // Gộp mảnh quá ngắn (vd "Dạ vâng anh." trơ) vào bóng kế tiếp/trước đó.
  const merged: string[] = [];
  for (const b of bubbles) {
    if (
      merged.length > 0 &&
      b.length < MIN_BUBBLE_CHARS &&
      !isQuestionSentence(b)
    ) {
      // mảnh ngắn không phải câu hỏi → gộp vào bóng trước
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${b}`;
      continue;
    }
    if (
      merged.length > 0 &&
      merged[merged.length - 1].length < MIN_BUBBLE_CHARS &&
      !isQuestionSentence(merged[merged.length - 1])
    ) {
      // bóng TRƯỚC quá ngắn → kéo bóng hiện tại ghép vào
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${b}`;
      continue;
    }
    merged.push(b);
  }

  // Cap MAX_BUBBLES: nếu dư, gộp các bóng KỂ (đầu danh sách) lại, giữ câu hỏi cuối.
  while (merged.length > MAX_BUBBLES) {
    // gộp 2 bóng đầu (luôn là câu kể) để bảo toàn câu hỏi cuối nếu có.
    const a = merged.shift()!;
    const b = merged.shift()!;
    merged.unshift(`${a} ${b}`);
  }

  return merged.length ? merged : [text];
}

/**
 * Độ trễ "đang gõ" cho 1 bóng — tỉ lệ độ dài, có sàn/trần để không lố UX.
 * Cảm giác người đang nhập tin: bóng càng dài gõ càng lâu.
 *
 * @param text   nội dung bóng
 * @param isFirst  bóng đầu tiên → trễ ngắn hơn (khách vừa gửi, đừng để chờ lâu)
 */
export function typingDelayMs(text: string, isFirst: boolean = false): number {
  const chars = (text ?? "").length;
  // ~22ms/ký tự ≈ tốc độ gõ nhanh trên điện thoại.
  const raw = Math.round(chars * 22);
  const floor = isFirst ? 350 : 600;
  const cap = isFirst ? 1200 : 1800;
  return Math.min(Math.max(raw, floor), cap);
}

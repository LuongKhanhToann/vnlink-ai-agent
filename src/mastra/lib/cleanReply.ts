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

// Anti-sycophancy: bot khen đáp án của khách (vd "4 buổi/tuần là tần suất rất tốt", "chọn buổi sáng thì tốt quá").
// Strip cum đánh giá khỏi ACK clause; giữ phần nhắc lại + dấu câu kết thúc.
const PRAISE_CUM =
  "(?:rất\\s+tốt|tốt\\s+quá|tốt\\s+rồi|tốt\\s+lắm|ổn\\s+lắm|ổn\\s+rồi|hợp\\s+lý|lý\\s+tưởng|phù\\s+hợp(?:\\s+lắm)?|rất\\s+hợp|hợp\\s+(?:luôn|quá|lắm)|chuẩn\\s+rồi|vậy\\s+là\\s+chuẩn|lựa\\s+chọn\\s+(?:đúng|tốt|hợp\\s+lý))";
const SYCOPHANTIC_ACK_PATTERNS: Array<[RegExp, string]> = [
  // "... là/thì [tần suất|mục tiêu|lựa chọn|cách]? <praise>" → strip từ "là/thì" tới hết praise
  [
    new RegExp(
      `\\s+(?:là|thì)(?:\\s+(?:tần\\s+suất|mục\\s+tiêu|lựa\\s+chọn|cách|cũng))?\\s+${PRAISE_CUM}`,
      "gi",
    ),
    "",
  ],
  // "... tần suất <praise>" (không có "là") → strip cụm "tần suất <praise>"
  [
    new RegExp(`\\s+tần\\s+suất\\s+${PRAISE_CUM}`, "gi"),
    "",
  ],
  // Bare "tần suất ổn" (không có "lắm/rồi") — vẫn là khen mềm, strip
  [
    /\s+(?:là\s+)?tần\s+suất\s+ổn(?!\s+(?:lắm|rồi))(?:\s+(?:anh|chị|anh\/chị|em))?/gi,
    "",
  ],
  // Câu chỉ chứa praise độc lập đầu tin: "Dạ rất tốt ạ. ..." / "Dạ tốt quá ạ. ..."
  [
    new RegExp(`^Dạ\\s+${PRAISE_CUM}\\s*(?:ạ|nha)?\\s*[.,!]?\\s*`, "i"),
    "Dạ ",
  ],
];

// "em (sẽ/có thể) gửi hình/ảnh/video..." — cắt cả câu chứa cụm này
const FAKE_MEDIA_OFFER = /[^.?!]*\b(em|để\s+em|chị|anh)\s+(sẽ\s+)?(có\s+thể\s+)?gửi.{0,30}(hình|ảnh|video|clip)[^.?!]*[.?!]/gi;

// Internal pricing shorthand leak — model copy nguyên cú pháp [PRICING] ra khách.
// Vd: "12m=5tr | 24m=8.6tr | 12m(3b/t)=3tr" → expand sang tiếng Việt.
const PRICING_SHORTHAND_PATTERNS: Array<[RegExp, string]> = [
  // "Xb(Ym)=Ztr" — vd "20b(2m)=6tr" → "20 buổi (2 tháng) 6 triệu"
  [/(\d+)\s*b\s*\(\s*(\d+)\s*m\s*\)\s*=\s*(\d+(?:\.\d+)?)\s*tr\b/gi, "$1 buổi ($2 tháng) $3 triệu"],
  // "Xm(Yb/t)=Ztr" — vd "12m(3b/t)=3tr" → "12 tháng (3 buổi/tuần) 3 triệu"
  [/(\d+)\s*m\s*\(\s*(\d+)\s*b\/t\s*\)\s*=\s*(\d+(?:\.\d+)?)\s*tr\b/gi, "$1 tháng ($2 buổi/tuần) $3 triệu"],
  // "Xm=Ytr" → "X tháng Y triệu"
  [/(\d+)\s*m\s*=\s*(\d+(?:\.\d+)?)\s*tr\b/gi, "$1 tháng $2 triệu"],
  // "Xm=Yk" → "X tháng Y nghìn" (giữ "k" cho gọn)
  [/(\d+)\s*m\s*=\s*(\d+(?:\.\d+)?)\s*k\b/gi, "$1 tháng $2k"],
  // "Xb=Ytr" — PT pitch: "20b=5tr" → "20 buổi 5 triệu"
  [/(\d+)\s*b\s*=\s*(\d+(?:\.\d+)?)\s*tr\b/gi, "$1 buổi $2 triệu"],
  // "Xb/t" còn sót → "X buổi/tuần"
  [/(\d+)\s*b\/t\b/gi, "$1 buổi/tuần"],
  // "fulltime-12m" → "12 tháng fulltime"
  [/fulltime-(\d+)\s*m\b/gi, "$1 tháng fulltime"],
  // "Xm-full=Ytr" → "X tháng fulltime Y triệu"
  [/(\d+)\s*m-full\s*=\s*(\d+(?:\.\d+)?)\s*tr\b/gi, "$1 tháng fulltime $2 triệu"],
  // Pipe "|" — không phải ký tự Việt tự nhiên trong chat sale. Đổi sang phẩy (kể cả khi không có space xung quanh).
  [/\s*\|\s*/g, ", "],
];

// Câu hỏi nhồi "nha" / "nhé" cuối — không tự nhiên với người Việt.
// Pattern: "... nha ?" / "... nha ạ ?" / "... ạ nha ?" / "... nhé ?" / "... nhé ạ ?"
// Fix: bỏ token "nha"/"nhé" thừa, giữ "ạ?" hoặc "?" .
const QUESTION_NHA_PATTERNS: Array<[RegExp, string]> = [
  [/\s+nha\s+ạ\s*\?/gi, " ạ?"],
  [/\s+ạ\s+nha\s*\?/gi, " ạ?"],
  [/\s+nhé\s+ạ\s*\?/gi, " ạ?"],
  [/\s+nha\s*\?/gi, "?"],
  [/\s+nhé\s*\?/gi, "?"],
];

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

// Stopwords + filler — không tính vào Jaccard similarity (chúng ở mọi câu reply)
const VI_STOPWORDS = new Set([
  "dạ","ạ","vâng","nha","nhé","ơi","à","ừ",
  "anh","chị","em","mình","tôi","bạn","cô","chú","bác",
  "là","có","và","với","để","cho","của","đến","đi","ở","ra","vào",
  "thì","mà","nhưng","còn","hay","hoặc","cũng","đã","đang","sẽ",
  "này","đó","đây","kia","ấy","nào","gì","sao","bao","nhiêu",
  "không","chưa","rồi","được","bị","cứ","luôn","ngay",
  "rất","quá","lắm","hơn","nhất",
  "một","hai","ba","bốn","năm","sáu","bảy","tám","chín","mười",
  "nếu","khi","lúc","giờ","ngày","buổi","tháng","năm","tuần","phút","tiếng",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !VI_STOPWORDS.has(w));
}

function jaccardSim(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function splitSentences(s: string): string[] {
  return (s.match(/[^.!?]+[.!?]?/g) || []).map((x) => x.trim()).filter(Boolean);
}

/**
 * Clean reply text. `hasMedia` = bot có thực sự gửi media qua tool — nếu false,
 * cắt cụm "em gửi hình" giả.
 *
 * `prevReply` = reply turn trước. Nếu prev đã có pitch package (≥2 số tiền) và
 * current lặp y số tiền đó → strip câu chứa số tiền (giảm lặp ý).
 */
export function cleanReply(
  text: string,
  hasMedia: boolean = false,
  prevReply: string = "",
): string {
  if (!text) return text;

  let r = text;

  // Anti-loop pitch: detect các phrase đặc trưng trong prev → strip current sentences chứa chúng.
  // Targets:
  //   - ≥2 số tiền (list package)
  //   - "PT X buổi" (PT pitch)
  //   - "InBody miễn phí" (InBody pitch)
  if (prevReply) {
    const forbidPhrases: string[] = [];

    // 1. Số tiền (chỉ khi prev có ≥2 → list package)
    const prevPrices = Array.from(
      new Set(
        (prevReply.match(/\d+(?:\.\d+)?\s*(?:tr|triệu|k)\b/gi) || []).map((s) =>
          s.toLowerCase().replace(/\s+/g, ""),
        ),
      ),
    );
    if (prevPrices.length >= 2) {
      forbidPhrases.push(...prevPrices);
    }

    // 2. PT X buổi (PT pitch — lặp giữa turns)
    const ptMatch = prevReply.match(/PT\s*\d+\s*buổi/i);
    if (ptMatch) {
      forbidPhrases.push(ptMatch[0].toLowerCase().replace(/\s+/g, ""));
    }

    if (forbidPhrases.length > 0) {
      const sentences = r.match(/[^.!?]+[.!?]?/g) || [];
      const kept = sentences.filter((sent) => {
        const norm = sent.toLowerCase().replace(/\s+/g, "");
        return !forbidPhrases.some((p) => norm.includes(p));
      });
      const stripped = kept.join(" ").trim();
      // Chỉ apply strip nếu reply sau strip còn ĐỦ context (≥ 60 chars).
      // Nếu strip quá nhiều → giữ text gốc (tránh reply cụt như "Tiện ghé đo InBody hôm nào ạ").
      if (kept.length >= 1 && stripped.length >= 60) {
        r = stripped;
      }
      // Nếu strip hết hoặc còn quá ngắn → giữ text gốc (chấp nhận lặp 1 chút còn hơn cụt)
    }

    // Jaccard dedup: bắt cả trường hợp reply lặp ngữ NGHĨA (không cần cùng số tiền)
    // — vd lặp "qua thử 1 buổi", "bên em có nhiều dịch vụ"...
    const prevSentences = splitSentences(prevReply).map(tokenize);
    const curSentences = splitSentences(r);
    if (prevSentences.length > 0 && curSentences.length >= 2) {
      const keptCur = curSentences.filter((sent) => {
        const tokens = tokenize(sent);
        if (tokens.length < 3) return true; // câu quá ngắn (thường là chào/ack) → giữ
        const maxSim = Math.max(
          ...prevSentences.map((p) => jaccardSim(tokens, p)),
        );
        return maxSim < 0.55;
      });
      const dedup = keptCur.join(" ").trim();
      if (keptCur.length >= 1 && dedup.length >= 40) {
        r = dedup;
      }
    }
  }

  // 1. Khen giả
  for (const [pattern, replacement] of FAKE_PRAISE_PATTERNS) {
    r = r.replace(pattern, replacement);
  }

  // 1b. Sycophantic ACK — bot khen đáp án của khách
  for (const [pattern, replacement] of SYCOPHANTIC_ACK_PATTERNS) {
    r = r.replace(pattern, replacement);
  }

  // 2. Fake media offer (chỉ cắt khi không có media)
  if (!hasMedia) {
    r = r.replace(FAKE_MEDIA_OFFER, "");
  }

  // 2b. Pricing shorthand leak — expand "12m=5tr" → "12 tháng 5 triệu"
  for (const [pattern, replacement] of PRICING_SHORTHAND_PATTERNS) {
    r = r.replace(pattern, replacement);
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

  // 6. Sửa "nha?" → "?" và "nha ạ?" → "ạ?" (chống văn phong gượng ép)
  for (const [pattern, replacement] of QUESTION_NHA_PATTERNS) {
    r = r.replace(pattern, replacement);
  }

  // 7. Strip TOÀN BỘ dấu "?" — văn phong sale Việt thường mềm bằng "ạ"/"nha" thay vì "?".
  //    Bảo toàn "?" nằm trong URL (vd facebook.com/profile?id=...) bằng cách chỉ strip
  //    "?" khi KHÔNG đứng trước ký tự word (URL query thường có "?id=" → "?" theo "i" word char).
  r = r.replace(/\?(?!\w)/g, "");

  // 8. Whitespace cleanup — bảo toàn \n để render list xuống dòng
  r = r
    .replace(/[ \t]+([,.!])/g, "$1")   // strip space trước dấu câu (không đụng \n)
    .replace(/[ \t]+/g, " ")           // gộp space ngang
    .replace(/[ \t]*\n[ \t]*/g, "\n")  // strip space quanh \n
    .replace(/\n{3,}/g, "\n\n")        // max 2 \n liên tiếp
    .trim();

  // 8b. Fix typographic "X. Y triệu" → "X.Y triệu" (LLM hay split decimal khi liền số thứ tự)
  r = r.replace(/(\b\d)\.\s+(\d)\s+(triệu|tr|k)\b/gi, "$1.$2 $3");

  // 9. Capitalize first letter (sau khi strip "Tuyệt vời" có thể bắt đầu bằng lowercase)
  if (r && /^[a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ]/i.test(r)) {
    r = r[0].toUpperCase() + r.slice(1);
  }

  return r;
}

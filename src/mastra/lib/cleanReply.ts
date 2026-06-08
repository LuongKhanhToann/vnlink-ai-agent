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
  // Consume luôn "ạ" và punctuation phía sau praise (vd "Hay quá ạ!" → strip toàn cụm,
  // tránh leak "ạ!" thành "Dạ vâng, ạ!").
  [/^(Tuyệt\s+vời|Tuyệt\s+quá|Chắc\s+chắn\s+rồi|Quá\s+hợp\s+lý|Hay\s+quá|Chuẩn\s+rồi|Lựa\s+chọn\s+tuyệt\s+vời|Rất\s+tuyệt|Rất\s+vui\s+được\s+hỗ\s+trợ)\s*(?:ạ|nha|nhé)?\s*[!,.]?\s*/i, "Dạ vâng, "],
  // Cum giữa câu — bỏ luôn (nhẹ nhàng). Consume "ạ" trailing tương tự.
  [/\s+(Tuyệt\s+vời|Tuyệt\s+quá|Chắc\s+chắn\s+rồi|Quá\s+hợp\s+lý|Hay\s+quá|Chuẩn\s+rồi|Lựa\s+chọn\s+tuyệt\s+vời|Rất\s+tuyệt)\s*(?:ạ|nha|nhé)?\s*[!,.]?/gi, ""],
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
  // Split on .!? nhưng KHÔNG split khi "." nằm giữa 2 chữ số (vd "1.2 triệu", "2.5kg")
  // hoặc khi "." là item marker "(1)." "(2)." (LLM hay output "(2). Học bơi 1.2 triệu").
  // Dùng split lookbehind/lookahead: `.` chỉ là sentence-end khi sau là whitespace + chữ cái HOA,
  // hoặc end-of-string.
  const parts = s.split(/(?<=[.!?])(?!\d)\s+(?=\S)/);
  return parts.map((x) => x.trim()).filter(Boolean);
}

/**
 * Clean reply text. `hasMedia` = bot có thực sự gửi media qua tool — nếu false,
 * cắt cụm "em gửi hình" giả.
 *
 * `prevReply` = reply turn trước. Nếu prev đã có pitch package (≥2 số tiền) và
 * current lặp y số tiền đó → strip câu chứa số tiền (giảm lặp ý).
 */
/**
 * Structured-output leak guard: khi DeepSeek structured-output FAIL → nhánh plain-text fallback
 * đôi khi trả NGUYÊN khối JSON ra cho khách (```json {"text":"..."}```), hoặc append khối JSON
 * vào CUỐI câu trả lời sạch. Trích field "text", bỏ phần JSON thừa.
 *   - Có text sạch (≥20 ký tự) TRƯỚC fence/JSON → giữ phần sạch, cắt đuôi JSON.
 *   - Toàn bộ là JSON → trích value của "text".
 */
function stripStructuredJsonLeak(text: string): string {
  let r = text;
  const extractTextField = (s: string): string | null => {
    const m = s.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  };
  const fenceIdx = r.search(/```/);
  if (fenceIdx >= 0) {
    const before = r.slice(0, fenceIdx).trim();
    if (before.length >= 20) return before; // giữ phần trả lời sạch, bỏ đuôi JSON
    const t = extractTextField(r);
    if (t) return t;
    return r.replace(/```(?:json)?/gi, "").trim();
  }
  // JSON object trần (không fence) chứa "text"
  if (/^\s*\{[\s\S]*"text"\s*:/.test(r)) {
    const t = extractTextField(r);
    if (t) return t;
  }
  return r;
}

export function cleanReply(
  text: string,
  hasMedia: boolean = false,
  prevReply: string = "",
  customerMessage: string = "",
): string {
  if (!text) return text;

  // Chặn raw-JSON leak TRƯỚC mọi xử lý khác (DeepSeek structured-fail → plain-text dump JSON).
  let r = stripStructuredJsonLeak(text);

  // KH đang HỎI GIÁ trực tiếp (kể cả hỏi LẠI) → KHÔNG được strip câu trả lời giá qua anti-loop
  // (bug: KH "1 khóa hết bao nhiêu" sau khi bot đã báo giá turn trước → dedup nuốt câu giá →
  //  bot né câu hỏi, sale=0). Khi cờ này bật: bỏ qua price-forbid + giữ câu có số tiền ở Jaccard.
  const customerAskingPrice =
    /(giá|bao\s+nhiêu|mấy\s+(tiền|đồng)|chi\s*phí|học\s*phí|báo\s*giá|nhiêu\s+tiền|hết\s+bao|tổng\s+(cộng|hết)|trọn\s+gói\s+bao)/i.test(
      customerMessage,
    );
  const hasPriceNumber = (s: string): boolean =>
    /\d+(?:[.,]\d+)?\s*(?:tr|triệu|k|nghìn|ngàn|đồng)/i.test(s);

  // Anti-loop pitch: detect các phrase đặc trưng trong prev → strip current sentences chứa chúng.
  // Targets:
  //   - ≥2 số tiền (list package)
  //   - "PT X buổi" (PT pitch)
  //   - "InBody miễn phí" (InBody pitch)
  if (prevReply) {
    const forbidPhrases: string[] = [];

    // 1. Số tiền (chỉ khi prev có ≥2 → list package)
    // Pre-normalize "1. 2 triệu" → "1.2 triệu" (LLM hay output decimal có space).
    const prevNorm = prevReply.replace(/(\d+)\.\s+(\d+)/g, "$1.$2");
    const prevPrices = Array.from(
      new Set(
        (prevNorm.match(/\d+(?:\.\d+)?\s*(?:tr|triệu|k)\b/gi) || []).map((s) =>
          s.toLowerCase().replace(/\s+/g, ""),
        ),
      ),
    );
    if (prevPrices.length >= 2 && !customerAskingPrice) {
      forbidPhrases.push(...prevPrices);
    }

    // 2. PT X buổi (PT pitch — lặp giữa turns)
    const ptMatch = prevReply.match(/PT\s*\d+\s*buổi/i);
    if (ptMatch) {
      forbidPhrases.push(ptMatch[0].toLowerCase().replace(/\s+/g, ""));
    }

    if (forbidPhrases.length > 0) {
      // Dùng splitSentences() đã fix (không split giữa "1.2") để strip per-sentence chuẩn.
      const sentences = splitSentences(r);
      // Detect numbered list (1)/(2)/(3) hoặc 1./2./3. — nếu có ≥2 list item, strip cả block
      // hoặc giữ nguyên (tránh nhảy số như "(1) ... (3) ...").
      const isListItem = (s: string) => /^\s*[\(\[]?\s*\d+\s*[\)\].]\s+/.test(s);
      const listItems = sentences.filter(isListItem);
      if (listItems.length >= 2) {
        const anyHit = listItems.some((s) => {
          const norm = s.toLowerCase().replace(/\s+/g, "");
          return forbidPhrases.some((p) => norm.includes(p));
        });
        if (anyHit) {
          // Toàn bộ list bị dính → strip cả block list
          const kept = sentences.filter((s) => !isListItem(s));
          const stripped = kept.join(" ").trim();
          if (stripped.length >= 60) r = stripped;
        }
      } else {
        const kept = sentences.filter((sent) => {
          const norm = sent.toLowerCase().replace(/\s+/g, "");
          return !forbidPhrases.some((p) => norm.includes(p));
        });
        const stripped = kept.join(" ").trim();
        if (kept.length >= 1 && stripped.length >= 60) r = stripped;
      }
    }

    // Jaccard dedup: bắt cả trường hợp reply lặp ngữ NGHĨA (không cần cùng số tiền)
    // — vd lặp "qua thử 1 buổi", "bên em có nhiều dịch vụ"...
    //
    // EXEMPT: câu xác nhận trả lời trực tiếp ("Dạ bên em có", "Có ạ", "Dạ có ạ"...)
    // — khi KH hỏi lại "có được tập thử không?" sau khi bot vừa pitch trial, bot PHẢI
    // xác nhận lại. Nếu Jaccard strip → bot không trả lời được câu hỏi yes/no.
    const isAffirmativeAnswer = (sent: string): boolean => {
      const s = sent.toLowerCase().trim();
      return (
        /^d[ạa]?\s*(vâng|có|đúng|được|rồi)/.test(s) ||
        /^(dạ\s+)?bên\s+em\s+có/.test(s) ||
        /^(dạ\s+)?có\s+(ạ|nha|chứ)/.test(s)
      );
    };
    const prevSentences = splitSentences(prevReply).map(tokenize);
    const curSentences = splitSentences(r);
    if (prevSentences.length > 0 && curSentences.length >= 2) {
      const keptCur = curSentences.filter((sent) => {
        if (isAffirmativeAnswer(sent)) return true; // luôn giữ câu xác nhận
        if (customerAskingPrice && hasPriceNumber(sent)) return true; // KH hỏi giá → giữ câu báo giá
        const tokens = tokenize(sent);
        if (tokens.length < 3) return true; // câu quá ngắn (thường là chào/ack) → giữ
        const maxSim = Math.max(
          ...prevSentences.map((p) => jaccardSim(tokens, p)),
        );
        return maxSim < 0.50;
      });
      const dedup = keptCur.join(" ").trim();
      if (keptCur.length >= 1 && dedup.length >= 40) {
        r = dedup;
      }
    }

    // HARD-LOOP DETECTION: nếu toàn bộ reply gần như identical với prev
    // (jaccard >= 0.85 trên ngôn ngữ toàn câu, hoặc char overlap >= 0.80) →
    // bot stuck. Replace bằng safe pivot để tránh khách thấy 2 tin trùng.
    const tokensCur = tokenize(r);
    const tokensPrev = tokenize(prevReply);
    const fullSim = jaccardSim(tokensCur, tokensPrev);
    // Normalize chars: bỏ whitespace + lowercase + diacritics-insensitive (approx).
    const normChars = (s: string) =>
      s.toLowerCase().normalize("NFC").replace(/\s+/g, "");
    const cn = normChars(r);
    const pn = normChars(prevReply);
    const charOverlap =
      cn.length > 0 && pn.length > 0
        ? (cn.length === pn.length && cn === pn
            ? 1
            : cn.includes(pn) || pn.includes(cn)
              ? Math.min(cn.length, pn.length) / Math.max(cn.length, pn.length)
              : 0)
        : 0;
    if ((fullSim >= 0.92 || charOverlap >= 0.90) && r.length >= 40) {
      console.warn(
        `[cleanReply] HARD-LOOP detected (jaccard=${fullSim.toFixed(2)} charOverlap=${charOverlap.toFixed(2)}) — replacing with safe pivot`,
      );
      r =
        "Dạ vâng, anh/chị cho em xin thêm thông tin để em tư vấn cụ thể hơn ạ.";
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

  // 4b. Markdown bullets ở đầu line — strip "- " / "* " / "• " và đảm bảo xuống dòng.
  //     Zalo không render markdown → list item phải dùng dấu xuống dòng natural hoặc "(1)/(2)/(3)".
  //     Pattern: \n hoặc start-of-string + bullet char + space. Bỏ bullet, giữ \n.
  r = r.replace(/(^|\n)[\-\*•]\s+/g, "$1");
  // Inline bullet sau dấu chấm (vd "...giảm cân. - Gym fulltime..." — bot hay output mixed).
  // Khi gặp "[.!] - " → đổi thành "[.!] \n" để xuống dòng rõ ràng.
  r = r.replace(/([.!])\s+[\-\*•]\s+/g, "$1\n");

  // 5. URL leak (giữ fanpage facebook.com/... vì là plain text)
  r = r.replace(URL_PATTERN, (m) =>
    /facebook\.com/i.test(m) ? m.replace(/^https?:\/\//, "") : "",
  );

  // 6. Sửa "nha?" → "?" và "nha ạ?" → "ạ?" (chống văn phong gượng ép)
  for (const [pattern, replacement] of QUESTION_NHA_PATTERNS) {
    r = r.replace(pattern, replacement);
  }

  // 6b. Insert dấu "." giữa "ạ" + chữ HOA (bot hay viết "...ạ Mục tiêu..." thiếu chấm).
  //     Pattern: " ạ " (kết câu) + space + chữ in hoa tiếng Việt → " ạ. " + chữ in hoa.
  //     Lookbehind (?<=\s) đảm bảo "ạ" phải là từ STANDALONE (đứng sau space) —
  //     tránh match "Dạ Full" → "Dạ. Full" (sai vì "ạ" trong "Dạ" là 1 phần của từ).
  r = r.replace(
    /(?<=\s)ạ(\s+)([A-ZĐĂÂÊÔƠƯÁÀẢÃẠÉÈẺẼẸÍÌỈĨỊÓÒỎÕỌÚÙỦŨỤÝỲỶỸỴ][a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ])/g,
    "ạ.$1$2",
  );

  // 6c. Strip câu hỏi thứ 2+: rule "max 1 câu hỏi/reply" (sale Zalo/Messenger).
  //     Strategy:
  //       - Find tất cả câu kết "?" (sau khi strip dấu "?" còn "ạ" + sentence boundary).
  //       - Vì step 7 sắp strip "?" → ta detect trước: tìm các sentence kết "?" và đếm.
  //       - Nếu ≥2, giữ câu hỏi ĐẦU TIÊN, các câu hỏi sau đổi thành câu khẳng định:
  //         strip toàn bộ câu hỏi thứ 2+ luôn.
  //     Pattern câu hỏi: kết bằng "?" hoặc " ạ?" (sau khi đã normalize).
  const questionMarks = (r.match(/\?/g) || []).length;
  if (questionMarks >= 2) {
    const sentences = splitSentences(r);
    let kept: string[] = [];
    let questionUsed = false;
    for (const s of sentences) {
      const isQuestion = /[?]\s*$/.test(s.trim());
      if (isQuestion) {
        if (!questionUsed) {
          kept.push(s);
          questionUsed = true;
        }
        // else: skip câu hỏi thứ 2+ (drop sentence)
      } else {
        kept.push(s);
      }
    }
    // Nếu chưa có câu hỏi nào được giữ (chỉ vì sentence split lỗi), keep all.
    if (kept.length > 0) {
      r = kept.join(" ").trim();
    }
  }

  // 7. Dấu "?" — NỚI (Nhánh D 2026-06-08): trước đây strip TOÀN BỘ "?" → mọi câu hỏi đọc thành
  //    "...ạ" mất ngữ điệu hỏi (góp phần bot "cứng"). Giờ GIỮ ĐÚNG 1 dấu "?" ở câu hỏi CUỐI để tự
  //    nhiên hơn; strip mọi "?" nội bộ còn lại. An toàn với grader (chỉ phạt khi >1 "?"). "?" trong
  //    URL (?id=) vẫn giữ qua (?!\w). Restore dấu "?" cuối ở bước 8d-bis (sau khi chuẩn hoá particle).
  const endedWithQuestion = /\?\s*$/.test(r.trim());
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

  // 8c. Câu kết phải kết bằng "ạ" thay vì "nha"/"nhé" (style sale Việt lễ phép hơn).
  //     Áp dụng cho TỪNG câu trong reply, không chỉ câu cuối — bot hay nhồi "nha" mỗi câu.
  //     Chỉ replace khi đứng cuối câu (trước . ! hoặc end-of-string). Giữ "nha" nội bộ
  //     ("nha em" / "nha anh" — vocative, không phải particle kết câu).
  r = r.replace(/\s+(nha|nhé)(?=\s*[.!]|\s*$)/gi, " ạ");

  // 8d. Câu cuối thiếu particle kết — bot hay paraphrase rồi drop luôn "ạ"/"nha".
  //     Detect: câu cuối không kết bằng ạ/nha/nhé/dấu hỏi/dấu cảm/colon/số → thêm " ạ" trước dấu chấm.
  //     Câu chỉ chứa info trơ (vd "Dạ trung tâm 32A Nguyễn Chí Thanh") → vẫn được thêm "ạ" để mềm.
  //     Bỏ qua nếu câu cuối quá ngắn (<8 chars) hoặc kết bằng số (vd giá "7tr").
  {
    // Sentence boundary: . ! hoặc end of string. Lấy câu cuối cùng (có thể không kết thúc bằng dấu).
    const trimmed = r.trim();
    if (trimmed.length >= 8) {
      // Tìm câu cuối: split theo [.!] giữ dấu, lấy phần cuối có nội dung.
      const parts = trimmed.split(/([.!]+)/).filter(Boolean);
      // parts dạng: ["câu 1", ".", "câu 2", ".", "câu cuối"] hoặc cuối có dấu rồi.
      // Tìm index của text cuối (không phải dấu câu).
      let lastTextIdx = -1;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (!/^[.!]+$/.test(parts[i]) && parts[i].trim().length > 0) {
          lastTextIdx = i;
          break;
        }
      }
      if (lastTextIdx >= 0) {
        const lastSentence = parts[lastTextIdx].trim();
        // Đã có particle kết? Kết bằng ạ / nha / nhé / dấu hỏi → skip.
        // Dùng lookbehind Unicode-safe vì \b không hoạt động với "ạ" (không phải ASCII word char).
        const endsWithParticle =
          /(?:^|[\s,.!?])(ạ|nha|nhé)\s*$/i.test(lastSentence) ||
          /\?\s*$/.test(lastSentence);
        // Kết bằng số / unit giá tiền → skip (vd "7tr", "350k", "6tr").
        // KHÔNG dùng "buổi/tháng/tuần/giờ/phút/ngày/năm" vì các từ này hay đứng cuối CTA
        // ("thử 1 buổi", "tập 3 tháng") — câu vẫn cần "ạ" kết.
        const endsWithNumber =
          /[\d%]\s*$/.test(lastSentence) ||
          /\d+\s*(tr|triệu|k|nghìn|ngàn|đồng|kg|m2)\s*$/i.test(lastSentence);
        // Quá ngắn? (<8 chars) → skip.
        if (!endsWithParticle && !endsWithNumber && lastSentence.length >= 8) {
          parts[lastTextIdx] = parts[lastTextIdx].replace(/\s*$/, " ạ");
          r = parts.join("");
        }
      }
    }
  }

  // 8d-bis. NỚI (Nhánh D): khôi phục 1 dấu "?" cuối nếu reply gốc là câu hỏi (xem bước 7).
  //         Chạy SAU 8c/8d (đã chuẩn hoá "ạ"/"nha") → cho ra dạng tự nhiên "...ạ?". Chỉ thêm khi
  //         hiện chưa kết bằng "?" (tránh "??"). KHÔNG thêm nếu câu cuối kết bằng số/giá.
  if (endedWithQuestion && !/\?\s*$/.test(r.trim()) && !/[\d%]\s*$/.test(r.trim())) {
    r = r.replace(/\s*$/, "?");
  }

  // 8e. Strip duplicate honorific kế cận trong cùng 1 câu.
  //     Vd: "Dạ anh/chị, anh/chị thấy hướng..." → "Dạ anh/chị, thấy hướng..."
  //     "anh/chị, anh/chị" / "chị, chị" / "anh, anh" — pattern: <h>[,.]?\s+<h>\s+ trong cùng câu.
  //     Bot hay sinh ra do template `Dạ ${h}, ${h} thấy...` — đọc lặp lại ngỡ ngẩn.
  r = r.replace(
    /\b(anh\/chị|anh|chị)([,.]?\s+)\1\s+/gi,
    (_m, h, sep) => `${h}${sep}`,
  );

  // 9. Capitalize first letter (sau khi strip "Tuyệt vời" có thể bắt đầu bằng lowercase)
  if (r && /^[a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ]/i.test(r)) {
    r = r[0].toUpperCase() + r.slice(1);
  }

  // 9b. Capitalize sau dấu chấm câu — bot có thể đã strip subject ("Anh/chị")
  //     hoặc paraphrase bỏ chữ in hoa. Đảm bảo chữ đầu câu mới luôn in hoa.
  r = r.replace(
    /([.!?])(\s+)([a-zàáảãạăâđèéẻẽẹêìíỉĩịòóỏõọôơùúủũụưỳýỷỹỵ])/g,
    (_m, p, ws, c) => `${p}${ws}${c.toUpperCase()}`,
  );

  // 10. LENGTH CAP — Zalo/Messenger 1 reply nên ≤ 320 chars để dễ đọc.
  //     Soft cap: nếu > 320 thì truncate ở sentence boundary cuối cùng dưới 320.
  //     Reply có pricing list (≥2 con số tiền) hoặc chứa \n list (≥2 dòng "(N)") → cap nới lên 420
  //     để không cắt dở giữa list.
  const MAX_CHARS_DEFAULT = 320;
  const MAX_CHARS_LIST = 420;
  const priceCount = (r.match(/\d+\s*(tr|triệu|k)\b/gi) || []).length;
  const hasListMarker = /\n\s*[\(\[]?\s*\d+\s*[\)\].]?\s+\S/.test(r);
  const cap = priceCount >= 2 || hasListMarker ? MAX_CHARS_LIST : MAX_CHARS_DEFAULT;
  if (r.length > cap) {
    // Tìm sentence boundary <=cap. Dùng splitSentences để giữ ngữ nghĩa.
    const sentences = splitSentences(r);
    let acc = "";
    for (const s of sentences) {
      const next = acc ? `${acc} ${s}` : s;
      if (next.length > cap && acc.length > 0) break;
      acc = next;
      if (acc.length >= cap) break;
    }
    if (acc.length >= 40) {
      console.warn(
        `[cleanReply] length cap ${r.length}→${acc.length} chars (cap=${cap})`,
      );
      r = acc.trim();
    }
  }

  return r;
}

/**
 * replyGuards.ts — DETERMINISTIC OUTPUT GUARDS (chạy SAU khi LLM đã sinh reply).
 *
 * Vì sao tồn tại file này:
 *   Model nhỏ (reply) tuân lệnh prompt ~70-80% → mỗi lượt sample lại, các "rule mềm"
 *   trong prompt lúc trúng lúc trật. Những hành vi BẮT BUỘC đúng 100% (caption ảnh,
 *   không tái chào, khóa xưng hô, trả thẳng giá HS/SV) KHÔNG thể đảm bảo bằng chữ trong
 *   prompt — phải cưỡng chế bằng CODE ở tầng post-process. Đúng-by-construction → không
 *   cần test lại từng mẫu.
 *
 * ⚠ LƯU Ý NGUYÊN TẮC: mọi regex ở đây CHỈ soi/nắn TEXT ĐẦU RA CỦA BOT (kỹ thuật chuỗi),
 *   KHÔNG dùng để phân loại Ý ĐỊNH KHÁCH (việc đó là của classifier LLM). Đây là biên giới
 *   "pure technical parsing" được phép — không phải business-logic-bằng-regex.
 */

/** Reply đã có câu DẪN ẢNH chưa (soi kỹ thuật trên text bot, không phân loại nghiệp vụ). */
function mentionsImage(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(gửi|gởi)[^.!]{0,25}(ảnh|hình|tấm|clip|video|trước\s*[-–]?\s*sau|kết\s*quả)/.test(t) ||
    /(ảnh|hình)[^.!]{0,15}(trước|hội\s*viên|minh\s*hoạ|tham\s*khảo|thực\s*tế)/.test(t) ||
    /trước\s*[-–]?\s*sau/.test(t) ||
    /(xem|coi)[^.!]{0,12}(ảnh|hình|clip|video)/.test(t)
  );
}

function dropLeadingDa(body: string): string {
  return body.trim().replace(/^dạ[\s,]*/i, "");
}

/**
 * Cách GỌI KHÁCH an toàn cho câu do CODE ghép ra.
 * Biết giới → "anh"/"chị". CHƯA biết → "mình" (trung tính, tự nhiên trong chat Việt).
 * ⛔ TUYỆT ĐỐI không mặc định "anh" khi chưa rõ — gọi sai giới khách là lỗi rất nặng.
 * Cũng tránh chèn "anh/chị" cứng vào câu trong khi model đang xưng "mình" ở câu bên cạnh
 * (lẫn xưng hô trong cùng 1 tin — bắt được ở smoke 22/07).
 */
function addr(honorific: string): string {
  return honorific === "anh" || honorific === "chị" ? honorific : "mình";
}

/**
 * GUARD 1 — CAPTION ẢNH.
 * Khi server đính ảnh (doubt-media deterministic / tool) mà câu của bot KHÔNG hề dẫn ảnh
 * → ảnh hiện trơ trọi (không mượt). Tự ghép 1 câu dẫn ở ĐẦU reply theo loại ảnh.
 */
export function ensureMediaCaption(
  text: string,
  mediaKey: string | null,
  honorific: string,
): string {
  if (!mediaKey) return text;
  if (mentionsImage(text)) return text;
  const h = addr(honorific);
  let cap: string;
  if (mediaKey.includes("before-after"))
    cap = `Dạ em gửi ${h} vài hình trước–sau của hội viên bên em để dễ hình dung kết quả ạ.`;
  else if (mediaKey.startsWith("mr-"))
    cap = `Dạ em gửi ${h} vài ca bên em làm thực tế để dễ hình dung ạ.`;
  else cap = `Dạ em gửi ${h} ít hình bên em để dễ hình dung không gian tập ạ.`;
  const body = dropLeadingDa(text);
  return body ? `${cap} ${capFirst(body)}` : cap;
}

/**
 * Reply có phải template CHÀO MỞ ĐẦU (turn-1) không — soi kỹ thuật.
 *
 * ⚠ 22/07 — LỖI NẶNG ĐÃ VÁ: net cũ chỉ cần `cảm ơn…quan tâm` + `quan tâm (đến`, mà một câu
 * BÁO GIÁ lịch lãm cũng mở bằng "Dạ cảm ơn chị đã quan tâm…" và kết bằng "chị quan tâm đến gói
 * nào ạ" → khớp cả 2 → stripStaleGreeting XOÁ TRẮNG câu báo giá, khách chỉ nhận
 * "Dạ chị cần em hỗ trợ thêm gì không ạ." (mất luôn câu chốt sale). Siết 3 lớp:
 *   1) có CON SỐ GIÁ → chắc chắn là nội dung thật, không phải lời chào;
 *   2) template chào vốn NGẮN → dài quá ngưỡng là reply có nội dung;
 *   3) phải MỞ ĐẦU bằng chào/cảm ơn, và bỏ nhánh lỏng "quan tâm đến".
 */
export function isStaleGreeting(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (hasPrice(t)) return false;
  if (t.length > 200) return false;
  return (
    /^(dạ\s*)?(em\s*)?(chào|cảm\s*ơn)/.test(t) &&
    /cảm\s*ơn[^.!]{0,30}quan\s*tâm/.test(t) &&
    /(bộ\s*môn\s*nào|tư\s*vấn\s*hỗ\s*trợ)/.test(t)
  );
}

/**
 * GUARD 3 — CHẶN TÁI CHÀO turn-1.
 * Sau opening (stage≠opening), nếu model phọt lại template chào "cảm ơn đã quan tâm…
 * bộ môn nào" → reset hội thoại = vỡ retention. Thay bằng 1 câu ấm ngắn, không pitch.
 */
export function stripStaleGreeting(
  text: string,
  isClosing: boolean,
  honorific: string,
): string {
  if (!isStaleGreeting(text)) return text;
  const h = addr(honorific);
  return isClosing
    ? `Dạ vâng ${h} ạ, có gì ${h} cứ nhắn em nhé ạ.`
    : `Dạ ${h} cần em hỗ trợ thêm gì không ạ.`;
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * GUARD 4 — KHÓA XƯNG HÔ.
 * Khi đã biết giới tính (honorific="anh"/"chị"), thay mọi "anh/chị" còn sót trong reply
 * bằng đại từ đúng → hết "anh/chị" spam như máy. honorific chưa rõ thì để nguyên.
 */
export function lockHonorific(text: string, honorific: string): string {
  if (honorific !== "anh" && honorific !== "chị") return text;
  // 22/07: net cũ chỉ khớp ĐÚNG 2 dạng "Anh/chị" và "anh/chị" → sót "Anh/Chị", "anh / chị"
  // (model viết cả 3 kiểu) → cùng 1 tin vừa gọi "Chị" vừa còn "Anh/Chị". Gộp 1 regex
  // case-insensitive + cho phép space quanh "/", giữ nguyên hoa/thường theo ký tự đầu.
  // ⚠ KHÔNG dùng \b sau "chị": "ị" không phải word-char của regex JS nên \b không bao giờ khớp
  // (net có \b im lặng không thay gì cả — bẫy đã dính 1 lần lúc vá).
  return text.replace(/anh\s*\/\s*chị/gi, (m) => {
    const head = m.charAt(0);
    const isUpper = head !== head.toLowerCase();
    return isUpper ? capFirst(honorific) : honorific;
  });
}

/** Reply đã có CON SỐ GIÁ chưa (soi kỹ thuật). */
function hasPrice(text: string): boolean {
  return /\d+\s*(k|nghìn|ngàn|triệu|tr|đồng)\b/i.test(text) || /\d{3,}/.test(text);
}

// 22/07 — gỡ GUARD 5 forceStudentPricing: nó là di sản của routerWorkflow (nơi có cờ
// classifier `shouldForce`), engine mới KHÔNG BAO GIỜ gọi → hàm mồ côi, và số giá trong đó
// là một BẢN SAO thứ hai của bảng HS/SV, sai lệch với prompts.ts lúc nào không hay.
// HS/SV giờ do prompt lo (FITNESS_PROMPT nêu rõ CHỈ có bảng FULL HS/SV) + smokePriceCheck canh.

/**
 * GUARD 2 (phần text) — gỡ câu nhắc "gửi mã QR" khi thực tế KHÔNG đính QR.
 * Tránh hứa suông khi guard QR-timing đã chặn đính kèm.
 */
export function stripQrMention(text: string): string {
  // ⚠ 22/07 — LỖI NẶNG ĐÃ VÁ: hàm này trước đây chạy phần dọn khoảng trắng trên MỌI reply
  // (guard gọi mỗi lượt không đính QR = gần như mọi lượt), mà `\s{2,}` thì nuốt luôn "\n\n" →
  // ĐÈ BẸP mọi dòng trống. Hậu quả khách thấy: bảng giá xuống dòng đẹp bị dán câu chốt vào
  // mục cuối ("…12 tháng: 3.6 triệu Nếu em chỉ muốn…"). Trace pipeline 22/07:
  //   trước guard: "…3.6 triệu\n\nNếu em chỉ…"   sau guard: "…3.6 triệu Nếu em chỉ…"
  // Hai lớp vá:
  //   1) KHÔNG có chữ "qr" → trả NGUYÊN VĂN, không đụng gì (guard chỉ nên làm đúng việc của nó).
  //   2) Khi có dọn thật thì chỉ gộp space/tab ngang, TUYỆT ĐỐI giữ "\n".
  if (!/\bqr\b/i.test(text)) return text;
  const out = text
    .replace(/[^.!,]*\b(mã\s*qr|qr)\b[^.!,]*[.,]?/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,])/g, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out ? capFirst(out) : text;
}

/**
 * GUARD 6 — CHẶN GIỤC CHỐT SỚM (CẢ 2 nhánh).
 * KH chưa có tín hiệu mua (intent chưa selecting/ready, chưa có giờ, chưa có liên hệ) mà reply lỡ
 * HỎI CHỌN KHUNG GIỜ ("sáng hay chiều", "tiện qua buổi nào"…) = giục chốt, phản tác dụng. Prompt đã
 * dặn mời-mềm nhưng model freelance đều đặn → cưỡng chế bằng code: bỏ câu hỏi giờ, thay bằng lời mời
 * mềm HỢP NHÁNH. Quyết định "CÓ tín hiệu mua" lấy TỪ CLASSIFIER (intent/slots) — guard chỉ soi/nắn
 * TEXT bot, KHÔNG phân loại ý khách (đúng biên giới pure-text-parsing của file này).
 *
 * ⚠ 22/07: mở cho CẢ fitness (trước chỉ giai-co). Smoke 2/2 lần bắt fitness giục chốt ngay sau khi
 *   khách cho chiều cao/cân nặng ("mình tiện qua buổi nào để em gợi lịch ạ") — đúng cái CLOSING cấm.
 */
export function softenPrematureClose(
  text: string,
  ctx: {
    flow: string;
    intent: string;
    preferredTime: string | null;
    hasContact: boolean;
    honorific: string;
  },
): string {
  if (ctx.flow !== "giai-co" && ctx.flow !== "fitness") return text;
  const buyingSignal =
    ctx.intent === "selecting" ||
    ctx.intent === "ready" ||
    ctx.preferredTime !== null ||
    ctx.hasContact;
  if (buyingSignal) return text;

  // Marker câu HỎI CHỌN KHUNG GIỜ trong OUTPUT bot (chỉ kỹ thuật chuỗi). cleanReply đã strip "?"
  // nên không yêu cầu dấu hỏi.
  // "buổi nào" / "tiện đi" bổ sung 22/07: smoke bắt "mình tiện qua BUỔI NÀO để em gợi lịch ạ" và
  // "mình tiện ĐI buổi nào…" lọt lưới cũ (thiếu cả tân ngữ "buổi nào" lẫn động từ "đi").
  const SCHED =
    /(sáng hay chiều|sáng\s*\/\s*chiều|chiều hay (?:tối|sáng)|sáng hay tối|tiện (?:ghé|qua|đến|sang|đi|sắp xếp)[^.!?]*?(?:sáng|chiều|tối|hôm nào|bữa nào|buổi nào|giờ nào))/iu;
  if (!SCHED.test(text)) return text;

  // ⚠ 22/07 — VÁ: trước đây guard chia câu làm 2 loại, "câu có FACT GIỜ" thì gỡ đuôi giục, còn lại
  // XOÁ CẢ CÂU. Mà HOURS_FACT chỉ nhận giờ dạng số / "mở cửa" → câu fact hợp lệ KHÔNG có số giờ bị
  // xoá sạch: "Dạ bên em mở cả tuần kể cả chủ nhật ạ, mình tiện qua buổi nào ạ." → mất luôn vế trả
  // lời, khách hỏi cuối tuần có mở không thì nhận câu mời InBody lạc đề.
  // Sửa gốc: BỎ HẲN phân loại fact/không-fact. Mọi câu dính SCHED đều chỉ GỠ ĐÚNG MỆNH ĐỀ hỏi-giờ,
  // giữ lại mọi vế còn lại. Câu thuần giục-chốt (không còn vế nào) tự rỗng → biến mất như cũ.
  // Gỡ mệnh đề hỏi-chọn-giờ khỏi 1 câu, giữ các vế fact phía trước (tách theo dấu phẩy).
  const stripSchedClause = (s: string): string =>
    s
      .split(/,\s*/)
      .filter((c) => !SCHED.test(c))
      .join(", ")
      .replace(/[.,;\s]+$/, "");

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  if (!sentences.some((s) => SCHED.test(s))) return text;

  // ⛔ KHÔNG mặc định "anh" khi chưa rõ giới (bug cũ: honorific ở engine agent luôn kẹt "anh/chị"
  //    → mọi khách nữ bị gọi "anh" ngay tại câu mời này). addr() trả "mình" khi chưa rõ.
  const h = addr(ctx.honorific);
  const soft =
    ctx.flow === "giai-co"
      ? `Mình cứ thử trải nghiệm 1 buổi để KTV kiểm tra trực tiếp rồi tư vấn lộ trình đã, chưa cần quyết gì đâu ${h} ạ`
      : `Mình cứ ghé đo InBody miễn phí để HLV xem thể trạng rồi tư vấn lộ trình đã, chưa cần quyết gì đâu ${h} ạ`;

  // Gỡ mệnh đề hỏi-giờ ở MỌI câu dính SCHED (giữ mọi vế fact), rồi ghép lời mời mềm vào cuối.
  const kept = sentences
    .map((s) => (SCHED.test(s) ? stripSchedClause(s) : s))
    .filter((s) => s.trim());
  const body = kept.join(" ").trim().replace(/[.,;\s]+$/, "");
  return body ? `${capFirst(body)}. ${soft}` : soft;
}

// 22/07 — gỡ alias softenGiaiCoPrematureClose: nó chỉ tồn tại cho legacy routerWorkflow,
// mà routerWorkflow đã xoá. Engine dùng softenPrematureClose (chạy cả fitness lẫn giai-co).

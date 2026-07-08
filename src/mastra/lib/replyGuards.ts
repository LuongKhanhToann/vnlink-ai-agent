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
    /(gửi|gởi)[^.!]{0,25}(ảnh|hình|tấm|clip|video|trước\s*[-–]?\s*sau)/.test(t) ||
    /(ảnh|hình)[^.!]{0,15}(trước|hội\s*viên|minh\s*hoạ|tham\s*khảo|thực\s*tế)/.test(t) ||
    /trước\s*[-–]?\s*sau/.test(t) ||
    /(xem|coi)[^.!]{0,12}(ảnh|hình|clip|video)/.test(t)
  );
}

function dropLeadingDa(body: string): string {
  return body.trim().replace(/^dạ[\s,]*/i, "");
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
  let cap: string;
  if (mediaKey.includes("before-after"))
    cap = `Dạ em gửi ${honorific} vài hình trước–sau của hội viên bên em để dễ hình dung kết quả ạ.`;
  else if (mediaKey.startsWith("mr-"))
    cap = `Dạ em gửi ${honorific} vài ca bên em làm thực tế để dễ hình dung ạ.`;
  else cap = `Dạ em gửi ${honorific} ít hình bên em để dễ hình dung không gian tập ạ.`;
  const body = dropLeadingDa(text);
  return body ? `${cap} ${capFirst(body)}` : cap;
}

/** Reply có phải template CHÀO MỞ ĐẦU (turn-1) không — soi kỹ thuật. */
export function isStaleGreeting(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /cảm\s*ơn[^.!]{0,30}quan\s*tâm/.test(t) &&
    /(bộ\s*môn\s*nào|tư\s*vấn\s*hỗ\s*trợ|quan\s*tâm\s*(đến|bộ\s*môn))/.test(t)
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
  return isClosing
    ? `Dạ vâng ${honorific} ạ, có gì ${honorific} cứ nhắn em nhé ạ.`
    : `Dạ ${honorific} cần em hỗ trợ thêm gì không ạ.`;
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
  return text
    .replace(/Anh\/chị/g, capFirst(honorific))
    .replace(/anh\/chị/g, honorific);
}

/** Reply đã có CON SỐ GIÁ chưa (soi kỹ thuật). */
function hasPrice(text: string): boolean {
  return /\d+\s*(k|nghìn|ngàn|triệu|tr|đồng)\b/i.test(text) || /\d{3,}/.test(text);
}

/**
 * GUARD 5 — TRẢ THẲNG GIÁ HS/SV.
 * Khi classifier xác định khách hỏi giá học sinh/sinh viên mà reply KHÔNG có con số nào
 * (model né sang "ghé sáng/chiều"…) → ghép thẳng bảng HS/SV. Số khớp PRICING/fitness.ts.
 * (shouldForce do execute tính TỪ TÍN HIỆU CLASSIFIER, không phải regex ý khách.)
 */
export function forceStudentPricing(
  text: string,
  shouldForce: boolean,
  honorific: string,
): string {
  if (!shouldForce || hasPrice(text)) return text;
  const line =
    `Dạ bên em có bảng giá riêng cho học sinh/sinh viên ạ: gói Full 12 tháng 4 triệu là đáng nhất, ` +
    `nếu ${honorific} muốn nhẹ hơn thì 1 tháng 700 nghìn ạ.`;
  const body = dropLeadingDa(text);
  return body ? `${line} ${capFirst(body)}` : line;
}

/**
 * GUARD 2 (phần text) — gỡ câu nhắc "gửi mã QR" khi thực tế KHÔNG đính QR.
 * Tránh hứa suông khi guard QR-timing đã chặn đính kèm.
 */
export function stripQrMention(text: string): string {
  const out = text
    .replace(/[^.!,]*\b(mã\s*qr|qr)\b[^.!,]*[.,]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
  return out ? capFirst(out) : text;
}

/**
 * GUARD 6 — CHẶN GIỤC CHỐT SỚM (giai-co).
 * KH chưa có tín hiệu mua (intent chưa selecting/ready, chưa có giờ, chưa có liên hệ) mà reply lỡ
 * HỎI CHỌN KHUNG GIỜ ("sáng hay chiều"…) = giục chốt, phản tác dụng. Prefix đã dặn mời-mềm nhưng
 * model nhỏ freelance ~1/3 lượt → cưỡng chế bằng code: bỏ câu hỏi giờ, thay bằng lời mời TRẢI NGHIỆM
 * mềm. Quyết định "CÓ tín hiệu mua" lấy TỪ CLASSIFIER (intent/slots) — guard chỉ soi/nắn TEXT bot,
 * KHÔNG phân loại ý khách (đúng biên giới pure-text-parsing của file này).
 */
export function softenGiaiCoPrematureClose(
  text: string,
  ctx: {
    flow: string;
    intent: string;
    preferredTime: string | null;
    hasContact: boolean;
    honorific: string;
  },
): string {
  if (ctx.flow !== "giai-co") return text;
  const buyingSignal =
    ctx.intent === "selecting" ||
    ctx.intent === "ready" ||
    ctx.preferredTime !== null ||
    ctx.hasContact;
  if (buyingSignal) return text;

  // Marker câu HỎI CHỌN KHUNG GIỜ trong OUTPUT bot (chỉ kỹ thuật chuỗi). cleanReply đã strip "?"
  // nên không yêu cầu dấu hỏi.
  const SCHED =
    /(sáng hay chiều|sáng\s*\/\s*chiều|chiều hay (?:tối|sáng)|sáng hay tối|tiện (?:ghé|qua|đến|sang|sắp xếp)[^.!?]*?(?:sáng|chiều|tối|hôm nào|bữa nào|giờ nào))/iu;
  if (!SCHED.test(text)) return text;

  // FACT giờ mở cửa: câu "…mở từ 9h–23h, anh tiện qua sáng hay chiều ạ" khớp SCHED nhưng
  // ĐÂY LÀ câu TRẢ LỜI giờ mở cửa (GATE giờ dặn "trả giờ + hỏi sáng/chiều"), KHÔNG phải giục
  // chốt. Cắt nó = giết luôn vế GIỜ khách vừa hỏi (bug né câu hỏi info). Giữ nguyên câu mang fact giờ.
  const HOURS_FACT = /\b\d{1,2}\s*h(?:\d{2}|\b)|mở\s*cửa|mở\s*từ|giờ\s*mở/iu;
  const isPremature = (s: string): boolean => SCHED.test(s) && !HOURS_FACT.test(s);

  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  // Không có câu giục-chốt THẬT (chỉ khớp SCHED trong câu trả giờ) → để nguyên, đừng nối câu mềm thừa.
  if (!sentences.some(isPremature)) return text;

  const h = ctx.honorific === "chị" ? "chị" : "anh";
  const soft = `Mình cứ thử trải nghiệm 1 buổi để KTV kiểm tra trực tiếp rồi tư vấn lộ trình đã, chưa cần quyết gì đâu ${h} ạ`;

  // Bỏ những câu giục chốt THẬT, ghép lời mời mềm vào cuối phần value còn lại (giữ câu mang fact giờ).
  const kept = sentences.filter((s) => !isPremature(s));
  const body = kept.join(" ").trim().replace(/[.,;\s]+$/, "");
  return body ? `${capFirst(body)}. ${soft}` : soft;
}

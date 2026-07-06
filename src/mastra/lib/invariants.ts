/**
 * invariants.ts — 4 BẤT BIẾN TẤT ĐỊNH của reply (assertion cứng, khác `expect` soi-mắt).
 *
 * Những hành vi PHẢI đúng 100% ở MỌI turn bất kể model sample ra gì. Đây là lưới gác kiểm tra
 * pipeline (guard G1–G6, qr-gate, salvage) THỰC SỰ làm việc — vi phạm = BUG code, không phải
 * "chạy lại cho may". Tách khỏi runner để test độc lập + tái dùng (vd gác cả tầng facebook.ts).
 *
 * INV3/INV4 mirror ĐÚNG điều kiện guard G5/G6 (replyGuards.ts) để không false-positive lúc khách
 * đã thật sự ngỏ mua. Mọi regex ở đây CHỈ soi TEXT ĐẦU RA CỦA BOT (pure text-parsing), KHÔNG
 * phân loại ý khách (việc đó của classifier).
 */

/** Có con số giá trong text chưa — mirror hasPrice() ở replyGuards.ts (G5). */
export function replyHasPrice(text: string): boolean {
  return /\d+\s*(k|nghìn|ngàn|triệu|tr|đồng)\b/i.test(text) || /\d{3,}/.test(text);
}

/** Marker HỎI CHỌN KHUNG GIỜ trong output bot — mirror SCHED ở replyGuards.ts (G6). */
export const SCHED_PUSH =
  /(sáng hay chiều|sáng\s*\/\s*chiều|chiều hay (?:tối|sáng)|sáng hay tối|tiện (?:ghé|qua|đến|sang|sắp xếp)[^.!?]*?(?:sáng|chiều|tối|hôm nào|bữa nào|giờ nào))/iu;

/** Shape tối thiểu cần để soi (state sau turn + output workflow). */
export interface InvariantInput {
  state: {
    flow?: string;
    intent?: string;
    intentTopic?: string | null;
    intentSignal?: { attribute?: string | null } | null;
    knownInfo?: {
      name?: string | null;
      phone?: string | null;
      preferredTime?: string | null;
    };
  };
  out: { qrUrl?: string | null } | null;
  reply: string;
}

/**
 * Soi 4 invariant. Trả danh sách vi phạm (rỗng = pass).
 */
export function checkInvariants({ state, out, reply }: InvariantInput): string[] {
  const v: string[] = [];
  const k = state.knownInfo ?? {};
  const t = (reply ?? "").trim();

  // INV1 — KHÔNG rò JSON thô / markdown ảnh / URL ảnh ra cho khách (salvageReplyObject + cleanReply).
  if (t.startsWith("{") || /"(text|mediaUrls|nextStep|secondaryAnswers|qrUrl)"\s*:/.test(t)) {
    v.push(`INV1 rò JSON thô ra reply: "${t.slice(0, 50)}…"`);
  }
  if (/!\[[^\]]*\]\([^)]*\)|https?:\/\/\S+\.(png|jpe?g|webp|mp4|mov)/i.test(t)) {
    v.push(`INV1 rò URL/markdown ảnh trong text (phải ở mediaUrls, không ở text)`);
  }

  // INV2 — KHÔNG đính QR trước khi đủ tên + SĐT (qr-gate).
  if (out?.qrUrl && !(k.name && k.phone)) {
    v.push(`INV2 QR đính sớm khi chưa đủ tên+SĐT (name=${k.name ?? "∅"} phone=${k.phone ?? "∅"})`);
  }

  // INV3 — hỏi giá HS/SV thì reply PHẢI có con số (G5 forceStudentPricing).
  const studentAsk =
    state.flow === "fitness" &&
    (state.intentTopic === "ask_student_pricing" ||
      state.intentSignal?.attribute === "ask_price_student");
  if (studentAsk && !replyHasPrice(t)) {
    v.push(`INV3 hỏi giá HS/SV mà reply KHÔNG có con số giá`);
  }

  // INV4 — giai-co CHƯA có tín hiệu mua thì reply KHÔNG được hỏi chọn giờ (G6). buyingSignal
  // mirror softenGiaiCoPrematureClose để không false-positive lúc khách đã ngỏ mua.
  if (state.flow === "giai-co") {
    const buyingSignal =
      state.intent === "selecting" ||
      state.intent === "ready" ||
      k.preferredTime != null ||
      (k.name != null && k.phone != null);
    if (!buyingSignal && SCHED_PUSH.test(t)) {
      v.push(`INV4 giai-co giục chốt (hỏi chọn giờ) khi khách CHƯA có tín hiệu mua`);
    }
  }

  return v;
}

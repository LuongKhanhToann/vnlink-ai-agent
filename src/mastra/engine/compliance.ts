/**
 * engine/compliance.ts — L6: Cổng ép tuân thủ (KHÔNG guardrail y tế — theo yêu cầu chủ dự án).
 *
 * Ràng buộc bắt buộc không phó thác cho thiện chí model mà kiểm bằng MÃ trên câu đã sinh; vi phạm →
 * sửa (regenerate có chỉ thị) ≤ N lần → nếu vẫn lọt bất biến thì SAFE_FALLBACK (không bao giờ phát
 * câu bịa giá ra kênh).
 *
 * (A) Bất biến chặn cứng:
 *   - PriceHallucinationGuard: reply nêu SỐ TIỀN nhưng lượt đó [TÀI LIỆU THAM KHẢO] rỗng (không tra
 *     được) ⇒ vi phạm (không có nguồn giá → phải mời tới trung tâm / kiểm tra lại, không phát số).
 * (B) Ràng buộc mềm theo bước (cố sửa, không chặn phát nếu A đã sạch):
 *   - S4 ⇒ nên có 2 mốc giờ + xin SĐT/tên; S5 ⇒ nên có xác nhận lịch.
 * (C) Định dạng: bỏ markdown/bảng/link — SỬA BẰNG MÃ (rẻ, không tốn call).
 *
 * Trích token là PARSING kỹ thuật (không phải quyết định nghiệp vụ) nên dùng thao tác chuỗi/regex.
 */

import type { StageCode } from "./taxonomy";
import type { TurnClassification } from "./classifier";

const N_REPAIR = (() => {
  const v = Number(process.env.N_REPAIR);
  return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 2;
})();

// ── (C) Định dạng: sửa bằng mã ──
/** Bỏ markdown bold/italic, tiêu đề, bảng, và link — trả câu như tin nhắn thường. */
export function stripFormatting(text: string): string {
  let s = text;
  s = s.replace(/```[\s\S]*?```/g, " "); // code fence
  s = s.replace(/!?\[([^\]]*)\]\((https?:[^)]+)\)/gi, "$1"); // [text](link) → text
  s = s.replace(/https?:\/\/\S+/gi, ""); // link trần
  s = s.replace(/^\s*#{1,6}\s+/gm, ""); // tiêu đề #
  s = s.replace(/^\s*\|.*\|\s*$/gm, ""); // dòng bảng
  s = s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[^*])\*(?!\*)([^*]+?)\*/g, "$1$2"); // bold/italic
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ── (A) Trích SỐ TIỀN (token có dấu hiệu tiền tệ) — không bắt giờ/tuổi/số buổi ──
const MONEY_RE =
  /\d[\d.,]*\s*(?:đ|vnđ|đồng|k(?![a-zà-ỹ])|tr(?![a-zà-ỹ])|triệu|nghìn|ngàn)\b|\d{1,3}(?:[.,]\d{3})+\b/gi;
export function extractMoneyTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MONEY_RE)) out.add(m[0].replace(/\s+/g, "").toLowerCase());
  return [...out];
}

export interface ComplianceCtx {
  facts: string; // khối [TÀI LIỆU THAM KHẢO] đã chèn lượt đó ("" nếu không tra được)
  stage: StageCode;
  cls: TurnClassification;
}
interface Violations {
  hard: string[]; // corrective instructions
  soft: string[];
}

function validate(reply: string, ctx: ComplianceCtx): Violations {
  const hard: string[] = [];
  const soft: string[] = [];

  // (A) PriceHallucination: có số tiền nhưng không có nguồn giá lượt này.
  const money = extractMoneyTokens(reply);
  if (money.length && !ctx.facts.trim()) {
    hard.push(
      `Câu trả lời có nêu số tiền (${money.slice(0, 3).join(", ")}) nhưng lượt này KHÔNG có tài liệu giá làm căn cứ. BỎ mọi con số tiền, thay bằng lời mời khách tới trung tâm hoặc để lại thông tin để em gửi báo giá chính xác.`,
    );
  }

  // (B) Ràng buộc mềm theo bước.
  const low = reply.toLowerCase();
  if (ctx.stage === "S4") {
    const hasTwoSlots = /\b(\d{1,2})\s*h\b/gi.test(reply) && (reply.match(/\b\d{1,2}\s*h\b/gi)?.length ?? 0) >= 2;
    const asksContact = /(số điện thoại|sđt|sdt|liên hệ|họ tên|tên.*số|zalo)/i.test(low);
    if (!hasTwoSlots || !asksContact)
      soft.push(
        "Đang ở bước CHỐT LỊCH: hãy đưa HAI mốc giờ cụ thể để khách chọn và khéo xin họ tên + số điện thoại để tạo phiếu trải nghiệm.",
      );
  }
  if (ctx.stage === "S5") {
    const confirms = /(xác nhận|đã đặt|đã ghi|hẹn gặp|lịch hẹn|chốt lịch)/i.test(low);
    if (!confirms)
      soft.push("Đang ở bước CHĂM SÓC: hãy xác nhận lại lịch hẹn với khách và hẹn sẽ nhắc trước giờ.");
  }
  return { hard, soft };
}

/** Câu an toàn khi vẫn lọt bất biến sau N lần sửa — không số, không bịa. */
export function safeFallback(): string {
  return "Dạ để em kiểm tra lại thông tin chính xác nhất rồi báo anh/chị ngay nha. Anh/chị để lại giúp em số điện thoại, hoặc qua trung tâm mình ở 32A Nguyễn Chí Thanh (Vĩnh Yên) để em tư vấn kỹ và có ưu đãi phù hợp nhất ạ 🌿";
}

/**
 * Chạy cổng tuân thủ. `regenerate(corrective)` là closure do brain cấp (gọi lại model kèm chỉ thị sửa).
 * Trả câu ĐẠT CHUẨN. Vòng sửa ≤ N_REPAIR; còn vi phạm bất biến → SAFE_FALLBACK.
 */
export async function complianceGate(
  reply0: string,
  ctx: ComplianceCtx,
  regenerate: (corrective: string) => Promise<string>,
): Promise<string> {
  let reply = stripFormatting(reply0);
  for (let attempt = 0; attempt < N_REPAIR; attempt++) {
    const v = validate(reply, ctx);
    if (!v.hard.length && !v.soft.length) return reply;
    if (!v.hard.length && attempt >= 1) return reply; // mềm: cố 1 lần, không chặn phát
    const corrective = [...v.hard, ...v.soft].join(" ");
    try {
      const regen = await regenerate(corrective);
      reply = stripFormatting(regen);
    } catch (e) {
      console.warn("[compliance] regenerate lỗi → giữ câu hiện tại:", (e as Error).message);
      break;
    }
  }
  // Sau vòng sửa: còn bất biến (A) → SAFE_FALLBACK.
  if (validate(reply, ctx).hard.length) {
    console.warn("[compliance] vẫn lọt bất biến sau sửa → SAFE_FALLBACK");
    return safeFallback();
  }
  return reply;
}

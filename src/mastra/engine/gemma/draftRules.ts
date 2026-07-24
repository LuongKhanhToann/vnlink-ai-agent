/**
 * draftRules.ts — SOÁT BẢN NHÁP trước khi gửi khách: luật nào bị phạm thì trả về chỉ thị
 * viết lại, pipeline gọi model sinh lại ĐÚNG 1 LẦN.
 *
 * Vì sao cần: gemma4:12b đọc prompt dài thì hay rơi mất 1-2 luật cuối. Mọi luật ở đây đều là
 * thứ SOI ĐƯỢC BẰNG HÌNH THỨC (bản nháp có dấu hỏi không, có con số tiền không, có trùng câu
 * đã hỏi không) — KHÔNG suy đoán ý khách, phần hiểu khách vẫn là của classifier.
 *
 * Thứ tự trong bảng = thứ tự ưu tiên; luật đầu tiên bắt được thì dừng (1 lần sinh lại thôi,
 * mỗi lần sinh lại tốn ~10s trên GPU tự host).
 */

import { isGiaiCoDiscoveryGate, type ConvState } from "./state";
import { countMoneyMentions, extractQuestions, findRepeatedQuestion, isRepeatedReply } from "./text";

export interface DraftContext {
  conv: ConvState;
  /**
   * Bản nháp đã gỡ dòng "MEDIA:", CHƯA qua cleanReply — CÒN dấu "?" nên dùng cho các luật
   * soi CÂU HỎI (cleanReply strip hết dấu hỏi, soi sau đó thì không thấy câu nào).
   */
  draft: string;
  /**
   * Tin SAU cleanReply + guard — đúng chuỗi khách nhận trên Facebook. Các luật soi NỘI DUNG
   * (có con số tiền không, xổ mấy mốc) PHẢI soi chuỗi này: cleanReply cắt tin quá dài ở ranh
   * giới câu, nên bản nháp có giá mà tin gửi đi thì không (bắt được ở VANDAI lượt 1: nháp 433
   * ký tự đủ giá → khách nhận 193 ký tự, mất sạch số).
   */
  final: string;
  /** Các câu hỏi bot đã dùng trong cuộc (dạng norm). */
  askedNorms: string[];
  /** Các tin bot đã nhắn trong cuộc (dạng norm). */
  prevReplyNorms: string[];
}

export interface DraftVerdict {
  /** Ghi vào notes để đọc transcript biết vì sao phải sinh lại. */
  note: string;
  /** Câu chỉ thị nối thêm vào khối bối cảnh khi sinh lại. */
  directive: string;
  /** Vá CƠ HỌC khi sinh lại xong vẫn phạm đúng luật đó; null = bản mới đã sạch/không vá được. */
  repair?: (draft: string) => { text: string; note: string } | null;
}

interface DraftRule {
  id: string;
  /** Trả chi tiết vi phạm (chuỗi) nếu PHẠM luật, null nếu bản nháp đạt. */
  detect: (ctx: DraftContext) => string | null;
  verdict: (detail: string, ctx: DraftContext) => DraftVerdict;
}

/**
 * Số mốc tiền tối đa trong 1 tin. Ngưỡng 2 chứ không phải 1 vì có ca báo 2 mức hợp lệ
 * (giải cơ 45 phút / 75 phút, gói gia đình 2 người / 3 người).
 */
const MAX_MONEY_MENTIONS = 2;

const RULES: DraftRule[] = [
  {
    id: "lap-cau-hoi",
    detect: (c) => findRepeatedQuestion(c.draft, c.askedNorms),
    verdict: (q, ctx) => ({
      note: `vá lặp câu hỏi: "${q.slice(0, 50)}"`,
      directive: `- BẢN NHÁP BỊ LOẠI vì lặp câu hỏi đã dùng ("${q}"). Viết lại tin này KHÔNG dùng câu đó hay câu na ná; nếu không cần hỏi gì thì kết tin không có câu hỏi.`,
      repair: (draft) => {
        const still = findRepeatedQuestion(draft, ctx.askedNorms);
        if (!still) return null;
        const cut = draft.replace(still, "").replace(/[ \t]+\n/g, "\n").trim();
        // ⚠ Cả tin CHỈ gồm đúng câu lặp đó → cắt xong còn rỗng, khách nhận tin trắng (bắt được
        // ở TANGCAN lượt 17). Rỗng còn tệ hơn lặp → giữ nguyên bản nháp.
        return cut.length >= 15
          ? { text: cut, note: "cắt câu lặp còn sót" }
          : { text: draft, note: "giữ nguyên bản nháp (cắt câu lặp sẽ ra tin rỗng)" };
      },
    }),
  },
  {
    id: "lap-ca-tin",
    detect: (c) => (isRepeatedReply(c.final, c.prevReplyNorms) ? "toàn tin" : null),
    verdict: () => ({
      note: "vá lặp cả tin",
      directive: `- BẢN NHÁP BỊ LOẠI vì lặp gần nguyên văn một tin em đã nhắn trước đó. Viết lại NGẮN GỌN HƠN với cấu trúc câu KHÁC HẲN, không tái dùng các cụm từ của bản nháp; ý nào đã nói ở tin trước thì chỉ xác nhận lại 1 câu, tập trung vào đúng điều MỚI khách vừa nói.`,
    }),
  },
  {
    // Nhịp discovery giải cơ: tin BẮT BUỘC kết bằng 1 câu hỏi để hiểu thêm. 12B rất hay bỏ câu
    // hỏi rồi giảng luôn cơ chế/so massage (bắt được ở GIAICO lượt 2-3, cả 2 vòng test).
    id: "discovery-thieu-cau-hoi",
    detect: (c) =>
      isGiaiCoDiscoveryGate(c.conv) && extractQuestions(c.draft).length === 0 ? "không có câu hỏi nào" : null,
    verdict: () => ({
      note: "vá tin discovery thiếu câu hỏi",
      directive: `- BẢN NHÁP BỊ LOẠI vì em lại đi GIẢNG cơ chế trong lúc còn đang tìm hiểu tình trạng khách. Viết lại ĐÚNG 2 câu: (1) đồng cảm ngắn với cái khách vừa kể, (2) một câu hỏi ngắn để hiểu thêm, kết bằng "ạ". CẤM nhắc "cơ co cứng/nút thắt", CẤM so sánh massage, CẤM mời trải nghiệm, CẤM nhắc giá.`,
    }),
  },
  {
    // Khách đã ngỏ ý ĐẾN mà tin không hỏi ngày → phễu đứng im, khách phải tự nêu ngày mới đi
    // tiếp (bắt được ở GIAICO lượt 12 và GIAMCAN lượt 17). Chỉ áp khi KHÔNG vướng an toàn:
    // ca bầu/sau sinh/bệnh nền/chấn thương cấp thì luật an toàn CẤM giục lịch, phải nhường.
    id: "muon-den-thieu-cau-hoi",
    detect: (c) =>
      c.conv.wantsCome &&
      !c.conv.ngayChot &&
      !c.conv.closed &&
      !c.conv.triHoan &&
      c.conv.anToan === "khong" &&
      extractQuestions(c.draft).length === 0
        ? "khách muốn đến mà tin không hỏi ngày"
        : null,
    verdict: () => ({
      note: "vá tin bỏ quên câu hỏi ngày",
      directive: `- BẢN NHÁP BỊ LOẠI vì khách ĐÃ tỏ ý muốn qua mà tin lại không hỏi ngày nào. Viết lại NGẮN: giữ 1 câu xác nhận/dẫn dắt rồi KẾT bằng đúng 1 câu hỏi khách tiện qua hôm nào. CHƯA xin tên/SĐT ở tin này.`,
    }),
  },
  {
    // Khách HỎI GIÁ thì tin trả lời BẮT BUỘC có con số tiền. Bắt được ca khách nhồi 3 câu
    // ("có bể bơi ko, gói tháng nhiêu tiền, có ở Vĩnh Yên ko") → 12B trả 2 ý, im ý GIÁ.
    // ⚠ Lượt khách CHÊ ĐẮT thì tin ĐÚNG là reframe giá trị KHÔNG kèm số — không ép số vào đó.
    id: "hoi-gia-khong-co-so",
    detect: (c) =>
      c.conv.hoiGiaTurn && !c.conv.cheDatTurn && countMoneyMentions(c.final) === 0
        ? "không có số tiền"
        : null,
    verdict: () => ({
      note: "vá tin hỏi-giá mà không có số tiền",
      directive: `- BẢN NHÁP BỊ LOẠI vì khách ĐANG HỎI GIÁ mà tin không có con số tiền nào. Viết lại NGẮN — tối đa 3 câu, đặt con số ngay CÂU ĐẦU (tin quá dài sẽ bị cắt đuôi và mất luôn phần giá): nêu ĐÚNG 1 gói cụ thể kèm ĐÚNG 1 số tiền viết bằng chữ đầy đủ (vd "500 nghìn", "4.5 triệu") chép từ BẢNG TRA ở khối bối cảnh. Khách hỏi nhiều ý thì trả lời các ý còn lại thật gọn, mỗi ý 1 vế ngắn. ⛔ Chỉ 1 con số thôi — CẤM kèm thêm mốc giá nào khác trong cùng tin.`,
    }),
  },
  {
    // Luật văn phong "1 gói + 1 mốc": xổ cả dãy giá đọc như tờ rơi, làm khách chọn gói rẻ nhất,
    // và tin dài quá hạn mức thì cleanReply CẮT ĐUÔI — nuốt luôn phần giá. Đếm mốc tiền là soi
    // hình thức thuần, không phán đoán ý khách.
    id: "xo-nhieu-moc-gia",
    detect: (c) => {
      const n = countMoneyMentions(c.final);
      return n > MAX_MONEY_MENTIONS ? `${n} mốc tiền trong 1 tin` : null;
    },
    verdict: (detail) => ({
      note: `vá tin xổ nhiều mốc giá (${detail})`,
      directive: `- BẢN NHÁP BỊ LOẠI vì tin xổ NHIỀU mốc giá cùng lúc (${detail}) — đọc như tờ rơi. Viết lại: giữ ĐÚNG 1 con số tiền (mốc sát nhu cầu khách nhất), bỏ hẳn các con số còn lại. Muốn hé còn lựa chọn khác thì nói suông KHÔNG kèm số, vd "bên em có gói ngắn hơn nếu mình muốn linh hoạt ạ".`,
    }),
  },
];

/** Luật đầu tiên bị phạm — null nghĩa là bản nháp dùng được. */
export function reviewDraft(ctx: DraftContext): DraftVerdict | null {
  for (const rule of RULES) {
    const detail = rule.detect(ctx);
    if (detail) return rule.verdict(detail, ctx);
  }
  return null;
}

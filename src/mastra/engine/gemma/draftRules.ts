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

import { coSoHotline, HOTLINE_CO_ZALO, HOTLINE } from "../contact";
import { isGiaiCoDiscoveryGate, type ConvState } from "./state";
import {
  chiLaLoiChao,
  coVeAnToan,
  countMoneyMentions,
  dropSentenceContaining,
  extractQuestions,
  findNgayKhangDinh,
  findPlaceholderSlot,
  findRepeatedQuestion,
  isRepeatedReply,
} from "./text";

export interface DraftContext {
  conv: ConvState;
  /** 2 ngày cụ thể mà hệ thống YÊU CẦU tin này đưa ra (bước chốt lịch) — rỗng nếu lượt này không. */
  dayOptions?: string[];
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

/**
 * Vế dặn an toàn CHUẨN. Export vì pipeline phải nối lại được sau khi cleanReply chạy: guard
 * chống-lặp của cleanReply CẮT câu này khi lượt trước đã dặn (cho một tình trạng KHÁC) — đo ở
 * ANTOAN#3 (lượt 1 dặn cho "bầu", lượt 3 hỏi cho mẹ 63 tuổi huyết áp thì vế dặn bị nuốt sạch).
 * An toàn là nội dung BẮT BUỘC, không được để luật văn phong xoá.
 */
export const VE_AN_TOAN =
  "Mình nhớ tham khảo ý kiến bác sĩ hoặc mang theo giấy khám sức khỏe trước khi tập để bên em hỗ trợ an toàn nhất ạ.";

export interface DraftVerdict {
  /** id của luật đã bắt — pipeline dùng để biết có phải vá an toàn hay không. */
  id: string;
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
    // ⛔ Ưu tiên CAO NHẤT: chỗ trống để điền lọt ra ngoài là lỗi khách thấy ngay lập tức, tệ hơn
    // mọi lỗi văn phong khác. LIVE 26/07 (convo 38412582635006991): khách xin số điện thoại →
    // "Số điện thoại của em là [Số điện thoại của bạn]" gửi thật 2 lần.
    id: "cho-trong-de-dien",
    detect: (c) => findPlaceholderSlot(c.final) ?? findPlaceholderSlot(c.draft),
    verdict: (slot, ctx) => ({
      note: `vá chỗ trống để điền: ${slot}`,
      directive:
        `- BẢN NHÁP BỊ LOẠI vì còn CHỖ TRỐNG ĐỂ ĐIỀN "${slot}" — khách nhận đúng chữ đó là lộ ngay bot. ` +
        `Viết lại KHÔNG có bất kỳ cụm nào trong ngoặc vuông. ` +
        `Nếu khách đang xin SỐ ĐIỆN THOẠI / zalo của bên em: số của trung tâm là ${HOTLINE} — viết ĐÚNG dãy này, chép nguyên văn, ⛔ CẤM để trống, CẤM đổi chữ số nào. ` +
        `Thông tin nào chưa biết thì nói thẳng "để em xác nhận lại rồi báo mình ạ".`,
      repair: (draft) => {
        const still = findPlaceholderSlot(draft);
        if (!still) return null;
        const cut = dropSentenceContaining(draft, still);
        if (cut.length >= 15) return { text: cut, note: "cắt câu chứa chỗ trống để điền" };
        // Đã có số thật → vá bằng chính số đó (khách vừa hỏi số mà nhận lại câu xin số của họ là né
        // câu hỏi).
        const xung = ctx.conv.xung === "chi" ? "chị" : ctx.conv.xung === "anh" ? "anh" : "anh/chị";
        return {
          text: `Dạ số của trung tâm em là ${HOTLINE}, ${xung} gọi trực tiếp giúp em ạ.`,
          note: "thay bằng câu đưa hotline (bản nháp chỉ còn chỗ trống)",
        };
      },
    }),
  },
  {
    // Khách XIN SỐ mà tin gửi đi lại KHÔNG có số — lỗi chỉ lộ ở lượt khách hỏi LẠI lần 2 ("Sdt nào
    // ạ"): luật chống-lặp của văn phong đẩy 12B sang cách nói khác rồi bỏ luôn dãy số, quay sang
    // xin số của khách (đo 1/3 lần chạy smoke 27/07). Số điện thoại là nội dung BẮT BUỘC của lượt
    // này, không được để luật văn phong nuốt.
    // Kèm luôn ca bịa tiện ích: khẳng định số này nhắn được Zalo trong khi chưa ai xác nhận.
    id: "hotline-sai",
    detect: (c) => {
      // ⚠ Vế Zalo KHÔNG gác theo cờ "khách đòi người thật": ở lượt khách hỏi lại cụt lủn ("Sdt nào
      // ạ") classifier không phải lúc nào cũng bật cờ đó, mà đúng lượt ấy 12B lại hay tự thêm
      // "hoặc nhắn qua Zalo" (đo 2/4 lần chạy). Bịa tiện ích thì lượt nào cũng là bịa.
      if (!HOTLINE_CO_ZALO && /zalo|viber/i.test(c.final)) return "khẳng định số này có Zalo/Viber (chưa xác nhận)";
      if (c.conv.doiNguoiThatTurn && !coSoHotline(c.final)) return "tin thiếu số hotline dù khách đang hỏi số";
      return null;
    },
    verdict: (detail, ctx) => ({
      note: `vá hotline: ${detail}`,
      directive:
        `- BẢN NHÁP BỊ LOẠI: ${detail}. ` +
        (HOTLINE_CO_ZALO ? "" : `⛔ CẤM nói số của bên em nhắn được Zalo/Viber — chưa ai xác nhận, đó là bịa tiện ích. Chỉ nói đây là số để GỌI. `) +
        `Khách đang hỏi SỐ ĐIỆN THOẠI của bên em → tin này BẮT BUỘC có đúng dãy ${HOTLINE}, chép nguyên văn, kể cả khi tin trước đã nói rồi (khách hỏi lại thì NHẮC LẠI, không được né vì sợ lặp). ⛔ CẤM thay bằng câu xin số của khách, CẤM đọc ra số khác.`,
      repair: (draft) => {
        let t = draft;
        const ghiChu: string[] = [];
        if (!HOTLINE_CO_ZALO) {
          for (const tu of ["Zalo", "zalo", "Viber", "viber"]) {
            const cut = dropSentenceContaining(t, tu);
            if (cut !== t) {
              t = cut;
              ghiChu.push("bỏ câu khẳng định Zalo");
            }
          }
        }
        if (ctx.conv.doiNguoiThatTurn && !coSoHotline(t)) {
          const xung = ctx.conv.xung === "chi" ? "chị" : ctx.conv.xung === "anh" ? "anh" : "anh/chị";
          const cau = `Dạ số của trung tâm em là ${HOTLINE}, ${xung} gọi trực tiếp giúp em ạ.`;
          t = t.trim().length >= 15 ? `${t.trim().replace(/[.\s]*$/, ".")} ${cau}` : cau;
          ghiChu.push("nối lại số hotline");
        }
        return ghiChu.length ? { text: t, note: ghiChu.join(" + ") } : null;
      },
    }),
  },
  {
    // Lượt PHẢI dặn an toàn (tình trạng MỚI, chưa dặn lần nào) mà tin lại thiếu vế bác sĩ/giấy
    // khám → ép sinh lại. 12B rơi vế này khoảng 1/3 số lượt dù chỉ thị nằm ngay đầu khối (đo
    // ANTOAN#3 cả bản cũ lẫn bản mới: chỉ nói "cần giám sát kỹ lưỡng"). Vá cơ học = nối thẳng
    // câu chuẩn vào cuối tin, vì thiếu cảnh báo an toàn là rủi ro thật chứ không phải văn phong.
    id: "thieu-ve-an-toan",
    detect: (c) =>
      c.conv.anToan !== "khong" &&
      c.conv.anToan !== "cap-tinh" &&
      c.conv.anToanDaDan !== c.conv.anToan &&
      // Lượt khách hỏi chuyện NGOÀI phạm vi (bán thuốc, giao đồ ăn…) thì nhét lời dặn "trước khi
      // tập" vào là lạc đề — chờ lượt nào thật sự nói chuyện tập luyện (YTE#3).
      !c.conv.ngoaiPhamViTurn &&
      !coVeAnToan(c.final)
        ? `tình trạng ${c.conv.anToan} chưa từng được dặn`
        : null,
    verdict: (detail) => ({
      note: `vá tin thiếu vế an toàn (${detail})`,
      directive: `- BẢN NHÁP BỊ LOẠI vì lượt này khách có tình trạng sức khoẻ cần lưu ý mà tin lại KHÔNG có vế khuyên hỏi bác sĩ. Viết lại NGẮN: câu đầu trả lời đúng điều khách vừa hỏi, rồi 1 câu chép gần nguyên văn "anh/chị nhớ tham khảo ý kiến bác sĩ hoặc mang theo giấy khám sức khỏe trước khi tập để bên em hỗ trợ an toàn nhất ạ". KHÔNG hứa chữa khỏi bệnh, KHÔNG giục chốt lịch.`,
      repair: (draft) => {
        if (coVeAnToan(draft)) return null;
        // ⚠ Phải CẮT BỚT bản nháp trước khi nối: cleanReply cắt đuôi tin quá dài (cap 320 ký tự)
        // — nối vào tin đã dài thì chính vế an toàn vừa thêm bị nuốt mất.
        const cau = draft.trim().split(/(?<=[.!?])\s+/);
        let dau = "";
        for (const c of cau) {
          if ((dau + " " + c).trim().length + VE_AN_TOAN.length + 1 > 300) break;
          dau = (dau + " " + c).trim();
        }
        if (!dau) dau = cau[0] ?? "";
        return {
          text: `${dau.replace(/[.\s]*$/, ".")} ${VE_AN_TOAN}`,
          note: "nối thêm vế an toàn còn thiếu",
        };
      },
    }),
  },
  {
    // Tự CHỐT NGÀY hộ khách: state chưa có ngày hẹn nào, hệ thống cũng KHÔNG yêu cầu đưa 2 ngày,
    // vậy mà tin lại nói "ngày mai/thứ Bảy…" → đó là hẹn một ngày khách chưa hề chọn (đo LIVE
    // 26/07 convo 38412582635006991: khách "hôm sau mình sẽ ghé qua" → bot "vậy ngày mai…").
    id: "tu-chot-ngay",
    detect: (c) =>
      !c.conv.ngayChot && !(c.dayOptions?.length ?? 0) ? findNgayKhangDinh(c.final) : null,
    verdict: (tu) => ({
      note: `vá tự chốt ngày hộ khách ("${tu}")`,
      directive: `- BẢN NHÁP BỊ LOẠI vì tin nhắc tới "${tu}" trong khi khách CHƯA chọn ngày nào cả — nói vậy là tự đặt lịch hộ khách. Viết lại KHÔNG có bất kỳ mốc ngày cụ thể nào (không "ngày mai", không thứ mấy, không "hôm nay"): khách nói mốc mơ hồ thì giữ nguyên kiểu mơ hồ ("khi nào mình qua"/"hôm nào mình tiện"), muốn tiến bước thì HỎI khách tiện hôm nào.`,
    }),
  },
  {
    // Tin CHỈ có lời chào, không trả lời gì — hỏng nặng nhất ở LƯỢT ĐẦU (ấn tượng đầu tiên).
    // Đo ở replay LIVE convo 28112002548394082: khách hỏi "Học bơi trong bao lâu?" mà nhận lại
    // đúng một câu chào. Ngẫu nhiên (chạy lại thì đúng) → phải có lưới chặn tất định.
    id: "chi-co-loi-chao",
    detect: (c) => (chiLaLoiChao(c.final) ? "tin chỉ có lời chào" : null),
    verdict: () => ({
      note: "vá tin chỉ có lời chào",
      directive: `- BẢN NHÁP BỊ LOẠI vì cả tin chỉ có lời chào/cảm ơn, KHÔNG trả lời gì cho khách. Viết lại: chào đúng 1 câu NGẮN rồi TRẢ LỜI THẲNG điều khách vừa hỏi (có số liệu/giá nếu khách hỏi giá), xong mới hỏi lại 1 câu.`,
    }),
  },
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
    if (detail) return { ...rule.verdict(detail, ctx), id: rule.id };
  }
  return null;
}

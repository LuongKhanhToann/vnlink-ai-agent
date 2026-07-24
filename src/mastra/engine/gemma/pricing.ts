/**
 * pricing.ts — BẢNG GIÁ (Excel 07/2026) + luật báo giá cho nhánh gemma.
 *
 * ⚠ Sửa số ở đây = đổi nghiệp vụ thật. Số phải khớp `engine/prompts.ts` của bản 5.4.
 *
 * Vì sao tách riêng & CẮT NHỎ:
 *   Trước đây cả bảng giá (~1.500 ký tự, mọi gói, mỗi gói 1 dãy "500k · 1.5 · 2.5 · 4.5")
 *   được nhét nguyên khối vào khối bối cảnh mỗi lượt khách hỏi giá. gemma4:12b nhìn thấy
 *   một DÃY thì chép cả DÃY → tin nào cũng xổ 3-4 mốc giá, phạm luật "1 gói + 1 mốc"
 *   (bắt được ở HOIGIA lượt 1 và 3, 23/07).
 *   Giờ: code tra bảng theo slot classifier đã nhặt (nhóm giá / bộ môn / đối tượng) rồi bơm
 *   ĐÚNG vài dòng cần, MỖI MỐC MỘT DÒNG — "chép đúng 1 dòng" thành lệnh cụ thể model làm được,
 *   và khối bối cảnh nhẹ đi ~1.100 ký tự mỗi lượt hỏi giá.
 */

import type { ConvState } from "./state";

/** Nhóm giá khách đang hỏi — do classifier quyết (xem `gia_hoi_ve`), code chỉ tra bảng. */
export type PriceBucket =
  | ""
  | "the-tap"
  | "pt-1-1"
  | "hoc-boi"
  | "ve-boi-le"
  | "pilates"
  | "thue-hlv"
  | "lieu-trinh";

export const PRICE_BUCKETS: PriceBucket[] = [
  "",
  "the-tap",
  "pt-1-1",
  "hoc-boi",
  "ve-boi-le",
  "pilates",
  "thue-hlv",
  "lieu-trinh",
];

/** Thẻ hội viên theo tháng: giá 1 / 3 / 6 / 12 tháng. */
interface Card {
  ten: string;
  moc: [string, string][];
}

const THANG = ["1 tháng", "3 tháng", "6 tháng", "12 tháng"];
const card = (ten: string, ...gia: string[]): Card => ({
  ten,
  moc: gia.map((g, i) => [THANG[i], g] as [string, string]),
});

const FULL = card("FULL 4 môn (Gym+Bơi+Yoga+Zumba)", "800 nghìn", "2.1 triệu", "3.8 triệu", "7 triệu");
const GYM = card("Gym", "500 nghìn", "1.5 triệu", "2.5 triệu", "4.5 triệu");
const YOGA = card("Yoga", "650 nghìn", "1.8 triệu", "3.3 triệu", "5.8 triệu");
const ZUMBA = card("Zumba", "500 nghìn", "1.8 triệu", "3.3 triệu", "5.8 triệu");
const BOI_LON = card("Bơi người lớn", "700 nghìn", "1.8 triệu", "2.5 triệu", "4.5 triệu");
const BOI_BE = card("Bơi trẻ em", "600 nghìn", "1.5 triệu", "2 triệu", "3.6 triệu");
const ECO = card("Fami ECO (2 môn tự chọn, trừ Yoga)", "700 nghìn", "2 triệu", "3.5 triệu", "6.3 triệu");
const FULL_HSSV = card("FULL học sinh - sinh viên (14-22 tuổi, cả 4 dịch vụ)", "500 nghìn", "1.2 triệu", "2.1 triệu", "3.6 triệu");
const FULL_GV = card("FULL giáo viên (cả 4 dịch vụ)", "700 nghìn", "1.8 triệu", "2.8 triệu", "4.8 triệu");
/** Dòng NEO: chỉ mốc 12 tháng của một gói, để model không bị cám dỗ đọc cả bảng. */
const neo = (c: Card, ten = c.ten) => `${ten} | ${c.moc[3][0]} = ${c.moc[3][1]}`;
const FULL_NEO = `${neo(FULL, "FULL 4 môn (nâng cấp dùng cả Gym+Bơi+Yoga+Zumba)")}  ← chỉ nêu khi khách muốn NÂNG CẤP; khách xin gói RẺ HƠN thì CẤM lôi dòng này ra`;
const GYM_TAP_THUA = "Gym tập thưa | 3 buổi mỗi tuần = 60% · 4 buổi mỗi tuần = 80% giá gym ở trên (chỉ nêu khi khách hỏi tập mấy buổi một tuần)";

/** Các bảng KHÔNG theo mốc tháng — giữ nguyên văn, chỉ bơm khi khách hỏi đúng nhóm. */
const BANG_KHAC: Record<Exclude<PriceBucket, "" | "the-tap" | "lieu-trinh">, string> = {
  "pt-1-1":
    "PT 1 kèm 1 | 10 buổi = 3 triệu\nPT 1 kèm 1 | 15 buổi = 4 triệu\nPT 1 kèm 1 | 20 buổi = 6 triệu\nPT 1 kèm 1 | 30 buổi = 8 triệu\nPT 1 kèm 1 | 40 buổi = 10 triệu\nPT 1 kèm 1 | 50 buổi = 12 triệu\nPT cho học sinh - sinh viên | 10 buổi = 3 triệu · 20 buổi = 6 triệu",
  "hoc-boi":
    "Học bơi lớp nhóm | 12 buổi = 1.5 triệu\nHọc bơi 1 kèm 1 | 12 buổi = 3 triệu\nHọc bơi 1 kèm 1 nhóm từ 2 người | 5 triệu mỗi cặp\nHọc bơi 1 kèm 1 hai kiểu bơi | 20 buổi = 5 triệu\n(mọi gói học bơi đều tặng 1 tháng bơi tự do + cam kết biết bơi)\n➤ ÁP DỤNG CHUNG CẢ NGƯỜI LỚN VÀ TRẺ EM/BÉ: khách hỏi \"gói/khoá trẻ em\", \"học bơi cho bé\", \"gói cho cháu\" thì VẪN dùng đúng các mức khoá học trên (lớp nhóm 1.5 triệu / 1 kèm 1 3 triệu), KHÔNG có bảng khoá học riêng đắt hơn cho trẻ em.",
  "ve-boi-le":
    "Vé bơi lẻ - cao dưới 1m | 20 nghìn mỗi lượt\nVé bơi lẻ - cao 1m đến 1m5 | 30 nghìn mỗi lượt\nVé bơi lẻ - cao trên 1m5 | 40 nghìn mỗi lượt",
  pilates:
    "Pilates thảm (1 thầy 7 người) | 10 buổi = 1.5 triệu · 20 buổi = 2.4 triệu · 30 buổi = 3 triệu\nPilates máy (1 thầy 6 người) | 10 buổi = 1.9 triệu · 20 buổi = 3.6 triệu · 30 buổi = 5.1 triệu\nPilates nhóm nhỏ (1 thầy 3 người) | 10 buổi = 3 triệu · 20 buổi = 5.8 triệu · 30 buổi = 8.1 triệu\nPilates 1 kèm 1 | 10 buổi = 4.5 triệu · 20 buổi = 8.6 triệu",
  "thue-hlv": "Thuê HLV Gym theo giờ | 50 nghìn mỗi giờ\nThuê HLV Pilates theo giờ | 80 nghìn mỗi giờ",
};

const GIA_DINH =
  "Gói GIA ĐÌNH (thẻ FULL 12 tháng) | 2 người = 12 triệu\nGói GIA ĐÌNH (thẻ FULL 12 tháng) | 3 người = 14 triệu (mua 3 tặng 1 người, 4 người vẫn 14 triệu)";

/** Buổi lẻ: 2 dòng ĐẦU là mức báo cho khách; các hạng CB/VIP chỉ dùng khi khách hỏi đúng tên. */
const GIAI_CO_LE = [
  "Giải cơ buổi lẻ | 45 phút (1-2 vùng) = 200 nghìn  ← mức tham chiếu báo khách",
  "Giải cơ buổi lẻ | 75 phút = 330 nghìn  ← mức tham chiếu báo khách",
  "Hạng CB1 = 330 nghìn · CB2 = 380 nghìn · CS-CB = 380 nghìn · CS-VIP1 = 480 nghìn · CS-VIP2 = 590 nghìn (chỉ nêu khi khách hỏi đúng tên hạng)",
  "Massage lẻ: Thải độc = 100 nghìn · Spa Foot = 200 nghìn · Full Foot = 270 nghìn · Spa Body = 280 nghìn · Full Body = 330 nghìn · VIP2 = 380 nghìn · VIP1 = 420 nghìn (chỉ nêu khi khách hỏi massage thường)",
].join("\n");
const GIAI_CO_LIEU_TRINH = [
  "Liệu trình VIP1 | 10 buổi = 4.2 triệu (tặng 1 → 11 buổi) · 20 buổi = 8.4 triệu (tặng 3 → 23 buổi)",
  "Liệu trình VIP2 | 10 buổi = 3.8 triệu (tặng 1 → 11 buổi) · 20 buổi = 7.6 triệu (tặng 3 → 23 buổi)",
  "Liệu trình Full Body | 10 buổi = 3.3 triệu (tặng 1 → 11 buổi) · 20 buổi = 6.6 triệu (tặng 3 → 23 buổi)",
].join("\n");

function render(cards: Card[]): string {
  return cards.flatMap((c) => c.moc.map(([moc, gia]) => `${c.ten} | ${moc} = ${gia}`)).join("\n");
}

/**
 * Bảng tra cho khách hỏi thẻ tập: ĐÚNG gói khách đang hỏi (4 mốc) + 1 dòng neo nâng cấp.
 * Cố ý KHÔNG bơm cả bảng FULL kèm theo — càng nhiều dòng, 12B càng dễ xổ hết ra cho khách.
 */
function tableForSport(boMon: string): string {
  switch (boMon) {
    case "gym":
      return [render([GYM]), FULL_NEO, GYM_TAP_THUA].join("\n");
    case "yoga":
      return [render([YOGA]), FULL_NEO].join("\n");
    case "zumba":
      return [render([ZUMBA]), FULL_NEO].join("\n");
    case "boi":
      return [render([BOI_LON]), render([BOI_BE]), FULL_NEO].join("\n");
    default:
      return [
        render([FULL]),
        neo(ECO),
        `⛔ Fami ECO KHÔNG gồm Yoga: khách muốn tập CÓ yoga (vd "bơi và yoga", "gym + yoga") thì CẤM đề xuất ECO cho họ — trường hợp đó báo thẻ FULL (dùng cả 4 dịch vụ) hoặc giá TÁCH từng môn, KHÔNG có gói ghép 2 môn rẻ hơn nếu 1 trong 2 môn là yoga.`,
      ].join("\n");
  }
}

/** Luật "1 tin = 1 mốc giá" — chỗ 12B hay phạm nhất nên viết ngắn, đứng ngay trước bảng. */
const LUAT_MOT_MOC =
  `⛔ LUẬT 1 MỐC: tin này phải có ĐÚNG 1 con số tiền — KHÔNG nhiều hơn và cũng KHÔNG được thiếu. ` +
  `Con số đó là câu TRẢ LỜI THẲNG cho khách: chép 1 dòng khớp mốc khách hỏi; khách KHÔNG nêu thời hạn (hỏi chung "giá bao nhiêu", "vé/gói tháng nhiêu tiền", "giá bơi/gym sao") thì neo bằng mốc 1 THÁNG (mức khởi điểm, đúng nghĩa "vé tháng"), rồi mời khách cho biết định tập bao lâu để báo gói dài ưu đãi hơn. ⛔ CẤM tự nhảy lên mốc 12 tháng (mức ĐẮT NHẤT) khi khách chưa nói thời hạn — báo số cao nhất trước dễ làm khách e ngại và trả sai ý khi khách hỏi "vé THÁNG". ` +
  `⚠ Khách xin MỘT LỰA CHỌN KHÁC ("có gói nào rẻ hơn không", "gói ngắn hơn thì sao") → con số phải là mốc KHÁC, CHƯA từng báo — lặp lại đúng số vừa nói là không trả lời câu khách hỏi. ` +
  `Nếu muốn hé rằng còn lựa chọn khác thì nói SUÔNG, KHÔNG kèm số ("bên em có gói ngắn hơn nếu mình muốn linh hoạt ạ") — lượt sau khách hỏi mới báo số. ` +
  `⛔ CẤM đọc cả dãy 1/3/6/12 tháng trong 1 tin. ` +
  `⛔ Số tháng là THỜI HẠN thẻ, KHÔNG phải tuổi: nói "thẻ/gói ... thời hạn X tháng" và CẤM gắn "bé"/"con"/"cháu" ngay trước số tháng ("bé 12 tháng", "con 6 tháng" đọc thành tuổi đứa trẻ → sai). Đúng: "gói bơi trẻ em thời hạn 12 tháng giá 3.6 triệu ạ". ` +
  `⚠ NGOẠI LỆ (khách xin RÕ xem NHIỀU mốc): khi khách nói thẳng muốn xem danh sách — "cho xem các gói", "xem gói dài hơn", "có mấy loại", "liệt kê các mức", "các gói thế nào" — thì được nêu 2-3 mốc CỦA CÙNG MỘT LOẠI gói khách đang hỏi, MỖI MỐC 1 DÒNG (vd 3 tháng / 6 tháng / 12 tháng), rồi hỏi 1 câu chốt nhu cầu. VẪN cấm trộn nhiều LOẠI gói khác nhau hay đổ cả bảng nhiều bộ môn trong 1 tin.`;

/**
 * Dòng chỉ dẫn BÁO GIÁ bơm vào khối bối cảnh — gồm luật + đúng vài dòng bảng cần tra.
 * Trả "" khi lượt này khách không hỏi giá.
 */
export function buildPriceDirective(s: ConvState, bucket: PriceBucket): string {
  // ⚠ Head KHÔNG được chứa con số tiền nào: 12B hay bốc luôn số trong ví dụ ra báo cho khách.
  const head = `- Khách ĐANG hỏi giá → answer-first: nêu con số NGAY trong 1-2 câu ĐẦU của tin (cuối tin có thể bị cắt), cả tin gọn trong 3 câu. ⛔ CẤM né bằng "mình qua trung tâm em tư vấn kỹ hơn" — né giá là mất khách. Giá đọc bằng chữ đầy đủ ("nghìn"/"triệu"), CẤM viết tắt kiểu "k", "tr", "triệu rưỡi"; gọi ĐÚNG tên gói trong bảng.`;
  const table = (luat: string, body: string) => `${head}\n  ${luat}\n  BẢNG TRA (chép nguyên số, CẤM tự tính hay chế thêm dòng):\n${body
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n")}`;

  // Bảng BUỔI LẺ luôn có mặt: khách hỏi lộ trình thường hỏi kèm "1 buổi nhiêu", mà thiếu bảng là
  // bot chế số (bắt được ở DEDAT lượt 7: bịa "1 buổi 400 nghìn" trong khi bảng chỉ có 200/330).
  if (s.flow === "giai-co") {
    return bucket === "lieu-trinh"
      ? table(
          `⛔ Khách hỏi LỘ TRÌNH nhiều buổi → nêu ĐÚNG 1 liệu trình phù hợp nhất (ưu tiên VIP2 mười buổi) kèm 1 con số. CẤM đọc cả 3 liệu trình. Khách hỏi kèm "1 buổi bao nhiêu" thì lấy số ở bảng BUỔI LẺ, CẤM tự chế mức khác.`,
          `${GIAI_CO_LE}\n${GIAI_CO_LIEU_TRINH}`,
        )
      : table(
          `⛔ Báo giá 1 BUỔI làm mức tham chiếu, chép đúng số trong bảng. CẤM kể gói liệu trình 10 buổi khi khách chưa hỏi lộ trình.`,
          GIAI_CO_LE,
        );
  }

  // ⚠ Bảng THẺ TẬP luôn được bơm, kể cả khi classifier đoán nhóm giá khác. Bơm-theo-nhóm mà
  // thiếu lưới này thì đoán sai nhóm = bot không thấy số nào = BỊA số (bắt được ở NHOICAU: khách
  // hỏi "gói tháng nhiêu tiền", classifier trả "ve-boi-le", bot chế "gói bơi 12 tháng 1 triệu").
  const rows: string[] = [];
  let luat = LUAT_MOT_MOC;
  switch (s.doiTuong) {
    case "hoc-sinh-sinh-vien":
      // ⚠ Trước cho đọc cả 4 mốc "cho khách thấy trọn ưu đãi" → tin dài quá hạn mức văn phong,
      // hệ thống cắt phần cuối và NUỐT SẠCH bảng giá: khách hỏi giá mà nhận lại tin không có số
      // nào (bắt được ở smoke prod 23/07: 447 → 149 ký tự). Nên HS/SV cũng theo luật 1 mốc.
      // ⚠ Khách HS/SV hỏi giá RIÊNG một môn ("thế gói yoga nhiêu") mà chỉ nhận lại đúng con số
      // thẻ FULL vừa báo thì đọc như bot né câu hỏi (YOGA lượt 10) → phải NÓI RÕ lý do.
      luat = `⚠ Khách là HỌC SINH/SINH VIÊN → CHỈ tồn tại DUY NHẤT thẻ FULL HS/SV dưới đây, ⛔ KHÔNG có "giá gym riêng cho HS/SV", CẤM lấy giá gói thường rồi gắn nhãn HS/SV (báo sai giá). Khách hỏi giá RIÊNG một bộ môn thì nói thẳng 1 vế rằng ưu đãi HS/SV chỉ áp cho thẻ FULL dùng cả 4 dịch vụ, không tách lẻ từng môn, rồi mới nêu con số — đừng lặp lại con số cũ mà không giải thích. ${LUAT_MOT_MOC}`;
      rows.push(render([FULL_HSSV]));
      break;
    case "giao-vien":
      luat = `⚠ Khách là GIÁO VIÊN → dùng bảng giáo viên dưới đây. ${LUAT_MOT_MOC}`;
      rows.push(render([FULL_GV]));
      break;
    case "gia-dinh":
      luat = `⚠ Khách đăng ký CHO CẢ NHÀ → dùng bảng gia đình dưới đây.`;
      rows.push(GIA_DINH);
      break;
    case "doanh-nghiep":
      luat = `⚠ Khách là DOANH NGHIỆP/công ty → KHÔNG có bảng giá cố định cho đoàn: nói bên em có ưu đãi riêng rồi xin SĐT để sale báo lại, TUYỆT ĐỐI không tự chế số. Chỉ dùng bảng dưới nếu khách hỏi giá lẻ cho 1 người.`;
      rows.push(tableForSport(s.boMon));
      break;
    default:
      rows.push(tableForSport(s.boMon));
  }
  if (bucket === "hoc-boi") {
    // Khách hỏi HỌC BƠI: ĐƯA bảng KHOÁ HỌC lên ĐẦU làm câu trả lời chính; bảng thẻ bơi tháng
    // vẫn giữ lại (phòng khi khách rẽ sang hỏi thẻ) nhưng HẠ xuống dưới + DÁN NHÃN rõ để 12B
    // không neo nhầm thẻ (bắt được: "giá học bơi cháu 10t" → bot báo thẻ trẻ em 12 tháng 3.6 triệu).
    const theBoiThang = rows.join("\n");
    rows.length = 0;
    rows.push(BANG_KHAC["hoc-boi"]);
    if (theBoiThang) {
      rows.push(
        `─ (Tham chiếu THẺ BƠI THÁNG — bơi tự do, KHÔNG phải giá HỌC BƠI; CHỈ nêu khi khách hỏi RIÊNG vé/thẻ bơi theo tháng):\n${theBoiThang}`,
      );
    }
    luat = `⚠ Khách hỏi HỌC BƠI (học cho tới khi BIẾT bơi) → con số trả lời phải lấy từ bảng KHOÁ HỌC BƠI (lớp nhóm 12 buổi 1.5 triệu / 1 kèm 1 giá 3 triệu...). ⛔ KHÔNG lấy giá THẺ BƠI theo tháng làm câu trả lời chính — dù khách hỏi cho BÉ/CHÁU, dù khách nói "gói trẻ em" / "gói cho bé" / "khoá trẻ em" thì con số VẪN là KHOÁ HỌC (lớp nhóm 1.5 triệu, 1 kèm 1 3 triệu), TUYỆT ĐỐI KHÔNG báo thẻ bơi trẻ em 12 tháng 3.6 triệu, KHÔNG báo thẻ bơi người lớn 4.5 triệu — mấy con số 3.6/4.5 triệu ở bảng THAM CHIẾU bên dưới CHỈ dùng khi khách hỏi RIÊNG thẻ bơi tự do theo tháng, KHÔNG phải câu trả lời cho người đang hỏi HỌC bơi. ${luat}`;
  } else if (bucket && bucket !== "the-tap") {
    rows.push(BANG_KHAC[bucket as Exclude<PriceBucket, "" | "the-tap" | "lieu-trinh">]);
  }
  return table(luat, rows.join("\n"));
}

/**
 * Ghi chú giá thường trú trong system prompt — CHỈ vài dòng dễ lẫn nhất, không phải cả bảng
 * (cả bảng đã bơm đúng lúc qua buildPriceDirective).
 */
export const PRICE_NOTE_FITNESS = `GIÁ: mỗi lần báo chỉ nêu 1 gói + 1 mốc thời hạn hợp nhu cầu, KHÔNG đọc cả dãy. Số cụ thể hệ thống bơm sẵn vào khối [BỐI CẢNH TIN NÀY] đúng lượt khách hỏi — chưa thấy số thì TUYỆT ĐỐI không tự chế, cứ nói "cái này để em xác nhận lại rồi báo mình chính xác ạ".
⚠ Hay lẫn dòng: Gym 12 tháng = 4.5 triệu, còn 7 triệu là FULL 12 tháng; Gym 6 tháng = 2.5 triệu, còn 3.8 triệu là FULL 6 tháng. Học sinh - sinh viên CHỈ có thẻ FULL HS/SV, KHÔNG có "giá gym riêng cho HS/SV".`;

export const PRICE_NOTE_GIAI_CO = `GIÁ: khách hỏi giá → báo giá 1 BUỔI làm mức tham chiếu (không đổ cả bảng liệu trình); liệu trình nhiều buổi chỉ nêu khi khách chủ động hỏi lộ trình. Ưu tiên chốt liệu trình VIP2 mười buổi. Số cụ thể hệ thống bơm sẵn vào khối [BỐI CẢNH TIN NÀY] đúng lượt khách hỏi — chưa thấy số thì TUYỆT ĐỐI không tự chế, cứ nói "cái này để em xác nhận lại rồi báo mình ạ".`;

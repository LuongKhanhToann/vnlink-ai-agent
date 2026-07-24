/**
 * classifier.ts — bộ phân loại mỗi lượt, chạy bằng chính gemma4:12b
 * (structured output qua tham số `format` của ollama /api/chatplus).
 *
 * Tương đương flowRouterAgent + tool recordLead bên 5.4 gộp làm một: mọi việc HIỂU khách
 * (xưng hô, hỏi giá, trì hoãn, đồng ý đến, an toàn, BỘ ẢNH nên gửi) và mọi SLOT ghi nhận
 * (bộ môn, mục tiêu, thể trạng, vùng đau, đối tượng...) là việc của model — FSM (state.ts)
 * chỉ chuyển trạng thái thuần code từ kết quả này. KHÔNG keyword/regex nghiệp vụ.
 *
 * v3 (2026-07-23) — đồng bộ 5.4:
 *   • `media`: bộ ảnh do CLASSIFIER quyết thẳng (cổng deterministic) thay vì để model reply
 *     tự ghi dòng "MEDIA: …". Bên 5.4 đã đổi vì model nhỏ hay BỎ NHỊP gửi ảnh; gemma 12B
 *     còn nhỏ hơn nên lý do càng đúng. Luật chọn bê từ prompt của flowRouterAgent.
 *   • Slot ghi dần (bo_mon/muc_tieu/the_trang/vung_dau/…): tương đương tool recordLead —
 *     có slot thì FSM bơm lại vào khối [ĐÃ BIẾT] mỗi lượt, bot hết hỏi lại cái khách vừa nói
 *     kể cả khi tin cũ đã trôi khỏi cửa sổ lịch sử.
 */

import type { ChatMsg } from "./llm";
import { PRICE_BUCKETS, type PriceBucket } from "./pricing";
import type { ConvState } from "./state";

/** 8 bộ ảnh + "none" — khớp KEY_TO_FOLDER (tools/media.ts) và MEDIA_KEYS bên brain.ts. */
export const MEDIA_KEYS = [
  "fitness-gym",
  "fitness-yoga",
  "fitness-zumba",
  "fitness-pool",
  "fitness-before-after-gain",
  "fitness-before-after-loss",
  "mr-neck-shoulder",
  "mr-sport",
  "mr-general",
] as const;
export type MediaKey = (typeof MEDIA_KEYS)[number];

/**
 * ⚠ ĐA SỐ trường là OPTIONAL: classifier chỉ xuất trường CÓ giá trị lượt này (luật "omit khi trống"
 * trong CLS_SYSTEM) để JSON ngắn → decode nhanh (~315→~70 token, xem [[gemma-classify-latency]]).
 * Trường VẮNG = "không có tin mới" → `updateState` PHẢI hiểu là GIỮ giá trị cũ (slot sticky) hoặc
 * RESET false (cờ sự kiện, `!!undefined===false`). CHỈ 5 trường luôn `required` (buộc model quyết
 * mỗi lượt): flow, khach_hoi_gia, gia_hoi_ve, media, an_toan.
 */
export interface Classification {
  flow: "fitness" | "giai-co" | "chua-ro";
  khach_xung?: "anh" | "chi" | "chua-ro";
  ten_khach?: string;
  sdt?: string;
  doi_tuong?: "chua-ro" | "hoc-sinh-sinh-vien" | "giao-vien" | "gia-dinh" | "doanh-nghiep";
  bo_mon?: string;
  muc_tieu?: string;
  biet_boi?: "biet" | "chua-biet" | "chua-ro";
  the_trang?: string;
  vung_dau?: string;
  tinh_chat_dau?: string;
  thoi_gian_dau?: string;
  khach_ke_dau?: boolean;
  khach_hoi_thong_tin?: boolean;
  khach_hoi_gia: boolean;
  gia_hoi_ve: PriceBucket;
  khach_che_dat?: boolean;
  khach_tri_hoan?: boolean;
  khach_dong_y_den?: boolean;
  gio_hen?: string;
  khung_ngay?: "" | "cuoi-tuan" | "dau-tuan-sau" | "tuan-sau" | "trong-tuan";
  ngay_hen?: string;
  ngay_hen_chuan?:
    | ""
    | "hom-nay"
    | "ngay-mai"
    | "thu-2"
    | "thu-3"
    | "thu-4"
    | "thu-5"
    | "thu-6"
    | "thu-7"
    | "chu-nhat";
  khach_hoi_ngoai_pham_vi?: boolean;
  /** Khách đòi thôi chat, muốn gặp/nói chuyện với người thật hoặc muốn được gọi điện. */
  khach_doi_nguoi_that?: boolean;
  an_toan: "khong" | "bau" | "sau-sinh" | "benh-nen" | "cap-tinh";
  media: MediaKey | "none";
  bot_truoc_moi_thu?: boolean;
}

export const CLS_SCHEMA = {
  type: "object",
  properties: {
    flow: { type: "string", enum: ["fitness", "giai-co", "chua-ro"] },
    khach_xung: { type: "string", enum: ["anh", "chi", "chua-ro"] },
    ten_khach: { type: "string" },
    sdt: { type: "string" },
    doi_tuong: {
      type: "string",
      enum: ["chua-ro", "hoc-sinh-sinh-vien", "giao-vien", "gia-dinh", "doanh-nghiep"],
    },
    bo_mon: { type: "string" },
    muc_tieu: { type: "string" },
    biet_boi: { type: "string", enum: ["biet", "chua-biet", "chua-ro"] },
    the_trang: { type: "string" },
    vung_dau: { type: "string" },
    tinh_chat_dau: { type: "string" },
    thoi_gian_dau: { type: "string" },
    khach_ke_dau: { type: "boolean" },
    khach_hoi_thong_tin: { type: "boolean" },
    khach_hoi_gia: { type: "boolean" },
    gia_hoi_ve: { type: "string", enum: PRICE_BUCKETS },
    khach_che_dat: { type: "boolean" },
    khach_tri_hoan: { type: "boolean" },
    khach_dong_y_den: { type: "boolean" },
    gio_hen: { type: "string" },
    khung_ngay: {
      type: "string",
      enum: ["", "cuoi-tuan", "dau-tuan-sau", "tuan-sau", "trong-tuan"],
    },
    ngay_hen: { type: "string" },
    ngay_hen_chuan: {
      type: "string",
      enum: ["", "hom-nay", "ngay-mai", "thu-2", "thu-3", "thu-4", "thu-5", "thu-6", "thu-7", "chu-nhat"],
    },
    khach_hoi_ngoai_pham_vi: { type: "boolean" },
    khach_doi_nguoi_that: { type: "boolean" },
    an_toan: { type: "string", enum: ["khong", "bau", "sau-sinh", "benh-nen", "cap-tinh"] },
    media: { type: "string", enum: [...MEDIA_KEYS, "none"] },
    bot_truoc_moi_thu: { type: "boolean" },
  },
  // ⚠ Required TỐI THIỂU (buộc model quyết mỗi lượt) → JSON ngắn, decode nhanh. Các trường khác model
  // chỉ xuất khi CÓ giá trị (luật "omit khi trống" ở CLS_SYSTEM); vắng = giữ cũ / reset false.
  // 8 trường required = mọi thứ mà 1 lần BỎ SÓT là khách THẤY LỖI ngay (không thể chờ sticky bù):
  //   • bo_mon + doi_tuong → CHỌN BẢNG GIÁ (buildPriceDirective); lean bỏ đi → bucket the-tap/ve-boi-le
  //     rơi về bảng FULL → báo sai giá ("vé tháng bể bơi" → "Full 800k" thay vì bơi 700k).
  //   • khach_xung → xưng hô. Sticky-omit làm model KHÔNG buồn xuất field lúc CÓ bằng chứng mới
  //     ("A học" → anh) → xưng kẹt ở chua-ro, bot gọi "anh/chị" cả cuộc dù khách đã tự xưng. Enum có
  //     "chua-ro" làm mặc định an toàn nên required KHÔNG gây bịa (validate LIVE: 0 lần đoán bừa giới).
  // ⚠ muc_tieu ĐÃ THỬ required rồi BỎ: nó là chuỗi tự do, khi khách CHƯA nêu mục tiêu ("mình muốn tập
  //   gym", "vé tháng bơi") required ép model BỊA "giu-dang"/"hoc-boi" → bot khẳng định sai "mục tiêu
  //   của mình là giữ dáng" (đo LIVE con 27700/27137). Để OPTIONAL: khách nêu mục tiêu rõ (giảm cân…)
  //   thì model vẫn xuất (đã đủ cho hướng ảnh before/after); không nêu thì BỎ, không bịa.
  // ⛔ ĐỪNG thêm field khác mà không cân: mỗi field ~10 token decode. Field event/ngày-giờ giữ optional
  //   (chỉ xuất khi khách nhắc) — validate LIVE luồng chốt lịch: ngày/giờ bắt đúng ("mai"→thứ Bảy 25/07).
  required: ["flow", "khach_xung", "bo_mon", "doi_tuong", "khach_hoi_gia", "gia_hoi_ve", "an_toan", "media"],
} as const;

const CLS_SYSTEM = `Bạn là bộ PHÂN LOẠI cho chatbot tư vấn 2 trung tâm: Fami (tập gym/yoga/zumba/bơi) và Hoa Sen (giải cơ trị đau mỏi cơ xương khớp). Đọc TRẠNG THÁI ĐÃ BIẾT + TIN BOT TRƯỚC ĐÓ + TIN KHÁCH MỚI rồi trả về DUY NHẤT một JSON đúng schema, không thêm chữ nào. MỌI trường đều quan trọng như nhau — đừng dồn chú ý vào vài trường đầu rồi trả bừa các trường sau.
⚡ JSON NGẮN GỌN: CHỈ xuất trường mà TIN KHÁCH MỚI cho giá trị THẬT ở lượt này. Trường KHÔNG có thông tin mới thì BỎ HẲN khỏi JSON — ĐỪNG ghi "", đừng ghi false thừa, đừng ghi "chưa rõ"/"không rõ"/"-"/"null". Hệ thống tự giữ giá trị cũ cho trường bạn bỏ qua. 8 trường LUÔN phải có (kể cả khi giữ giá trị cũ): flow, khach_xung, bo_mon, doi_tuong, khach_hoi_gia, gia_hoi_ve, an_toan, media. Với 4 trường STICKY này — khach_xung, bo_mon, doi_tuong (và flow) — nếu tin mới KHÔNG đổi thì LẶP LẠI ĐÚNG giá trị đang có trong TRẠNG THÁI ĐÃ BIẾT (chúng chọn bảng giá / xưng hô, bỏ sót hay đổi bừa là khách thấy lỗi ngay); chỉ đổi khi tin mới có bằng chứng THẬT. Cờ boolean chỉ nêu khi = true (đúng sự việc lượt này); cờ không xảy ra thì BỎ, không ghi false. Slot chuỗi khác (muc_tieu, the_trang, vùng đau, tính chất/thời gian đau, ngày/giờ hẹn, ten_khach, sdt…) chỉ nêu khi tin mới thực sự nhắc tới; tin mới không nhắc thì BỎ (đừng nhắc lại giá trị cũ).

Cách điền từng trường:
- flow: khách đang cần gì Ở THỜI ĐIỂM NÀY. "fitness" = mọi nhu cầu TẬP (gym/yoga/zumba/bơi/pilates) và mọi MỤC TIÊU của việc tập — giảm cân, tăng cân, tăng cơ, giữ dáng, sức khoẻ, và cả THƯ GIÃN / xả stress. "giai-co" = khách ĐANG ĐAU MỎI cơ-xương-khớp và muốn TRỊ LIỆU cho hết đau (không phải để tập), hoặc hỏi thẳng dịch vụ giải cơ/massage/bấm huyệt. STICKY: tin mới không đổi chủ đề (tin mơ hồ, nối tiếp, cho tên-SĐT-giờ) → GIỮ giá trị trong trạng thái đã biết. Muốn "thư giãn" mà KHÔNG kèm đau = fitness. Không xác định được và trạng thái cũng chưa rõ → "chua-ro".
- khach_xung: XÉT BẰNG CHỨNG TRONG TIN KHÁCH MỚI TRƯỚC TIÊN — bằng chứng mới LUÔN THẮNG trạng thái cũ. Khách tự xưng "a"/"anh"/"mình là nam" → "anh" (kể cả trạng thái đang là chi). Tự xưng "c"/"chị"/"em là nữ"/tự kể mình bầu-sau sinh → "chi". Tin mới KHÔNG có bằng chứng giới → trả đúng giá trị trong trạng thái đã biết. Câu chào chung ("em ơi", "hi", "alo shop") KHÔNG phải bằng chứng; ⛔ CẤM đoán từ TÊN hay từ BỘ MÔN (yoga không có nghĩa là nữ, gym không có nghĩa là nam) — đoán sai giới là lỗi rất nặng.
  Khách tự xưng "e"/"em"/"mình" là xưng TRUNG TÍNH (cả nam lẫn nữ đều dùng) → KHÔNG phải bằng chứng giới → giữ giá trị trạng thái cũ.
  ⚠ VIẾT TẮT TRONG CHAT VIỆT là bằng chứng RẤT HAY GẶP, đừng bỏ sót: "a" = anh, "c" = chị, "e" = em (trung tính). Chỉ cần chữ cái đó đứng ở vị trí CHỦ NGỮ tự xưng của khách là đủ căn cứ.
  ⛔ CHỐNG BỊA GIỚI (lỗi nặng nhất): "a"/"c" CHỈ tính là xưng khi nó là MỘT TỪ RIÊNG khách dùng để TỰ XƯNG. Chữ "a"/"c"/"anh"/"chi" NẰM TRONG một từ khác thì KHÔNG phải xưng hô — ví dụ "chi phí bao nhiêu", "cho e xin chi tiết", "giá cả sao", "canh giờ qua", "nhanh không" chứa cụm "chi"/"anh"/"c" nhưng KHÔNG hề nói giới → giữ giá trị trạng thái cũ. Một chữ cái/token LẺ mơ hồ không ở vai chủ ngữ tự xưng ("M", "ok", "vg", "uk", tên viết tắt) cũng KHÔNG phải bằng chứng giới → giữ giá trị cũ. Khi lưỡng lự, LUÔN chọn giữ giá trị trạng thái cũ, TUYỆT ĐỐI không đoán liều.
  Ví dụ: "c muốn đi bơi cho khỏe" → "chi". "c hỏi giá với" → "chi". "a hay đau lưng" → "anh" (kể cả khi trạng thái đang là chi). "e là sinh viên" → "chua-ro" (xưng "e" không nói lên giới). "em ơi" / "shop ơi" → giữ giá trị trạng thái cũ. "chi phí 1 tháng bao nhiêu" → giữ giá trị cũ (KHÔNG suy ra "chi"). "M" / "ok e" → giữ giá trị cũ.
- ten_khach / sdt: CHỈ điền khi TIN MỚI cung cấp (vd "Hà 0912000111" → ten_khach "Hà", sdt "0912000111"); không có → "". Tin dạng "Tên + dãy số điện thoại" là khách CUNG CẤP TÊN — chữ đứng trước SĐT là TÊN RIÊNG kể cả khi trùng từ chỉ thời gian: "Mai 0906112233" → ten_khach "Mai" (KHÔNG phải "ngày mai"), "Bảy 09xx" → tên "Bảy"; các tin này ngay_hen/ngay_hen_chuan/gio_hen để "". MỘT KÍNH NGỮ đứng trơ (anh/chị/em/cô/chú/bạn) KHÔNG phải tên → "".
- doi_tuong: khách TỰ NÓI mình thuộc nhóm có bảng giá riêng: học sinh/sinh viên → "hoc-sinh-sinh-vien"; giáo viên → "giao-vien"; đăng ký cho cả nhà/2-3 người thân → "gia-dinh"; công ty/doanh nghiệp → "doanh-nghiep"; không nói gì → "chua-ro".
  ⛔ "hoc-sinh-sinh-vien" là thẻ dành cho NGƯỜI 14-22 TUỔI TỰ ĐI TẬP. Bố/mẹ hỏi cho CON NHỎ ("con em 6 tuổi học bơi", "bé nhà em") KHÔNG phải nhóm này → để "chua-ro" (hoặc "gia-dinh" nếu khách nói cả nhà cùng tập). Khách nêu TUỔI DƯỚI 14 ("13 tuổi tập gym được không") cũng KHÔNG phải nhóm này → "chua-ro"; gán nhầm là bot báo mức giá thẻ mà người đó chưa đủ tuổi mua.
  ⛔ Rủ BẠN BÈ / đồng nghiệp đi tập cùng KHÔNG phải "gia-dinh" — nhóm đó chỉ dành cho đăng ký CHO NGƯỜI NHÀ.
- bo_mon: bộ môn khách quan tâm, tin mới HOẶC giữ giá trị cũ nếu tin mới không đổi. CHỈ được dùng đúng 6 giá trị: gym/yoga/zumba/boi/pilates/full. Chưa rõ → "".
  ⛔ Khách hỏi môn trung tâm KHÔNG có (boxing, aerobic, crossfit, muay...) thì GIỮ NGUYÊN giá trị cũ, KHÔNG ghi tên môn đó vào — ghi vào là slot rác bám suốt cuộc và làm hệ thống tra nhầm bảng giá.
- muc_tieu: mục tiêu tập, dạng slug: giam-can/tang-can/tang-co/giu-dang/suc-khoe/thu-gian/hoc-boi. CHỈ điền khi khách NÓI mục tiêu CỦA MÌNH; khách hỏi công dụng của bộ môn ("tập yoga có giảm cân không") KHÔNG phải đổi mục tiêu → giữ giá trị cũ. Chưa rõ → "".
  ⛔ Khách MỚI chỉ nêu BỘ MÔN muốn tập ("mình muốn tập gym", "cho hỏi bơi", "quan tâm yoga") mà CHƯA nói LÀM GÌ với nó thì muc_tieu để TRỐNG — TUYỆT ĐỐI đừng suy ra "giu-dang"/"suc-khoe"/"giam-can"; gán bừa là bot khẳng định sai "mục tiêu của mình là giữ dáng" khiến khách khó chịu.
  ⛔ "hoc-boi" CHỈ khi khách muốn HỌC cho tới khi BIẾT bơi (chưa biết bơi, học kỹ thuật, học cho bé). Khách hỏi VÉ/THẺ bơi tự do theo THÁNG hay theo LƯỢT ("vé tháng bơi", "giá bơi 1 tháng", "vé bơi bao nhiêu") = đã biết bơi chỉ vào bơi → KHÔNG phải hoc-boi, để trống (hoặc suc-khoe nếu khách nói tập cho khoẻ).
- biet_boi: khách/bé ĐÃ biết bơi hay chưa (chỉ liên quan mạch BƠI). CHỈ đặt khi khách nói RÕ: "biết" khi khách xác nhận bơi được rồi ("mình biết bơi rồi", "bơi được rồi", "biết bơi cơ bản"); "chua-biet" khi khách nói chưa ("chưa biết", "chưa ạ", "chưa biết gì", "mới tập", "chưa bơi được", hoặc trả lời "chưa" cho câu 'đã biết bơi chưa'). ⛔ Ý ĐỊNH/NHU CẦU đi bơi KHÔNG phải bằng chứng: "muốn bơi", "định bơi", "tranh thủ bơi buổi trưa", "đi bơi cho khoẻ", "bơi giờ trưa được không", "xin giá bơi", "tư vấn khoá học bơi" đều KHÔNG cho biết khách có biết bơi hay không → khi đó BỎ TRỐNG (đừng đặt "biet"). Khách né/không trả lời câu 'đã biết bơi chưa' → BỎ TRỐNG. ⛔ KHẲNG ĐỊNH YẾU/MƠ HỒ KHÔNG đủ để đặt "biet": khách chỉ đáp "vg"/"vâng"/"ừ"/"ok"/"dạ"/"uh" cho câu hỏi biết-bơi (nhất là câu GHÉP kiểu "đã từng đi bơi HAY biết bơi chưa") thì KHÔNG rõ ý là biết hay chưa → BỎ TRỐNG, để bot hỏi lại cho chắc; chỉ đặt "biet" khi khách nói THỰC CHẤT là bơi được. Lưỡng lự LUÔN bỏ trống (hệ thống giữ "chua-ro" và sẽ cho bot hỏi lại).
- the_trang: chiều cao/cân nặng khách vừa nêu, NGUYÊN VĂN (vd "1m70 55kg", "nặng 78kg"). Không có → "" (đừng bịa, đừng suy).
- vung_dau: vùng đau khách nêu, dạng slug không dấu: vai-gay/co-vai-gay/lung/that-lung/chan/bap-chan/goi/toan-than. Không có → "".
- tinh_chat_dau: khách tả cơn đau ra sao, nguyên văn ngắn (vd "đau lan xuống cánh tay", "nhói 1 điểm khi quay cổ"). Không có → "".
- thoi_gian_dau: đau bao lâu rồi, nguyên văn — CHỈ khi khách nêu MỐC ĐO ĐƯỢC ("2 hôm nay", "mấy tuần rồi", "2 tháng nay", "từ hôm qua"). ⛔ Trạng từ mơ hồ KHÔNG tính là thời gian: "dạo này", "gần đây", "thời gian qua", "lâu rồi" → "".
  ⚠ 3 trường vùng đau / tính chất / thời gian: chỉ điền khi TIN MỚI có; tin mới không nhắc thì để "" (FSM tự giữ giá trị cũ, không cần bạn nhắc lại).
- khach_ke_dau: tin mới khách đang KỂ/THAN về tình trạng đau mỏi của chính mình ("hay đau cổ vai gáy", "cứng đơ cả lưng"). Hỏi thông tin dịch vụ/giá/tiện ích thì KHÔNG phải kể đau → false.
- khach_hoi_thong_tin: tin khách là câu HỎI về dịch vụ / cơ sở / chính sách / cách thức ("giải cơ là làm cái gì", "có HLV nữ không", "mấy giờ mở cửa", "bể có sạch không", "làm xong có đau không"). Khách KỂ tình trạng - nhu cầu của mình, chào hỏi, hay đang chốt lịch → false.
- khach_hoi_gia: tin mới có hỏi về giá/học phí/bao nhiêu tiền/gói rẻ hơn/ưu đãi không. Hỏi "có gói nào (cho hai mẹ con / cho nhóm / rẻ hơn...) không" cũng là hỏi giá → true. ⛔ Khách chỉ CHÊ mức giá vừa nghe mà không xin mức khác ("sao đắt thế", "đắt quá", "hơi cao so với anh nghĩ") → false, vì đó là khach_che_dat; lúc đó bot phải nói giá trị chứ không báo thêm số.
  ⛔ Khách mới NÊU NHU CẦU, chưa nhắc gì tới tiền ("muốn đăng ký tập gym", "c muốn tập yoga", "muốn đi bơi cho khỏe", "cho anh đăng ký với") → false. "Đăng ký" là ý định tham gia, KHÔNG phải câu hỏi giá — trả true ở đây làm bot xổ giá ngay tin đầu, sai nhịp phễu.
- gia_hoi_ve: khách đang hỏi giá của NHÓM dịch vụ nào — hệ thống dùng để bơm ĐÚNG mấy dòng bảng giá cần. khach_hoi_gia=false → "". Hỏi giá THẺ TẬP theo tháng — "bao nhiêu tiền 1 tháng", "gói tháng nhiêu tiền", "gói bơi/gym/yoga giá sao", "học phí 1 tháng" → "the-tap" (đây là MẶC ĐỊNH; không chắc thì chọn "the-tap"). Hỏi giá thuê PT kèm riêng/tập cùng HLV theo buổi → "pt-1-1". Hỏi học phí KHOÁ HỌC BƠI (học cho biết bơi, bao nhiêu buổi) → "hoc-boi". ⚠ Khi mạch đang là HỌC BƠI (khách nói "khóa học bơi", "học cho biết bơi", hoặc mục tiêu đang là hoc-boi, hoặc đang hỏi học bơi cho bé/cháu) rồi hỏi giá CHUNG chung ("giá sao vậy", "khóa học bao nhiêu tiền", "học phí thế nào") → "hoc-boi", ĐỪNG rơi về mặc định "the-tap" (báo giá thẻ tháng cho người muốn học bơi là lệch sản phẩm). ⚠⚠ CHỮ "KHÓA HỌC" / "LỚP HỌC" / "HỌC BƠI" trong tin khách LÀ tín hiệu HỌC BƠI — dù là TIN ĐẦU chưa có bộ môn ("khóa học bao nhiêu tiền", "tư vấn khóa học bơi") thì gia_hoi_ve = "hoc-boi", KHÔNG lấy mặc định "the-tap". ⚠⚠ Khi trạng thái đã cho thấy đây là KHÓA HỌC (biết bơi=chua-biet, HOẶC mục tiêu=hoc-boi, HOẶC lượt trước đã báo giá khóa học 1.5tr/3tr) thì các câu hỏi TIẾP về THỜI HẠN ("mấy tháng", "3 tháng", "học bao lâu"), TẦN SUẤT ("mỗi tuần mấy buổi", "tuần học mấy hôm") hay KHUYẾN MÃI/COMBO ("có km gì không", "combo có ưu đãi gì") VẪN giữ "hoc-boi" — TUYỆT ĐỐI ĐỪNG lật sang "the-tap". Người/bé CHƯA biết bơi thì sản phẩm đúng là KHOÁ HỌC (12 buổi 1.5tr/3tr), báo THẺ BƠI trẻ em 12 tháng 3.6 triệu cho họ là SAI SẢN PHẨM. ⛔ CỰC KỲ QUAN TRỌNG: trong mạch HỌC BƠI, khi khách hỏi về "1 kèm 1" / "1-1" / "kèm riêng" / "lớp nhóm" / "học nhóm mấy người" thì đó là các HÌNH THỨC của KHOÁ HỌC BƠI → vẫn "hoc-boi" (khoá bơi 1-1 = 3 triệu/12 buổi, lớp nhóm = 1.5 triệu), TUYỆT ĐỐI KHÔNG chọn "pt-1-1" (pt-1-1 là thuê PT tập GYM 20 buổi 6 triệu — báo số đó cho người học bơi là SAI SẢN PHẨM lẫn SAI GIÁ). Chỉ chọn "pt-1-1" khi mạch là tập GYM/tạ và khách hỏi thuê HLV kèm riêng. Hỏi vé bơi TỪNG LƯỢT / bơi TỰ DO theo lượt ("bơi 1 lượt bao nhiêu", "vé lẻ", "vé bơi tự do", "vào bơi 1 buổi") → "ve-boi-le" — ⛔ "gói tháng" KHÔNG phải vé lẻ. Hỏi giá Pilates → "pilates". Hỏi thuê HLV theo GIỜ → "thue-hlv". Bên GIẢI CƠ mà khách hỏi gói NHIỀU BUỔI / lộ trình / liệu trình → "lieu-trinh" (chỉ hỏi giá 1 buổi thì vẫn "the-tap").
- khach_che_dat: khách vừa CHÊ GIÁ CAO sau khi nghe báo giá ("sao đắt thế", "hơi cao", "đắt quá", "hơi đắt so với anh nghĩ"). ⛔ Khách hỏi THẲNG xin lựa chọn rẻ hơn ("có gói nào rẻ hơn không", "gói ngắn hơn thì sao") KHÔNG phải chê đắt → false (đó là hỏi giá, phải báo số cụ thể). Chưa nghe giá mà mới hỏi giá cũng false.
- khach_tri_hoan: khách hoãn quyết định: "để xem đã", "để tính đã", "khi nào rảnh thì qua", "từ từ đã"... ⛔ Khách nêu KHUNG THỜI GIAN sẽ đến ("chắc cuối tuần", "tuần sau em qua", "sáng mai nhé") là ĐANG CHỐT LỊCH, KHÔNG phải trì hoãn → false.
- khach_dong_y_den: khách tỏ ý MUỐN ĐẾN — đồng ý thử 1 buổi, hỏi lịch/cách đặt, tự nêu ngày-giờ muốn đến, hoặc đưa tên/SĐT để đặt. Khách CHỈ hỏi thông tin (địa chỉ, giờ mở cửa, chỗ đỗ xe, tiện ích, giá) = tò mò → false. Khách vừa ĐÁP một câu discovery (cho chiều cao-cân nặng, nói chưa tập bao giờ, tả cơn đau) KHÔNG phải đồng ý đến → false.
- gio_hen: CHỈ mốc GIỜ/BUỔI TRONG NGÀY, nguyên văn ("9h sáng", "buổi chiều", "sau 6h tối", "tối"). ⛔ Thứ và ngày KHÔNG thuộc trường này: "chủ nhật", "thứ 7", "mai", "cuối tuần" → để "" (chúng đi vào ngay_hen/khung_ngay). Không có → "".
- khung_ngay: khách nói KHUNG ngày MƠ HỒ (chưa phải 1 ngày cụ thể): "cuối tuần"/"weekend" → "cuoi-tuan"; "đầu tuần sau" → "dau-tuan-sau"; "tuần sau"/"tuần tới" → "tuan-sau"; "trong tuần"/"ngày thường" → "trong-tuan"; khách nói ngày cụ thể hoặc không nói gì về thời gian → "".
- ngay_hen: nguyên văn mốc NGÀY khách chốt sẽ đến ("thứ 7", "sáng chủ nhật", "mai"). Chưa chốt hoặc mơ hồ → "".
- ngay_hen_chuan: quy chuẩn của ngay_hen: "thứ 7"/"sáng thứ bảy" → "thu-7"; "chủ nhật" → "chu-nhat"; "mai" → "ngay-mai"; thứ 2..6 → "thu-2".."thu-6". "hom-nay" CHỈ khi khách nói RÕ muốn đến ngay hôm nay/bây giờ. Câu tương lai có điều kiện KHÔNG phải chốt ngày: "để đỡ sưng rồi a qua" → "", "hôm nào rảnh a ghé" → "". MƠ HỒ cũng để "": "cuối tuần" → "", "đầu tuần sau" → "", "tuần sau" → "".
- khach_doi_nguoi_that: khách muốn THOÁT khỏi chat để nói chuyện với người thật → true ("cho tôi nói chuyện với người thật đi", "gọi cho tôi đi", "có ai thật không", "chán nói chuyện với máy", "cho xin số hotline"). Khách chỉ chê cách tư vấn ("tư vấn như máy ấy") mà KHÔNG đòi gặp người → false.
- khach_hoi_ngoai_pham_vi: khách hỏi một dịch vụ HOÀN TOÀN NGOÀI lĩnh vực tập luyện & giải cơ (suất ăn eat-clean, giao đồ ăn, spa làm đẹp, gội đầu, thực phẩm chức năng...) → true. Các tiện ích/chính sách QUEN THUỘC của phòng tập — xông hơi, boxing, các lớp tập, trả góp, hoàn tiền, bán nước/đồ tập, trông trẻ, đỗ xe, tắm, điều hòa, HLV... → false (đã có đáp án trong kiến thức nền).
- an_toan: MẶC ĐỊNH LUÔN là "khong". CHỈ đổi sang giá trị khác khi TIN KHÁCH NÓI RÕ RÀNG về tình trạng sức khoẻ đó — tin cụt/mơ hồ/chào hỏi/không nhắc gì tới sức khoẻ ("A học", "alo", "tập gym cho khoẻ", "giá bao nhiêu") thì BẮT BUỘC "khong", ⛔ TUYỆT ĐỐI không suy diễn bầu/sau sinh/bệnh nền/chấn thương từ tin không hề đề cập. Cụ thể: khách (hoặc người sẽ tập) đang mang bầu → "bau"; sau sinh → "sau-sinh" (CHỈ khi khách NÓI RÕ mình mới sinh/đang cho con bú — việc CÓ con nhỏ, nhờ trông con KHÔNG phải sau sinh → "khong"); cao tuổi/bệnh nền → "benh-nen" (mọi BỆNH LÝ ĐÃ CÓ CHẨN ĐOÁN đều tính: huyết áp, tim mạch, tiểu đường, thoát vị đĩa đệm, thoái hoá cột sống, sau phẫu thuật — kể cả khi khách hỏi giọng bình thường); chấn thương MỚI dưới 72h đang sưng nóng → "cap-tinh" (lật cổ chân / bong gân hôm qua; "hôm qua với tay bê đồ giờ đau nhói, sưng lên"; ngã xe sáng nay — dấu hiệu nhận biết: mốc thời gian rất gần + có SƯNG hoặc đau nhói mới xuất hiện); không có → "khong".
- media: bộ ảnh hệ thống nên GỬI KÈM lượt này, hoặc "none". Ảnh là ĐÒN MỘT LẦN cho mỗi nhóm, bắn sớm 1 nhịp là mất luôn lúc cần nhất → khi lưỡng lự thì chọn "none". Chỉ chọn khác "none" khi tin khách rơi ĐÚNG 1 trong 2 ca:
  (a) Khách ĐANG HOÀI NGHI KẾT QUẢ và hỏi/thách thức về hiệu quả BÊN EM: "liệu có lên được thật không", "làm xong có đỡ thật không", "tập mãi không giảm thì sao", "ở đây khác gì", "sợ tập rồi lại như cũ".
  (b) Khách TÒ MÒ CƠ SỞ — HỎI VỀ chính nơi tập/thiết bị/không gian: "phòng gym có rộng không", "máy móc thế nào", "bể có sạch không", "không gian yoga thế nào".
  ⛔ PHÂN BIỆT (đây là chỗ hay sai nhất — các câu dưới đều là KỂ TÌNH TRẠNG, KHÔNG phải hoài nghi → "none"):
    · Khách tự ti / tả cơ thể: "người mỏng quá, vai lép", "bụng với đùi nhiều mỡ lắm" → "none".
    · Khách kể thất bại QUÁ KHỨ ở nơi khác: "trước nhịn ăn không xuống", "đi massage đỡ hôm trước hôm sau lại đau", "tự tập ở nhà mãi không lên" → "none" (đang kể chuyện, chưa hỏi về kết quả bên em).
    · Khách kể/than cơn đau, báo chấn thương → "none". Hỏi cảm giác lúc làm ("làm có đau không") → "none".
    · Khách mới KHAI nhu cầu ("muốn tập bơi", "bên mình có bể bơi không", "quan tâm yoga") → đó là discovery/hỏi có-hay-không, KHÔNG phải tò mò cơ sở → "none".
    · Khách hỏi CÔNG DỤNG / cách hoạt động của bộ môn ("tập yoga có giảm cân không", "zumba có giảm mỡ không", "giải cơ là làm cái gì") → hỏi thông tin → "none".
    · Chào hỏi, tin đầu, hỏi giá/địa chỉ/giờ/chính sách, chốt lịch, hỏi mang gì → "none".
  Chọn đúng bộ khi đã chắc: fitness + hoài nghi → LẤY THEO "mục tiêu" trong TRẠNG THÁI ĐÃ BIẾT (tăng cân/tăng cơ → "fitness-before-after-gain"; giảm cân/giảm mỡ → "fitness-before-after-loss") — CẤM chọn ngược chiều mục tiêu. fitness + tò mò cơ sở → "fitness-gym" / "fitness-pool" / "fitness-yoga" / "fitness-zumba" đúng môn khách đang hỏi. giai-co + hoài nghi → theo VÙNG ĐAU đã biết: cổ/vai/gáy → "mr-neck-shoulder"; chân/bắp chân/đầu gối/chấn thương thể thao → "mr-sport"; lưng/thắt lưng/toàn thân/chưa rõ → "mr-general".
- bot_truoc_moi_thu: TIN BOT TRƯỚC ĐÓ có lời mời trải nghiệm/tập thử/qua thử miễn phí không.`;

export function buildClassifierMessages(s: ConvState, prevBot: string, userMsg: string): ChatMsg[] {
  const known = [
    `flow=${s.flow}`,
    `khách xưng=${s.xung}`,
    `tên=${s.ten || "(chưa có)"}`,
    `sđt=${s.sdt || "(chưa có)"}`,
    `bộ môn=${s.boMon || "(chưa rõ)"}`,
    `mục tiêu=${s.mucTieu || "(chưa rõ)"}`,
    `biết bơi=${s.bietBoi}`,
    `vùng đau=${s.vungDau || "(chưa rõ)"}`,
    `bot đã mời thử=${s.trialInvited ? "rồi" : "chưa"}`,
    `khách đã tỏ ý đến=${s.wantsCome ? "rồi" : "chưa"}`,
    `ngày hẹn=${s.ngayChot || "(chưa có)"}`,
    `ảnh đã gửi=${s.mediaSent.length ? s.mediaSent.join(", ") : "(chưa gửi bộ nào)"}`,
  ].join(", ");
  return [
    { role: "system", content: CLS_SYSTEM },
    {
      role: "user",
      content: `TRẠNG THÁI ĐÃ BIẾT: ${known}\n\nTIN BOT TRƯỚC ĐÓ: ${prevBot || "(chưa có — đây là tin đầu cuộc)"}\n\nTIN KHÁCH MỚI: ${userMsg}`,
    },
  ];
}

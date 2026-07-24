/**
 * state.ts — FSM trạng thái hội thoại + builder khối [BỐI CẢNH TIN NÀY].
 *
 * Mô phỏng phần deterministic của bản 5.4 (brain.ts: buildKnownSummary + buildHeader +
 * cổng media + gate chốt đơn) cho gemma4:12b: mọi QUYẾT ĐỊNH chuyển trạng thái là code
 * thuần, nhưng mọi PHÂN LOẠI (khách xưng gì, có hỏi giá không, bộ ảnh nào...) đến từ
 * classifier LLM (classifier.ts) — không keyword/regex nghiệp vụ.
 *
 * v3 (2026-07-23): thêm SLOT ghi dần (bộ môn/mục tiêu/thể trạng/vùng đau/đối tượng...) →
 * khối [ĐÃ BIẾT] bơm lại mỗi lượt đúng như header động của 5.4, bot hết hỏi lại thứ khách
 * vừa nói kể cả khi tin cũ đã trôi khỏi cửa sổ lịch sử.
 */

import type { Classification } from "./classifier";
import { buildPriceDirective, type PriceBucket } from "./pricing";

export interface AskedQuestion {
  raw: string;
  norm: string;
}

export interface ConvState {
  flow: "fitness" | "giai-co" | "chua-ro";
  xung: "anh" | "chi" | "chua-ro";
  ten: string;
  sdt: string;
  doiTuong: "chua-ro" | "hoc-sinh-sinh-vien" | "giao-vien" | "gia-dinh" | "doanh-nghiep";
  // slot ghi dần (tương đương KnownInfo bên prod)
  boMon: string;
  mucTieu: string;
  bietBoi: "chua-ro" | "biet" | "chua-biet";
  theTrang: string;
  vungDau: string;
  tinhChatDau: string;
  thoiGianDau: string;
  gioHen: string;
  trialInvited: boolean;
  triHoan: boolean;
  wantsCome: boolean;
  ngayChot: string;
  closed: boolean;
  anToan: "khong" | "bau" | "sau-sinh" | "benh-nen" | "cap-tinh";
  mediaSent: string[];
  askedQuestions: AskedQuestion[];
  turnCount: number;
  /** Số lượt khách đã tỏ ý muốn đến mà VẪN chưa chốt được ngày (≥2 → đưa thẳng 2 ngày cụ thể). */
  wantsComeTurns: number;
  /** Số lượt khách đã KỂ về cơn đau (lượt đầu tiên LUÔN là nhịp discovery, chưa được giảng). */
  painTurns: number;
  // cờ theo lượt (ghi đè mỗi lượt)
  hoiGiaTurn: boolean;
  hoiThongTinTurn: boolean;
  cheDatTurn: boolean;
  keDauTurn: boolean;
  ngoaiPhamViTurn: boolean;
  /** Lượt này khách đòi gặp/nói chuyện với NGƯỜI THẬT → phải bàn giao, không giữ khách trong chat. */
  doiNguoiThatTurn: boolean;
  /** Lượt này khách đưa SĐT nhưng THIẾU SỐ → tin phải hỏi lại, tuyệt đối không xác nhận đã nhận. */
  sdtThieuSo: boolean;
}

export function newState(): ConvState {
  return {
    flow: "chua-ro",
    xung: "chua-ro",
    ten: "",
    sdt: "",
    doiTuong: "chua-ro",
    boMon: "",
    mucTieu: "",
    bietBoi: "chua-ro",
    theTrang: "",
    vungDau: "",
    tinhChatDau: "",
    thoiGianDau: "",
    gioHen: "",
    trialInvited: false,
    triHoan: false,
    wantsCome: false,
    ngayChot: "",
    closed: false,
    anToan: "khong",
    mediaSent: [],
    askedQuestions: [],
    turnCount: 0,
    wantsComeTurns: 0,
    painTurns: 0,
    hoiGiaTurn: false,
    hoiThongTinTurn: false,
    cheDatTurn: false,
    keDauTurn: false,
    ngoaiPhamViTurn: false,
    doiNguoiThatTurn: false,
    sdtThieuSo: false,
  };
}

/**
 * 12B thỉnh thoảng điền "chưa rõ"/"không có" thay vì để chuỗi rỗng → slot rác trôi vào khối
 * [ĐÃ BIẾT] ("vùng đau=chưa rõ") và vào Google Sheets. Đây là VÁ BƯỚC PARSE đầu ra của model
 * (đã dặn model để "" ở prompt), không phải phân loại nghiệp vụ bằng keyword.
 */
const PLACEHOLDERS = ["chưa rõ", "chua ro", "không rõ", "không có", "khong co", "chưa có", "n/a", "null", "-", "không", "khong"];
function isPlaceholder(v: string): boolean {
  return PLACEHOLDERS.includes(v.toLowerCase());
}

/**
 * SĐT phải ĐỦ SỐ mới được nhận. Khách hay gõ dở rồi gửi nhầm ("098", "0912345") — classifier
 * nhặt nguyên cụm đó, FSM cũ nhận luôn nên bot đáp "em nhận được số của mình rồi ạ" và mẩu rác
 * này trôi thẳng vào lead Google Sheets (bắt được ở LUNGTUNG lượt 3-4).
 * Đây là ĐẾM CHỮ SỐ — parse kỹ thuật thuần, không phán đoán ý khách.
 */
function digitsOf(v: string): string {
  let d = "";
  for (const ch of v) if (ch >= "0" && ch <= "9") d += ch;
  return d;
}
function isPhoneComplete(v: string): boolean {
  const d = digitsOf(v);
  return d.length >= 9 && d.length <= 12;
}

/**
 * Cập nhật state từ kết quả classifier — thuần code, không suy diễn thêm.
 * resolvedDayLabel: nhãn ngày CHÍNH XÁC do caller tính từ ngay_hen_chuan bằng Date thật
 * (vd "thứ Bảy 25/07"), "" nếu lượt này khách không chốt ngày cụ thể.
 */
export function updateState(s: ConvState, c: Classification, resolvedDayLabel: string): void {
  // ⚠ Classifier "lean": trường VẮNG (undefined) = không có tin mới → GIỮ giá trị cũ. Mọi phép đọc
  // dưới đây phải null-safe (?. / !! / kiểm truthy) — không được crash hay ghi undefined vào state.
  if (c.flow && c.flow !== "chua-ro") s.flow = c.flow;
  if (c.khach_xung && c.khach_xung !== "chua-ro") s.xung = c.khach_xung;
  const ten = c.ten_khach?.trim();
  if (ten) s.ten = ten;
  // ⚠ SĐT thiếu số thì KHÔNG ghi — và bật cờ để tin này hỏi lại khách cho đủ.
  s.sdtThieuSo = false;
  const sdt = c.sdt?.trim();
  if (sdt) {
    if (isPhoneComplete(sdt)) s.sdt = sdt;
    else s.sdtThieuSo = true;
  }
  if (c.doi_tuong && c.doi_tuong !== "chua-ro") s.doiTuong = c.doi_tuong;
  // slot: chỉ ghi đè khi lượt này khách THẬT SỰ cho giá trị mới (store-first cho tên/SĐT ở trên).
  // ⚠ Chống MẤT VẾ: 12B thỉnh thoảng nhắc lại slot cũ nhưng thiếu vế ("1m72 55kg" → "1m72").
  // Giá trị mới nằm GỌN TRONG giá trị cũ = bản rút gọn của chính nó → giữ bản đầy đủ.
  // (so chuỗi thuần, không phải phân loại nghiệp vụ)
  const set = (k: keyof ConvState, v: string | undefined) => {
    const val = (v ?? "").trim();
    if (!val || isPlaceholder(val)) return;
    const old = String((s as any)[k] ?? "").trim();
    if (old && old.toLowerCase().includes(val.toLowerCase())) return;
    (s as any)[k] = val;
  };
  set("boMon", c.bo_mon);
  set("mucTieu", c.muc_tieu);
  // biết bơi: enum sticky — KHÔNG dùng set() vì guard includes chặn nhầm "chua-biet"→"biet".
  // Chỉ cập nhật khi classifier có bằng chứng RÕ (biet/chua-biet); "chua-ro"/absent → giữ nguyên.
  if (c.biet_boi && c.biet_boi !== "chua-ro") s.bietBoi = c.biet_boi;
  set("theTrang", c.the_trang);
  set("vungDau", c.vung_dau);
  set("tinhChatDau", c.tinh_chat_dau);
  set("thoiGianDau", c.thoi_gian_dau);
  set("gioHen", c.gio_hen);
  if (c.bot_truoc_moi_thu) s.trialInvited = true;
  if (c.khach_dong_y_den) {
    s.wantsCome = true;
    s.triHoan = false;
  } else if (c.khach_tri_hoan) {
    s.triHoan = true;
  }
  if (c.an_toan && c.an_toan !== "khong") s.anToan = c.an_toan;
  // ⚠ Chốt ngày là dữ liệu ĐI VÀO ĐƠN → đòi 2 trường KHỚP NHAU mới nhận: nguyên văn khách nói
  // (ngay_hen) VÀ mã quy chuẩn (ngay_hen_chuan). Bắt được ca 12B tự bịa ngày: khách chỉ nói
  // "ừ qua thử" (không nêu ngày) mà classifier trả ngay_hen_chuan="ngay-mai" → bot xác nhận
  // "lịch hẹn thứ Sáu 24/07" cho một ngày khách chưa hề chọn.
  if (resolvedDayLabel && c.ngay_hen?.trim()) {
    // cấp tính đang sưng nóng → không nhận lịch hôm nay/mai (bot đang khuyên nghỉ 3-5 ngày)
    const capTinh = s.anToan === "cap-tinh";
    const quaSom = c.ngay_hen_chuan === "hom-nay" || c.ngay_hen_chuan === "ngay-mai";
    // lượt khách đưa SĐT là lượt cung cấp lead — không cho đổi ngày ĐÃ chốt
    // (chặn nhầm lẫn kiểu tên "Mai" bị đọc thành "ngày mai"). Giống freeze appointmentDate bên 5.4.
    const dangDuaLead = !!c.sdt?.trim() && !!s.ngayChot;
    if (!(capTinh && quaSom) && !dangDuaLead) s.ngayChot = resolvedDayLabel;
  }
  // Cờ SỰ KIỆN theo lượt: vắng (undefined) = không xảy ra → reset false (!!undefined === false).
  s.hoiGiaTurn = !!c.khach_hoi_gia;
  s.hoiThongTinTurn = !!c.khach_hoi_thong_tin;
  s.cheDatTurn = !!c.khach_che_dat;
  s.keDauTurn = !!c.khach_ke_dau;
  if (c.khach_ke_dau) s.painTurns += 1;
  s.ngoaiPhamViTurn = !!c.khach_hoi_ngoai_pham_vi;
  s.doiNguoiThatTurn = !!c.khach_doi_nguoi_that;
  s.turnCount += 1;
  // Đếm số lượt "muốn đến nhưng chưa có ngày": lượt thứ 2 trở đi là lúc phải ĐƯA 2 NGÀY cụ thể
  // (luật CHỐT LỊCH bước 2 của bản 5.4) — hỏi mở lần nữa là lặp câu hỏi, khách vẫn mơ hồ.
  s.wantsComeTurns = s.wantsCome && !s.ngayChot ? s.wantsComeTurns + 1 : 0;
}

const AN_TOAN_LABEL: Record<string, string> = {
  bau: "khách đang MANG BẦU",
  "sau-sinh": "khách SAU SINH",
  "benh-nen": "khách (hoặc người thân định tập) CAO TUỔI / CÓ BỆNH NỀN",
  "cap-tinh": "khách CHẤN THƯƠNG CẤP TÍNH dưới 72h (đang sưng nóng)",
};

/**
 * Lượt này có đang ở NHỊP DISCOVERY của giải cơ không (khách vừa kể đau, chưa đủ vùng đau +
 * thời gian đau) — lúc đó tin BẮT BUỘC chỉ là 1 câu đồng cảm + 1 câu hỏi.
 */
export function isGiaiCoDiscoveryGate(s: ConvState): boolean {
  return (
    s.flow === "giai-co" &&
    !s.closed &&
    !s.wantsCome &&
    s.anToan !== "cap-tinh" &&
    // khách đang HỎI (giá / thông tin / dịch vụ lạ) thì answer-first thắng, không ép nhịp hỏi lại
    !s.hoiGiaTurn &&
    !s.hoiThongTinTurn &&
    !s.ngoaiPhamViTurn &&
    // Lượt ĐẦU khách kể đau LUÔN là nhịp hỏi-hiểu, kể cả khi classifier đã nhặt đủ slot ngay
    // lượt đó (12B hay nhặt "dạo này" thành thời gian đau → tưởng đủ → nhảy sang giảng bài).
    (s.painTurns <= 1 || !s.vungDau || !s.thoiGianDau)
  );
}

/** Tóm tắt slot đã biết — bot không hỏi lại (tương đương buildKnownSummary bên 5.4). */
function buildKnownSummary(s: ConvState): string {
  const bits: string[] = [];
  const add = (label: string, v: string) => {
    if (v && v.trim()) bits.push(`${label}=${v.trim()}`);
  };
  add("tên", s.ten);
  add("SĐT", s.sdt);
  add("bộ môn", s.boMon);
  add("mục tiêu", s.mucTieu);
  add("thể trạng", s.theTrang);
  add("vùng đau", s.vungDau);
  add("tính chất đau", s.tinhChatDau);
  add("đau bao lâu", s.thoiGianDau);
  add("giờ hẹn", s.gioHen);
  add("ngày hẹn", s.ngayChot);
  if (s.doiTuong !== "chua-ro") bits.push(`đối tượng=${s.doiTuong}`);
  return bits.length ? `- ĐÃ BIẾT: ${bits.join(" · ")} — TUYỆT ĐỐI KHÔNG hỏi lại các mục này.` : "";
}

/**
 * Khối chỉ dẫn nội bộ bơm vào đầu tin khách — tương đương header động của brain.ts (5.4).
 * `mediaKey` = bộ ảnh hệ thống ĐÃ quyết đính kèm lượt này (null = không đính).
 */
export function buildTurnContext(
  s: ConvState,
  turn: {
    /** Bộ ảnh hệ thống ĐÃ quyết đính kèm lượt này (null = không đính). */
    mediaKey: string | null;
    /** 2 nhãn ngày CỤ THỂ do code tính sẵn (pipeline) cho bước "chọn 1 trong 2 ngày". */
    dayOptions?: string[];
    /** Nhóm giá khách đang hỏi (classifier quyết) — chọn đúng vài dòng bảng để bơm. */
    priceBucket?: PriceBucket;
  },
): string {
  const { mediaKey } = turn;
  const L: string[] = [];
  // Chấn thương cấp còn sưng → cấm mọi nhịp chốt lịch, kể cả khi khách vừa nói "để đỡ sưng a qua".
  const capTinhChuaChot = s.anToan === "cap-tinh" && !s.closed;
  const dayOptions = capTinhChuaChot ? [] : (turn.dayOptions ?? []);

  // ⛔ Nhịp DISCOVERY của giải cơ đặt LÊN ĐẦU: đây là luật hay bị model 12B lướt qua nhất
  // (nó nhảy thẳng vào giảng cơ chế + so massage ngay tin khách vừa than đau).
  const giaiCoDiscovery = isGiaiCoDiscoveryGate(s);
  if (giaiCoDiscovery) {
    const thieu = [
      !s.vungDau ? "đau ở đâu / lan hay 1 điểm" : "",
      !s.thoiGianDau ? "đau bao lâu rồi / có phải ngồi-đứng nhiều không" : "",
    ]
      .filter(Boolean)
      .join("; ");
    L.push(
      `- ⛔⛔ TIN NÀY CHỈ ĐƯỢC 2 CÂU: 1 câu đồng cảm ngắn với cơn khó chịu + 1 câu hỏi để hiểu thêm (còn thiếu: ${thieu}). TUYỆT ĐỐI CẤM trong tin này: giảng cơ chế "cơ co cứng/nút thắt/bó cứng", so sánh với massage thường, khoe KTV, mời trải nghiệm, nhắc giá. Khách mới kể đau thì việc của em là HỎI, không phải giảng.`,
    );
  }

  // ⛔ 2 NGÀY CỤ THỂ cũng đặt LÊN ĐẦU: code đã tính sẵn, model chỉ việc chép. Đặt ở cuối khối thì
  // luật "cấm lặp câu hỏi cũ" thắng và 12B tự đẩy cửa sổ ngày đi (GYM 23/07: khách nói "cuối tuần"
  // mà bot chào "Chủ nhật 26/07 hoặc thứ Hai 27/07" — thứ Hai không phải cuối tuần).
  if (dayOptions.length >= 2) {
    L.push(
      `- ⛔⛔ TIN NÀY đưa khách chọn ĐÚNG 2 ngày sau, chép NGUYÊN VĂN: "${dayOptions[0]}" hoặc "${dayOptions[1]}". CẤM tự tính, CẤM đổi sang ngày khác — kể cả khi lượt trước em đã nêu 2 ngày khác thì lượt này vẫn phải dùng đúng 2 ngày này (luật chống lặp câu hỏi KHÔNG áp dụng cho 2 ngày này). CHƯA xin tên/SĐT ở tin này.`,
    );
  }

  // ⛔ SĐT GÕ DỞ cũng phải đứng ĐẦU. Đặt ở giữa khối thì nhánh "đã có ngày → xin tên và SĐT"
  // phía dưới lấn át: đo được ở LUNGTUNG lượt 4 — classifier nhặt đúng "0912345", cờ đã bật,
  // mà bot vẫn đáp "em đã nhận được số điện thoại của mình rồi ạ".
  if (s.sdtThieuSo) {
    L.push(
      `- ⛔⛔ TIN NÀY: khách vừa gửi SỐ ĐIỆN THOẠI THIẾU SỐ (gõ dở / gửi nhầm) → việc DUY NHẤT của tin này là xin lại số cho đủ. TUYỆT ĐỐI CẤM nói "em đã nhận được số của mình rồi", CẤM nói đã lưu / đã cập nhật / đã giữ chỗ. Mẫu: "Dạ số của mình hình như còn thiếu vài số, anh/chị gửi lại giúp em số đầy đủ với ạ".`,
    );
  }

  // ⛔ Khách đòi gặp NGƯỜI THẬT: dặn trong system prompt không ăn thua (đo ở HON lượt 4 cả 2
  // vòng — bot vẫn mở bằng đúng câu bị cấm "em vẫn đang trực tiếp nhắn tin"). Đưa thành chỉ thị
  // theo LƯỢT, đặt đầu khối, kèm câu mẫu để chép.
  if (s.doiNguoiThatTurn && !s.closed) {
    L.push(
      `- ⛔⛔ TIN NÀY: khách ĐÒI GẶP NGƯỜI THẬT → đồng ý NGAY và bàn giao. TUYỆT ĐỐI CẤM mở đầu bằng "em vẫn đang trực tiếp nhắn tin/hỗ trợ mình đây", CẤM giữ khách lại trong chat. Chép gần nguyên văn: "Dạ được ạ, ${s.sdt ? "em xin phép gọi lại cho mình trong ít phút nữa nhé ạ" : "anh/chị cho em xin số điện thoại để bên em gọi lại tư vấn trực tiếp cho mình ạ"}".`,
    );
  }

  // ⛔ AN TOÀN cũng đặt LÊN ĐẦU: để ở giữa khối thì 12B bỏ qua vế "hỏi ý bác sĩ" khoảng 2/3 số
  // lượt (đo ở YTE 24/07 — ca thoát vị và ca "khỏi cần đi viện đúng không" đều mất vế này).
  if (s.anToan === "cap-tinh") {
    L.push(
      `- ⚠⚠ AN TOÀN: ${AN_TOAN_LABEL[s.anToan]} → tin này KHUYÊN khách NGHỈ 3-5 ngày, chườm đá, hạn chế đi lại, đi khám nếu sưng nặng hơn hoặc tê bì; nói rõ hết sưng mới nên qua để KTV đánh giá. ⛔ TUYỆT ĐỐI KHÔNG mời làm giải cơ lúc này, KHÔNG nói "KTV sẽ điều chỉnh kỹ thuật cho vùng đang viêm" (nghe như làm được ngay), KHÔNG pitch gói, KHÔNG hỏi ngày giờ.`,
    );
  } else if (s.anToan !== "khong") {
    L.push(
      `- ⚠⚠ AN TOÀN: ${AN_TOAN_LABEL[s.anToan]} → tin này BẮT BUỘC có 1 vế khuyên khách hỏi ý BÁC SĨ, chép gần nguyên văn: "anh/chị nhớ tham khảo ý kiến bác sĩ hoặc mang theo giấy khám sức khỏe trước khi tập để bên em hỗ trợ an toàn nhất ạ" — thiếu vế này là tin HỎNG — kể cả khi lượt trước đã dặn về một tình trạng khác thì tình trạng đang hỏi vẫn phải có vế này. Kèm ý HLV-KTV sẽ điều chỉnh theo thể trạng. ⛔ CẤM khẳng định trống "tập được bình thường", CẤM hứa chữa khỏi bệnh, CẤM xác nhận khách "khỏi cần đi khám / khỏi cần đi viện" — bệnh đã có chẩn đoán thì vẫn phải theo dõi ở cơ sở y tế. KHÔNG pitch gói, KHÔNG giục chốt lịch trong tin này.`,
    );
  }

  const known = buildKnownSummary(s);
  if (known) L.push(known);

  // ── TÌNH TRẠNG BIẾT BƠI (chỉ mạch bơi) — biến suy-diễn-lúc-sinh thành chỉ-thị-state ──
  // Prior của 12B rất mạnh: "định/tranh thủ bơi" → nó tự khẳng định "đã biết bơi rồi" dù khách
  // chưa hề xác nhận (đo 24/07: ca 27137/26458). Đặt directive RÕ ngay trong khối state để đè.
  const mchBoi = s.boMon.includes("bơi") || s.boMon.includes("boi") || s.mucTieu === "hoc-boi";
  if (mchBoi) {
    if (s.bietBoi === "biet") {
      L.push(`- BIẾT BƠI: khách ĐÃ biết bơi (khách tự xác nhận) → tư vấn nâng cao/kỹ thuật/duy trì thể lực, KHÔNG rủ "học từ đầu", KHÔNG hỏi lại đã biết bơi chưa.`);
    } else if (s.bietBoi === "chua-biet") {
      L.push(`- BIẾT BƠI: khách CHƯA biết bơi (khách tự xác nhận) → trấn an người mới, tư vấn KHOÁ HỌC từ đầu, KHÔNG nói ngược "đã biết bơi rồi", KHÔNG hỏi lại.`);
    } else {
      L.push(`- ⛔ CHƯA RÕ khách có biết bơi hay không (khách CHƯA nói rõ). Ý ĐỊNH đi bơi ("định/tranh thủ bơi trưa", "muốn bơi cho khoẻ", "xin giá bơi") KHÔNG phải bằng chứng biết bơi. TUYỆT ĐỐI CẤM mở đầu "vì mình/chị/anh đã biết bơi rồi nên…" hoặc "vì mình chưa biết bơi nên…". Nếu cần định hướng lộ trình thì HỎI nhẹ 1 câu ("chị đã bơi được chưa hay muốn bên em kèm từ đầu ạ"); còn lại cứ trả lời đúng phần khách hỏi.`);
    }
  }

  // xưng hô
  if (s.xung === "chi") {
    L.push(`- Khách là CHỊ${s.ten ? ` (chị ${s.ten})` : ""} — gọi "chị" trong MỌI câu. CẤM gọi "anh", CẤM "anh/chị".`);
  } else if (s.xung === "anh") {
    L.push(`- Khách là ANH${s.ten ? ` (anh ${s.ten})` : ""} — gọi "anh" trong MỌI câu. CẤM gọi "chị", CẤM "anh/chị".`);
  } else {
    L.push(`- Chưa rõ khách là anh hay chị → dùng "anh/chị" (hoặc "mình" nếu khách tự xưng "mình"), để ý cách khách tự xưng. CẤM đoán giới từ tên hay bộ môn.`);
  }

  // flow
  if (s.flow === "giai-co") {
    L.push(`- Nhu cầu hiện tại: GIẢI CƠ → tư vấn bên HOA SEN (giá/địa chỉ/tiện ích Hoa Sen, không lẫn sang Fami).`);
  } else if (s.flow === "fitness") {
    L.push(`- Nhu cầu hiện tại: TẬP LUYỆN → tư vấn bên FAMI (giá/địa chỉ/tiện ích Fami, không lẫn sang Hoa Sen).`);
  }

  // mở đầu vs tin tiếp theo
  if (s.turnCount <= 1) {
    L.push(
      s.hoiGiaTurn || s.ngoaiPhamViTurn
        ? `- Đây là TIN ĐẦU của cuộc: chào 1 câu NGẮN ("Dạ em chào anh/chị…" — CẤM viết "em chào mình") rồi TRẢ LỜI NGAY, ĐỦ MỌI Ý khách vừa hỏi trong tin này, xong mới hỏi lại 1 câu. ⛔ CẤM né câu hỏi bằng câu discovery ("mình quan tâm bộ môn nào").`
        : `- Đây là TIN ĐẦU của cuộc: chào 1 nhịp lễ phép, ẤM ("Dạ em chào anh/chị…" — CẤM viết "em chào mình") rồi dẫn tiếp bằng ĐÚNG 1 câu hỏi. ⛔ Tin này KHÔNG khoe đặc điểm cơ sở/số liệu/gói/giá của bất kỳ môn nào, KHÔNG hỏi giờ, KHÔNG mời thử.`,
    );
  } else {
    L.push(`- KHÔNG lặp lại cụm chào mở đầu nữa (chỉ tin đầu mới chào).`);
  }

  // nhịp EVALUATION của giải cơ (nhánh DISCOVERY đã đặt lên đầu khối)
  if (s.flow === "giai-co" && !s.closed && s.keDauTurn && s.vungDau && s.thoiGianDau && !s.trialInvited) {
    L.push(
      `- Khách đã kể đủ vùng đau + thời gian → tin này giải thích NGẮN (lời đời thường) cách giải cơ xử đúng chỗ cơ co cứng + mời TRẢI NGHIỆM 1 buổi để KTV đánh giá trực tiếp. Không nhắc giá nếu khách chưa hỏi.`,
    );
  }

  // giai đoạn chốt
  if (s.closed) {
    L.push(
      `- ĐÃ CHỐT LỊCH XONG (${s.ngayChot}${s.gioHen ? ` ${s.gioHen}` : ""}${s.ten ? `, ${s.xung === "chi" ? "chị" : "anh"} ${s.ten}` : ""}${s.sdt ? `, ${s.sdt}` : ""}) → chế độ CHĂM KHÁCH QUEN: trả lời answer-first đúng điều khách hỏi, KHÔNG xin lại tên/SĐT/giờ, KHÔNG nhắc lại "giữ chỗ", KHÔNG pitch lại gói đã chốt. Khách muốn đặt THÊM (môn/buổi/người khác) thì vui vẻ hỏi gọn info còn thiếu.`,
    );
  } else if (s.ngayChot && s.ten && s.sdt) {
    L.push(
      `- Đã đủ ngày hẹn (${s.ngayChot}) + tên (${s.ten}) + SĐT (${s.sdt}) → tin này CHỈ xác nhận giữ chỗ 1 câu ngắn rồi DỪNG. Không hỏi thêm bất cứ gì, KHÔNG gợi đặt cọc/chuyển khoản.`,
    );
  } else if (s.ngayChot && s.wantsCome) {
    L.push(
      `- Khách đã chốt ngày: ${s.ngayChot} — khi nhắc ngày phải dùng ĐÚNG chuỗi này, không tự tính lại. Tin này xác nhận ngắn + xin TÊN và SĐT (gộp trong 1 câu) để giữ chỗ. KHÔNG hỏi lại ngày.`,
    );
  } else if (s.wantsCome) {
    // Lượt ĐẦU khách ngỏ ý đến → hỏi mở. Từ lượt 2 (hoặc khi khách nói khung mơ hồ) → 2 ngày CỤ
    // THỂ do code tính sẵn; dòng đó đã nằm ở ĐẦU khối nên ở đây chỉ còn nhánh hỏi mở.
    if (capTinhChuaChot) {
      L.push(
        `- Khách nói sẽ qua KHI ĐỠ SƯNG → ⛔ CẤM hỏi ngày/giờ cụ thể lúc này. Chỉ chúc mau khỏi và dặn khi hết sưng thì nhắn lại để em xếp lịch.`,
      );
    } else if (!dayOptions.length) {
      L.push(
        `- Khách đã TỎ Ý muốn đến nhưng CHƯA chốt được ngày cụ thể → hỏi mở "anh/chị tiện qua hôm nào ạ". CHƯA xin tên/SĐT ở tin này.`,
      );
    }
  } else if (s.triHoan) {
    L.push(
      s.trialInvited
        ? `- Khách đang muốn SUY NGHĨ THÊM → KHÔNG hỏi ngày giờ, KHÔNG xin SĐT, KHÔNG lặp lại lời mời đã nói. Đáp ngắn 1-2 câu, giữ ấm, hạ áp lực, để ngỏ cửa.`
        : `- Khách đang muốn SUY NGHĨ THÊM → KHÔNG hỏi ngày giờ, KHÔNG xin SĐT, KHÔNG nài. Đáp ngắn: hạ áp lực ("dạ chưa cần quyết gì đâu ạ") + mời NHẸ 1 câu ghé trải nghiệm miễn phí cho biết, rồi để ngỏ.`,
    );
  } else {
    L.push(
      `- Khách CHƯA tỏ ý muốn đến → CẤM hỏi "qua hôm nào / mấy giờ / sáng hay chiều", CẤM gắn đuôi hỏi lịch vào cuối tin. Khách vừa ĐÁP một câu discovery (cao-nặng, chưa tập bao giờ, tả cơn đau) cũng KHÔNG phải tín hiệu muốn đến: lượt này chỉ tư vấn theo điều khách vừa cho rồi DỪNG.`,
    );
    if (s.hoiThongTinTurn)
      L.push(
        `- Khách đang hỏi THÔNG TIN (tiện ích, chính sách, có/không có gì) → trả gọn đúng câu đó rồi DỪNG. ⛔ CẤM gắn thêm câu hỏi bán hàng kiểu "mình đang quan tâm bộ môn nào / mục tiêu của mình là gì" vào cuối tin khi lượt trước em đã hỏi rồi — hỏi lắm thành đeo bám.`,
      );
  }

  // mời thử một lần
  if (s.trialInvited && !s.wantsCome && !s.closed) {
    L.push(
      `- Em ĐÃ mời trải nghiệm miễn phí trước đó mà khách chưa gật → CẤM mời lại, CẤM hỏi "dự định qua hôm nào". Chỉ tập trung trả lời/tư vấn đúng điều khách đang nói; kết tin không cần câu hỏi cũng được.`,
    );
  }

  // giá — bảng tra do pricing.ts cắt sẵn theo bộ môn/đối tượng/nhóm giá khách hỏi
  if (s.hoiGiaTurn) {
    L.push(buildPriceDirective(s, turn.priceBucket ?? ""));
  } else {
    L.push(
      `- Tin này khách KHÔNG hỏi giá → không chủ động nêu con số tiền, KHÔNG đổ bảng giá và cũng KHÔNG chào tên gói/thẻ nào (gói Full, thẻ hội viên, liệu trình...). Lượt này chỉ tư vấn/hỏi thêm cho hiểu nhu cầu.`,
    );
  }

  // chê đắt → reframe giá trị TRƯỚC, cấm hạ giá / chào gói rẻ ngay trong tin này
  if (s.cheDatTurn) {
    const value =
      s.flow === "giai-co"
        ? "KTV được đào tạo bài bản, tác động đúng nhóm cơ gây đau nên đỡ bền hơn massage phải làm lại liên tục"
        : "gym 700m2 máy chuẩn quốc tế, bể bơi 4 mùa duy nhất Vĩnh Yên, GV Yoga - Zumba người Ấn Độ, InBody đo miễn phí, bãi đỗ xe rộng";
    L.push(
      `- ⚠ Khách vừa CHÊ ĐẮT → tin này reframe GIÁ TRỊ trước (${value}) rồi mời trải nghiệm cảm nhận. ⛔ CẤM hạ giá, CẤM chia nhỏ giá theo ngày / so ly cà phê, CẤM chào ngay gói rẻ hơn trong cùng tin — gói nhẹ hơn chỉ đưa ra nếu khách VẪN từ chối ở lượt sau.`,
    );
  }

  // dịch vụ ngoài phạm vi grounding → không được khẳng định bừa
  if (s.ngoaiPhamViTurn) {
    L.push(
      `- ⚠ Khách đang hỏi một dịch vụ NGOÀI phạm vi kiến thức nền của em → CẤM khẳng định "có" hay "không có". Trả lời thật: "cái này để em xác nhận lại rồi báo mình chính xác ạ" + xin SĐT để báo lại.`,
    );
  }

  // (luật chống up-sell chen ngang nằm sẵn trong system prompt của cả 2 nhánh — không lặp lại
  // ở đây, khối bối cảnh càng ngắn thì 12B càng bám được các luật ĐỘNG của riêng lượt này)

  // media — hệ thống đã quyết, model chỉ viết câu dẫn
  if (mediaKey) {
    const what = mediaKey.startsWith("mr-")
      ? "vài ca giải cơ bên em làm thực tế"
      : mediaKey.includes("before-after")
        ? "vài hình trước - sau của hội viên bên em"
        : "vài hình khu tập bên em";
    L.push(
      `- 📎 Tin này hệ thống ĐÍNH KÈM ảnh (${what}) → thêm ĐÚNG 1 câu dẫn ngắn tự nhiên cho khách biết em đang gửi hình, rồi tư vấn tiếp. KHÔNG hỏi "mình có muốn xem ảnh không", KHÔNG mô tả từng tấm.`,
    );
  } else {
    L.push(`- Tin này KHÔNG có ảnh đính kèm → TUYỆT ĐỐI không nói "em gửi ảnh/hình/video" và không hứa gửi tài liệu.`);
  }

  // chống lặp câu hỏi
  if (s.askedQuestions.length) {
    const recent = s.askedQuestions.slice(-8);
    L.push(
      `- Các câu hỏi em ĐÃ hỏi trong cuộc — CẤM hỏi lại nguyên văn hay na ná: ${recent.map((q) => `"${q.raw}"`).join(" · ")}`,
    );
  }

  return `[BỐI CẢNH TIN NÀY — chỉ dẫn nội bộ từ hệ thống, khách KHÔNG nhìn thấy, phải tuân thủ tuyệt đối]\n${L.join("\n")}`;
}

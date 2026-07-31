/**
 * smokeRealcase.ts — bộ test REPLY THẬT rộng, nhắm 2 điểm khách phàn nàn:
 *   (1) "cứ kịch bản mới là vỡ"      → PHẦN A: 12 kịch bản khách thật CHƯA từng smoke.
 *   (2) "cùng 1 câu ra nhiều đáp án" → PHẦN B: hỏi 1 câu N lần / N cách diễn đạt, soi
 *                                       xem CỐT LÕI (giá / giờ / địa chỉ) có ĐỔI không.
 *
 * Chạy qua pipeline gemma thật (không đụng prod nhờ STORAGE_BACKEND=libsql), đọc CÂU CHỮ
 * bot thực trả — không unit-test logic.
 *
 * Chạy:
 *   STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeRealcase.ts          # tất cả
 *   ... smokeRealcase.ts A          # chỉ phần kịch bản
 *   ... smokeRealcase.ts B          # chỉ phần nhất quán
 *   ROUNDS=2 ...                    # phần A chạy 2 vòng (reply ngẫu nhiên)
 *   CONSIST=4 ...                   # phần B hỏi mỗi câu 4 lần (mặc định 3)
 *
 * Nguồn chân lý giá: src/mastra/engine/prompts.ts (khớp 100% bảng giá Fami 07/2026).
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

// ──────────────────────────────────────────────────────────────────────────
// Tiện ích soát
// ──────────────────────────────────────────────────────────────────────────
interface Expect {
  dung?: string[]; // ít nhất MỘT chuỗi phải có
  sai?: string[]; // TUYỆT ĐỐI không được có
  soi?: (reply: string) => string; // "" = đạt, khác = mô tả lỗi
}
interface Scenario {
  name: string;
  turns: { msg: string; expect?: Expect }[];
  soiCuoc?: (replies: string[]) => string;
}

/** Có `frag` không phải dưới dạng đuôi của một số khác (tránh "5 triệu" bắt nhầm "1.5 triệu"). */
function chuaThat(hay: string, frag: string): boolean {
  const f = frag.toLowerCase();
  let i = hay.indexOf(f);
  while (i >= 0) {
    const truoc = i > 0 ? hay[i - 1] : " ";
    if (!/[\d.,]/.test(truoc)) return true;
    i = hay.indexOf(f, i + 1);
  }
  return false;
}
function judge(reply: string, e?: Expect): string[] {
  if (!e) return [];
  const low = reply.toLowerCase();
  const loi: string[] = [];
  const hitSai = (e.sai ?? []).filter((x) => chuaThat(low, x.toLowerCase()));
  if (hitSai.length) loi.push(`có chuỗi CẤM: ${hitSai.map((x) => `"${x}"`).join(", ")}`);
  if (e.dung?.length && !e.dung.some((x) => low.includes(x.toLowerCase()))) {
    loi.push(`thiếu ý bắt buộc (một trong: ${e.dung.map((x) => `"${x}"`).join(", ")})`);
  }
  const soi = e.soi?.(reply) ?? "";
  if (soi) loi.push(soi);
  return loi;
}

/** Giá bên GIẢI CƠ (Hoa Sen) lọt vào mạch Fami = lẫn thương hiệu. */
const GIA_GIAI_CO = ["330 nghìn", "3.8 triệu", "4.2 triệu", "giải cơ", "KTV", "Hoa Sen"];

// ══════════════════════════════════════════════════════════════════════════
// PHẦN A — 12 kịch bản khách thật CHƯA từng smoke
// ══════════════════════════════════════════════════════════════════════════
const SCENARIOS: Scenario[] = [
  {
    // Người gầy tăng cân: cơ chế phải là TĂNG CƠ (gym/tạ + PT), KHÔNG được khuyên Zumba/cardio giảm mỡ.
    name: "A1 · TANGCAN (người gầy ăn không lên → tăng cơ, không Zumba giảm mỡ)",
    turns: [
      { msg: "Em gầy quá ăn mãi không lên cân, tới phòng tập có cải thiện được không ạ" },
      {
        msg: "Em cao 1m72 mà có 55kg thôi ạ",
        expect: {
          soi: (r) => (/tăng cơ|cơ bắp|tạ|pt|hlv|giáo án/i.test(r) ? "" : "không nêu hướng tăng cơ/tạ/PT"),
          sai: ["zumba", "giảm mỡ", "đốt calo", "đốt mỡ"],
        },
      },
      { msg: "Vậy giá tập gym với PT thế nào em", expect: { dung: ["500 nghìn", "3 triệu"] } },
    ],
  },
  {
    // Gia đình 3 người 12 tháng: PHẢI ra bảng gia đình 14 triệu (3 người), KHÔNG cộng 3× cá nhân.
    name: "A2 · GIADINH (2 vợ chồng + 1 con → gói gia đình 3 người)",
    turns: [
      { msg: "Nhà em 3 người muốn đăng ký tập chung cho tiết kiệm, có gói gia đình không ạ" },
      {
        msg: "Vâng 3 người đăng ký 1 năm thì bao nhiêu ạ",
        expect: { dung: ["14 triệu"], sai: ["21 triệu", "2.4 triệu", "42 triệu"] },
      },
    ],
  },
  {
    // Trẻ em 7 tuổi học bơi: nhận từ 6 tuổi → OK; giá KHOÁ HỌC lớp nhóm 1.5tr, KHÔNG lòi thẻ bơi TE 3.6tr.
    name: "A3 · CONHOCBOI (con 7 tuổi học bơi → lớp nhóm 1.5tr, nhận trẻ)",
    turns: [
      { msg: "Bé nhà mình 7 tuổi chưa biết bơi, trung tâm có nhận dạy không ạ", expect: { sai: ["chưa đủ tuổi", "không nhận"] } },
      {
        msg: "Học phí 1 khoá cho bé bao nhiêu ạ",
        expect: { dung: ["1.5 triệu", "3 triệu"], sai: ["3.6 triệu", "600 nghìn", "700 nghìn"] },
      },
    ],
  },
  {
    // Vé bơi lẻ theo chiều cao — KHÔNG được báo thẻ tháng. Khách người lớn cao >1m5 → 40k/lượt.
    name: "A4 · VEBOILE (bơi tự do 1 buổi → vé lẻ theo chiều cao)",
    turns: [
      { msg: "Mình biết bơi rồi, chỉ muốn vào bơi tự do theo buổi thôi thì tính tiền sao ạ" },
      {
        msg: "Mình cao 1m65 ạ",
        expect: { dung: ["40 nghìn"], sai: ["700 nghìn", "1.8 triệu"] },
      },
    ],
  },
  {
    // Không có bộ môn: boxing + xông hơi. Phải nói KHÔNG có (khéo), KHÔNG bịa có.
    name: "A5 · KHONGCO (boxing / xông hơi → không có, không bịa)",
    turns: [
      {
        msg: "Bên mình có lớp boxing và phòng xông hơi không ạ",
        expect: {
          // Phải PHỦ ĐỊNH rõ (chưa/không có boxing & xông hơi). Không dùng sai:["có lớp boxing"] vì
          // chuỗi đó là con của "chưa có lớp boxing" (câu trả lời ĐÚNG) → bắt nhầm.
          soi: (r) =>
            /(chưa|không)\s*(có)?\s*(lớp\s*)?boxing|boxing[^.]*(chưa|không)/i.test(r) &&
            /(chưa|không)[^.]*xông hơi|xông hơi[^.]*(chưa|không)/i.test(r)
              ? ""
              : "không phủ định rõ boxing/xông hơi",
        },
      },
    ],
  },
  {
    // Chính sách: trả góp. KHÔNG trả góp nhưng nói khéo (chuyển khoản/quẹt thẻ), không cụt "không được".
    name: "A6 · TRAGOP (trả góp → không có, nói khéo)",
    turns: [
      {
        msg: "Đóng 1 năm hơi nhiều, cho em trả góp hàng tháng được không ạ",
        expect: {
          // ĐÚNG = gợi gói NGẮN hơn / thanh toán gọn để giảm gánh; SAI = chào gói DÀI/to hơn
          // (12 tháng / 7 triệu) cho người đang thấy nhiều tiền.
          soi: (r) => {
            const coCachNhe = /chuyển khoản|quẹt thẻ|gói tháng|gói ngắn|ngắn hơn|1 tháng|3 tháng|6 tháng|linh hoạt|nhẹ/i.test(r);
            // Mốc tham chiếu của khách là GÓI NĂM ("1 năm hơi nhiều"). SAI = đẩy khách LÊN đúng gói năm
            // (12 tháng / 7 triệu) — dài & đắt hơn thứ họ đã thấy nhiều. Gói NGẮN hơn (6th 3.8tr, 3th 2.1tr)
            // là DOWN-SELL đúng hướng → KHÔNG tính là pitch. KHÔNG bắt "12 tháng" trần: bot hay nhắc
            // "gói 12 tháng cao quá thì chọn ngắn hơn" — đó là lái RA KHỎI gói năm (đúng).
            const pitchGiaDat = /7 triệu/i.test(r);
            const ruNangGoi = /nên (chọn|đăng ký|lấy|mua) gói (12 tháng|dài|năm)|gói (12 tháng|năm)[^.]*(ưu đãi|lợi|tốt|tiết kiệm) hơn/i.test(r);
            if (pitchGiaDat || ruNangGoi) return "chào/pitch gói dài/đắt hơn cho người kêu nhiều tiền";
            return coCachNhe ? "" : "không hướng sang gói ngắn / cách đóng nhẹ hơn";
          },
        },
      },
    ],
  },
  {
    // Bảo lưu khi bận: gói năm (từ 3 tháng) bảo lưu được; gói tháng chuyển nhượng trong gia đình.
    name: "A7 · BAOLUU (đóng năm mà hay đi công tác → bảo lưu)",
    turns: [
      { msg: "Em hay đi công tác dài ngày, lỡ đóng gói năm mà nghỉ giữa chừng có bảo lưu được không ạ" },
    ],
  },
  {
    // Doanh nghiệp: KHÔNG có bảng cố định → xin SĐT báo sale, KHÔNG bịa giá/%.
    name: "A8 · DOANHNGHIEP (công ty đăng ký cho nhân viên → xin SĐT, không bịa)",
    turns: [
      {
        msg: "Công ty em khoảng 30 nhân viên muốn mua gói tập cho cả team, có giá ưu đãi doanh nghiệp không ạ",
        expect: {
          soi: (r) => (/số điện thoại|sđt|liên hệ|gọi lại|zalo|\d{7,}/i.test(r) ? "" : "không xin liên hệ để sale báo lại"),
          sai: ["20%", "30%", "giảm 10", "800 nghìn/người"],
        },
      },
    ],
  },
  {
    // ECO 2 môn tự chọn (trừ yoga). Khách muốn CHỈ gym + bơi → gợi ECO đúng giá 700k/2tr.
    name: "A9 · ECO (chỉ muốn gym + bơi → gói ECO 2 môn)",
    turns: [
      { msg: "Em không tập yoga zumba, chỉ muốn gym với bơi thôi thì có gói nào gọn không ạ" },
      {
        msg: "Gói đó 1 tháng với 3 tháng bao nhiêu ạ",
        expect: { dung: ["700 nghìn", "2 triệu"], sai: ["giải cơ"] },
      },
    ],
  },
  {
    // Giải cơ CẤP TÍNH: vừa lật cổ chân sưng → KHÔNG mời làm ngay, khuyên nghỉ/chườm/khám (an toàn).
    name: "A10 · CAPTINH (lật cổ chân sưng hôm qua → khuyên nghỉ, không mời làm ngay)",
    turns: [
      {
        msg: "Hôm qua em đá bóng bị lật cổ chân, giờ sưng to đi lại đau, bên mình giải cơ giúp được không ạ",
        expect: {
          soi: (r) => (/nghỉ|chườm|đá lạnh|khám|3-5 ngày|hết sưng|cấp/i.test(r) ? "" : "không khuyến cáo nghỉ/chườm/khám cho chấn thương cấp"),
          sai: ["qua thử ngay", "đặt lịch luôn", "làm ngay hôm nay"],
        },
      },
    ],
  },
  {
    // Yoga cho người lớn tuổi/cứng người mới tập → trấn an có lớp người mới, KHÔNG chê/không bịa lớp riêng.
    name: "A11 · YOGAMOI (60 tuổi người cứng chưa tập yoga bao giờ → trấn an)",
    turns: [
      { msg: "Mẹ em 60 tuổi người cứng lắm chưa tập yoga bao giờ, tập được không ạ" },
      {
        msg: "Vậy 1 tháng yoga bao nhiêu tiền em",
        expect: { dung: ["650 nghìn"], sai: ["500 nghìn", "800 nghìn"] },
      },
    ],
  },
  {
    // ECO reroute: gym + zumba (2 môn, KHÔNG yoga) → gói ECO 700k, KHÔNG phải thẻ Gym 500k.
    name: "A13 · ECO2 (gym + zumba → gói ECO, không phải thẻ Gym)",
    turns: [
      {
        msg: "Em chỉ muốn tập gym với zumba thôi, có gói nào cho 2 môn không ạ",
      },
      {
        msg: "Gói đó 1 tháng bao nhiêu ạ",
        expect: { dung: ["700 nghìn"], sai: ["500 nghìn"] },
      },
    ],
  },
  {
    // Ranh giới ECO: gym + YOGA → KHÔNG được ECO (ECO trừ yoga) → phải là Full hoặc tách môn.
    name: "A14 · ECOYOGA (gym + yoga → full/tách, TUYỆT ĐỐI không ECO)",
    turns: [
      {
        msg: "Em muốn tập gym với yoga thôi thì có gói nào không ạ",
      },
      {
        msg: "Gói đó 1 tháng bao nhiêu ạ",
        expect: { sai: ["ECO", "eco", "700 nghìn"] },
      },
    ],
  },
  {
    // Giáo viên xin ưu đãi nghề — có bảng GV Full riêng (700k/1.8tr...). KHÔNG nhầm sang HS/SV.
    name: "A12 · GIAOVIEN (giáo viên hỏi ưu đãi nghề → bảng GV Full)",
    turns: [
      { msg: "Em là giáo viên cấp 2, bên mình có ưu đãi gì cho giáo viên không ạ" },
      {
        msg: "Vâng 1 tháng thẻ full cho giáo viên bao nhiêu ạ",
        expect: { dung: ["700 nghìn"], sai: ["500 nghìn", "800 nghìn"] },
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════
// PHẦN C — FAQ "HAY HỎI": tiện ích / chính sách khách nhắn hằng ngày.
//   Gồm 2 ca TÁI HIỆN lỗi LIVE đã vá (sau sinh→lật brand giải cơ; HS/SV→"không tách lẻ")
//   để canh không tái phát, + các câu tiện ích hay bị bịa/thiếu vế.
//   Nguồn chân lý: prompt.ts TIỆN ÍCH & CHÍNH SÁCH + pricing.ts.
// ══════════════════════════════════════════════════════════════════════════
const FAQ: Scenario[] = [
  {
    // PT 1-1: có HLV riêng, giá khởi điểm gói 10 buổi = 3 triệu. KHÔNG bịa giá/buổi khác.
    name: "C1 · PT (có HLV riêng không, giá thế nào → gói PT 10 buổi 3 triệu)",
    turns: [
      { msg: "Bên mình có huấn luyện viên kèm riêng 1-1 không ạ", expect: { sai: ["không có", "chưa có"] } },
      {
        msg: "Vâng em muốn tập kèm riêng, giá thế nào ạ",
        expect: { dung: ["3 triệu"], sai: ["500 nghìn", "800 nghìn"] },
      },
    ],
  },
  {
    // Gửi xe: xe máy MIỄN PHÍ + ô tô CÓ PHÍ — phải nói ĐỦ CẢ 2 VẾ (prompt dặn thẳng).
    name: "C2 · GUIXE (đi ô tô có chỗ đỗ + mất phí không → đủ 2 vế máy free / ô tô phí)",
    turns: [
      {
        msg: "Em hay đi ô tô, bên mình có chỗ đỗ xe không, có mất phí không ạ",
        expect: {
          soi: (r) => {
            const oto = /ô ?tô[^.]*(phí|thu phí|mất phí|trả phí)|(phí|thu phí)[^.]*ô ?tô/i.test(r);
            if (!oto) return "không nói rõ ô tô CÓ THU PHÍ (dễ để khách đến mới biết → mất thiện cảm)";
            return "";
          },
          sai: ["đỗ xe thoải mái", "gửi xe thoải mái"],
        },
      },
    ],
  },
  {
    // Tắm nước nóng: có phòng tắm nước nóng riêng nam/nữ. Đừng bịa "không có".
    name: "C3 · TAM (tập xong có chỗ tắm nước nóng không → có, riêng nam/nữ)",
    turns: [
      {
        msg: "Tập xong ra mồ hôi, bên mình có phòng tắm nước nóng không ạ",
        expect: {
          soi: (r) => (/nước nóng|tắm/i.test(r) && !/không có|chưa có/i.test(r) ? "" : "không xác nhận CÓ phòng tắm nước nóng"),
        },
      },
    ],
  },
  {
    // HLV nữ: CÓ. Khách nữ ngại tập với nam. Đừng bịa "chỉ có HLV nam".
    name: "C4 · HLVNU (ngại tập với HLV nam, có HLV nữ không → CÓ)",
    turns: [
      {
        msg: "Em nữ hơi ngại tập với thầy nam, bên mình có huấn luyện viên nữ không ạ",
        expect: {
          soi: (r) => (/có[^.]*(hlv|huấn luyện viên|thầy|cô)?[^.]*nữ|hlv nữ|cô nữ/i.test(r) && !/không có|chưa có|chỉ có.*nam/i.test(r) ? "" : "không xác nhận CÓ HLV nữ"),
        },
      },
    ],
  },
  {
    // Tập thử: 1 buổi MIỄN PHÍ (đo InBody + tập thử có HLV). Đừng bịa thu phí buổi thử.
    name: "C5 · TAPTHU (cho tập thử 1 buổi được không → miễn phí + InBody)",
    turns: [
      {
        msg: "Em muốn tập thử 1 buổi xem có hợp không rồi mới quyết, được không ạ",
        expect: {
          soi: (r) => (/miễn phí|không mất phí|không tính phí|trải nghiệm|đo inbody|thử/i.test(r) ? "" : "không xác nhận có buổi thử"),
          sai: ["100 nghìn/buổi", "phí thử", "mất phí buổi thử", "50 nghìn/buổi"],
        },
      },
    ],
  },
  {
    // ⚠ TÁI HIỆN LỖI LIVE 30/07: sau sinh + giảm cân → bot LẬT sang brand giải cơ Hoa Sen.
    // ĐÚNG: trấn an an toàn (hỏi bác sĩ, HLV điều chỉnh, tập nhẹ/từ từ), KHÔNG lôi giải cơ vào,
    // KHÔNG ép pitch gói/giá ngay.
    name: "C6 · SAUSINH (mới sinh 3 tháng muốn giảm cân → an toàn, KHÔNG lật brand giải cơ)",
    turns: [
      {
        msg: "Em mới sinh bé được 3 tháng, người tăng cân nhiều muốn tập giảm lại, có tập được không ạ",
        expect: {
          soi: (r) => (/bác sĩ|từ từ|nhẹ nhàng|thể trạng|hồi phục|điều chỉnh|phù hợp sức khỏe|khám/i.test(r) ? "" : "không trấn an/khuyến cáo an toàn cho người sau sinh"),
          sai: GIA_GIAI_CO,
        },
      },
    ],
  },
  {
    // ⚠ TÁI HIỆN LỖI LIVE 30/07: HS/SV hỏi tập riêng 1 môn → bot bịa "không tách lẻ từng bộ môn".
    // ĐÚNG: ưu đãi HS/SV chỉ ở thẻ FULL; gói riêng từng môn VẪN có nhưng theo giá thường.
    name: "C7 · HSSVMON (sinh viên muốn tập MỖI gym → KHÔNG bịa 'không tách lẻ bộ môn')",
    turns: [
      { msg: "Em là sinh viên, bên mình có ưu đãi gì cho sinh viên không ạ" },
      {
        msg: "Em chỉ tập mỗi gym thôi thì giá sinh viên bao nhiêu ạ",
        expect: {
          sai: ["không tách lẻ", "chỉ bán thẻ trọn gói", "không bán riêng", "không tách riêng"],
        },
      },
    ],
  },
  {
    // Giờ CA cụ thể (yoga sáng) KHÔNG có trong prompt → PHẢI defer, KHÔNG khẳng định có/không ca đó.
    name: "C8 · CAYOGA (yoga có ca 6-7h sáng không → defer, không khẳng định giờ ca)",
    turns: [
      {
        msg: "Yoga có lớp ca 6h đến 7h sáng không em, em chỉ rảnh sớm thôi",
        expect: {
          // ĐÚNG = defer (kiểm tra/xác nhận lại lịch rồi báo). SAI = khẳng định chắc có/không ca 6-7h,
          // hoặc "giờ nào cũng được / chọn ca sáng là được" (ngụ ý ca nào cũng có).
          soi: (r) => {
            const defer = /xác nhận lại|kiểm tra[^.]{0,20}lịch|lịch[^.]{0,20}(rồi )?(em )?báo|báo (lại|mình|anh|chị)[^.]{0,25}(chính xác|lịch)|báo lại (cho )?(mình|anh|chị)/i.test(r);
            const khangDinh = /có (lớp |ca )?(6h|06h|từ 6)|chọn (ca|khung giờ) sáng[^.]*(là được|đều được)|ca nào cũng/i.test(r);
            if (khangDinh) return "khẳng định giờ ca cụ thể (đáng lẽ phải defer)";
            return defer ? "" : "không defer lịch ca cụ thể (dễ bịa có/không có ca)";
          },
        },
      },
    ],
  },
  {
    // Bể bơi trưa: KHÔNG nghỉ trưa, mở 6h–20h30. Đừng bịa "nghỉ trưa".
    name: "C9 · BOITRUA (bể bơi trưa có mở không → không nghỉ trưa)",
    turns: [
      {
        msg: "Buổi trưa em tranh thủ đi bơi được không hay bể nghỉ trưa ạ",
        expect: {
          // Chỉ dùng soi: khẳng định KHÔNG nghỉ trưa = đúng. Không đặt sai:["nghỉ trưa nên"] vì
          // chuỗi đó là CON của "KHÔNG nghỉ trưa nên…" (câu đúng) → bắt nhầm. Bắt câu SAI bằng
          // cách yêu cầu có khẳng định-mở và không có mệnh đề "bể nghỉ trưa từ …".
          soi: (r) => {
            if (/bể (bơi )?nghỉ trưa (từ|vào|lúc)|có nghỉ trưa/i.test(r)) return "nói bể CÓ nghỉ trưa (sai — bể không nghỉ trưa)";
            return /không nghỉ trưa|cả ngày|liên tục|xuyên trưa|vẫn mở/i.test(r) ? "" : "không xác nhận bể KHÔNG nghỉ trưa";
          },
        },
      },
    ],
  },
  {
    // Anti-bịa đồ mượn: prompt KHÔNG ghi có cho mượn giày/thảm → CẤM hứa "có sẵn cho mượn";
    // dặn khách tự chuẩn bị, món chưa chắc thì xác nhận lại.
    name: "C10 · DOMUON (có cho mượn giày/thảm không → không bịa có, dặn tự chuẩn bị)",
    turns: [
      {
        msg: "Đi tập em cần mang gì, bên mình có cho mượn giày với thảm tập không ạ",
        expect: {
          soi: (r) => (/tự chuẩn bị|mang theo|chuẩn bị đồ|xác nhận lại/i.test(r) ? "" : "không dặn tự chuẩn bị / không defer món chưa chắc"),
          sai: ["có sẵn giày", "cho mượn giày", "có sẵn thảm", "cho mượn thảm", "bên em có giày"],
        },
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════
// PHẦN D — RANH GIỚI & BẪY HAY GẬT BỪA: các câu khách hỏi hằng ngày mà 12B hay "chiều khách"
//   gật bừa / bịa (prompt RANH_GIOI dặn thẳng) + luồng GIẢM CÂN chủ đạo (neo Full, không tụt Gym).
//   Nguồn chân lý: prompt.ts RANH_GIOI + TIỆN ÍCH + GIẢI PHÁP THEO MỤC TIÊU; pricing.ts; contact.ts.
// ══════════════════════════════════════════════════════════════════════════
/** Số hotline thật (chỉ chữ số) — soi bất kể bot nhóm số kiểu gì. */
const HOTLINE_SO = "0964044451";
const FAQ2: Scenario[] = [
  {
    // Khách ở tỉnh khác: CHỈ có cơ sở Vĩnh Phúc, KHÔNG bịa "Fami tại Hà Nội".
    name: "D1 · CHINHANH (em ở Hà Nội có cơ sở gần không → chỉ Vĩnh Phúc, không bịa CN Hà Nội)",
    turns: [
      {
        msg: "Em ở Hà Nội, bên mình có cơ sở nào gần Hà Nội cho em tập không ạ",
        expect: {
          // Bịa CN Hà Nội = KHẲNG ĐỊNH có cơ sở ở HN. KHÔNG soi chuỗi "…Hà Nội" trần vì câu ĐÚNG
          // ("chưa có chi nhánh nào ở Hà Nội") chứa nó — bẫy phủ định như C9/A5. Thay vào đó soi
          // ĐIỀU KIỆN ĐỦ: khẳng định CHỈ/DUY NHẤT cơ sở Vĩnh Yên/Phúc (bịa HN thì không thể nói "duy nhất VP").
          soi: (r) => {
            const viVP = /vĩnh yên|vĩnh phúc/i.test(r);
            const chiVP = /chỉ (đang )?(có|đặt|nằm)|duy nhất|hiện (chỉ|chưa)|chưa có (chi nhánh|cơ sở)/i.test(r);
            return viVP && chiVP ? "" : "không nói rõ CHỈ có cơ sở tại Vĩnh Phúc (dễ bịa CN Hà Nội)";
          },
        },
      },
    ],
  },
  {
    // Bé DƯỚI 6 tuổi: lớp bơi nhận từ 6 tuổi → chưa nhận, KHÔNG bịa "vẫn có HLV kèm học được".
    name: "D2 · BEDUOI6 (bé 4 tuổi học bơi → nhận từ 6 tuổi, không bịa nhận bé nhỏ hơn)",
    turns: [
      {
        msg: "Bé nhà em mới 4 tuổi, cho bé học bơi ở bên mình được không ạ",
        expect: {
          soi: (r) => {
            if (/(vẫn (học|bơi|tập) được|có hlv kèm (riêng )?(cho bé )?(dưới|nhỏ)|nhận (bé )?(4 tuổi|dưới 6))/i.test(r)) return "bịa nhận bé dưới 6 tuổi";
            return /6 tuổi/i.test(r) ? "" : "không nêu điều kiện lớp bơi nhận từ 6 tuổi";
          },
        },
      },
    ],
  },
  {
    // Trẻ <16 phải có người lớn đi kèm bàn giao HLV — KHÔNG đáp "bé đi một mình được".
    name: "D3 · BEMOTMINH (bé 10 tuổi tự đến tập một mình → cần người lớn đi kèm)",
    turns: [
      {
        msg: "Bé nhà em 10 tuổi, em bận nên cho bé tự bắt xe đến tập một mình được không ạ",
        expect: {
          soi: (r) => (/người lớn (đi )?(cùng|kèm|theo)|bố mẹ (đi )?(cùng|kèm)|phụ huynh (đi )?(cùng|kèm)|cần (có )?người lớn|người thân đi cùng/i.test(r) ? "" : "không nói cần người lớn đi kèm bé"),
        },
      },
    ],
  },
  {
    // Khách xin SỐ hotline → đưa ĐÚNG số (mọi cách nhóm số). KHÔNG bịa số khác / KHÔNG nói "không có số".
    name: "D4 · HOTLINE (xin số điện thoại/hotline → đưa đúng 096 404 44 51)",
    turns: [
      {
        msg: "Cho em xin số điện thoại hotline bên mình để em gọi tư vấn trực tiếp với ạ",
        expect: {
          soi: (r) => (r.replace(/\D/g, "").includes(HOTLINE_SO) ? "" : "không đưa đúng số hotline (096 404 44 51)"),
          sai: ["không có số", "chưa có số"],
        },
      },
    ],
  },
  {
    // Hoàn tiền / đổi gói: KHÔNG hoàn, KHÔNG đổi → hướng bảo lưu/chuyển nhượng, nói khéo (không cụt).
    name: "D5 · HOANTIEN (đóng rồi bận, đòi hoàn tiền/đổi gói → hướng bảo lưu, không hứa hoàn)",
    turns: [
      {
        msg: "Em lỡ đóng gói rồi mà giờ bận quá không tập được, cho em hoàn lại tiền hoặc đổi sang gói khác được không ạ",
        expect: {
          // Tiêu chí THẬT: (1) TUYỆT ĐỐI không hứa hoàn tiền; (2) phải TRẢ LỜI câu hỏi — hoặc nêu rõ
          // chính sách không-hoàn/không-đổi, HOẶC đưa hướng bảo lưu/chuyển nhượng. FAIL = "né trắng":
          // không nói gì về chính sách/hướng giải quyết, chỉ hỏi lại "gói của mình là gì".
          soi: (r) => {
            if (/(hoàn (lại )?(tiền|100%?)|trả lại tiền)[^.]{0,15}(được|luôn|cho mình|ngay)/i.test(r)) return "hứa hoàn tiền (sai chính sách)";
            const neuChinhSach = /không (hỗ trợ )?(hoàn|đổi)|không có (chính sách )?(hoàn|đổi)/i.test(r);
            const coHuong = /bảo lưu|chuyển nhượng/i.test(r);
            return neuChinhSach || coHuong ? "" : "né trắng — không nêu chính sách không-hoàn cũng không đưa hướng bảo lưu/chuyển nhượng";
          },
        },
      },
    ],
  },
  {
    // Khách đi làm chỉ rảnh tối muộn + cuối tuần → answer-first: mở HẰNG NGÀY tới 20:30.
    name: "D6 · GIOTOI (chỉ rảnh tối muộn/cuối tuần có mở không → hằng ngày tới 20:30)",
    turns: [
      {
        msg: "Em đi làm cả ngày, chỉ tập được tối muộn với cuối tuần thôi, bên mình có mở không ạ",
        expect: {
          soi: (r) => (/20h30|20:30|8h30 tối|20 giờ 30|hàng ngày|tất cả các ngày|cả tuần|cuối tuần (vẫn |cũng )?(mở|có|hoạt động)/i.test(r) ? "" : "không xác nhận khung giờ mở (hằng ngày tới 20:30)"),
        },
      },
    ],
  },
  {
    // Rủ thêm bạn/nhóm → CÓ ưu đãi nhóm (đi đông tiết kiệm), KHÔNG bịa % cụ thể.
    name: "D7 · RUNHOM (rủ thêm 2 bạn tập chung có ưu đãi không → có ưu đãi nhóm, không bịa %)",
    turns: [
      {
        msg: "Em rủ thêm 2 đứa bạn cùng đăng ký tập chung thì có ưu đãi gì không ạ",
        expect: {
          soi: (r) => (/ưu đãi|tiết kiệm|đi (đông|nhóm)|nhóm|đông người|gia đình|nhiều người/i.test(r) ? "" : "không xác nhận có ưu đãi khi đi đông"),
          sai: ["10%", "20%", "30%", "giảm 15", "giảm 25"],
        },
      },
    ],
  },
  {
    // Nước bể bơi: CÓ dùng Clo tiêu chuẩn + xử lý/thay nước — KHÔNG nói "không dùng clo".
    name: "D8 · NUOCBE (bể bơi có sạch/dùng clo không → có clo tiêu chuẩn, xử lý nước)",
    turns: [
      {
        msg: "Nước bể bơi bên mình có đảm bảo vệ sinh không, có dùng clo khử khuẩn không ạ",
        expect: {
          soi: (r) => (/clo|khử khuẩn|xử lý nước|thay nước|tiêu chuẩn|lọc nước|đảm bảo|sạch/i.test(r) ? "" : "không trấn an vệ sinh nước bể"),
          sai: ["không dùng clo", "không có clo", "không sử dụng clo"],
        },
      },
    ],
  },
  {
    // Bà bầu: AN TOÀN — trấn an + hỏi bác sĩ / HLV điều chỉnh, KHÔNG ép gói, KHÔNG hứa.
    name: "D9 · BABAU (bầu 5 tháng tập yoga được không → an toàn, không ép, không hứa)",
    turns: [
      {
        msg: "Em đang bầu 5 tháng, tập yoga bên mình có được không ạ",
        expect: {
          soi: (r) => (/bác sĩ|khám|thể trạng|điều chỉnh|nhẹ nhàng|phù hợp sức khỏe|thai/i.test(r) ? "" : "không trấn an/khuyến cáo an toàn cho bà bầu"),
        },
      },
    ],
  },
  {
    // LUỒNG GIẢM CÂN CHỦ ĐẠO: mục tiêu giảm cân → neo thẻ FULL (đa môn), TUYỆT ĐỐI không tụt về
    // Gym 500k (lỗi prod-30). Turn cuối là điểm chốt.
    name: "D10 · GIAMCAN (giảm cân 1m58-68kg → hỏi giá phải neo Full, không tụt Gym 500k)",
    turns: [
      { msg: "Em muốn giảm cân lấy lại dáng, bên mình tư vấn giúp em với ạ" },
      { msg: "Em cao 1m58 mà nặng 68kg rồi ạ", expect: { sai: ["zumba giảm mỡ nhanh"] } },
      {
        msg: "Vậy chi phí tập thế nào em",
        expect: { dung: ["800 nghìn", "2.1 triệu", "3.8 triệu", "7 triệu"], sai: ["500 nghìn"] },
      },
    ],
  },
  {
    // RANH GIỚI thương hiệu: khách tưởng Fami ở khu vườn ổi (đó là bên giải cơ Hoa Sen — cơ sở RIÊNG).
    // ĐÚNG = nêu địa chỉ Fami 32A + PHỦ NHẬN vườn ổi. Soi PHẢI hiểu phủ định (câu đúng buộc nhắc "vườn ổi").
    name: "D11 · VUONOI (Fami có phải ở khu vườn ổi không → không, 32A; vườn ổi là bên Hoa Sen)",
    turns: [
      {
        msg: "Chỗ tập của mình có phải ở khu vườn ổi đường Kim Ngọc không em",
        expect: {
          soi: (r) => {
            const fami = /nguyễn chí thanh|32a/i.test(r);
            if (!fami) return "không nêu đúng địa chỉ Fami (32A Nguyễn Chí Thanh)";
            if (!/vườn ổi/i.test(r)) return ""; // nêu 32A, không dính vườn ổi → ổn
            const phuNhan = /(không phải|chứ không|không nằm|không ở|không có)[^.]{0,30}vườn ổi|vườn ổi[^.]{0,30}(là (bên|cơ sở riêng|của bên giải cơ)|bên (giải cơ|hoa sen)|hoa sen)/i.test(r);
            return phuNhan ? "" : "nhắc vườn ổi mà KHÔNG phủ nhận rõ (dễ tự nhận là cơ sở của mình)";
          },
        },
      },
    ],
  },
];

// ══════════════════════════════════════════════════════════════════════════
// PHẦN B — NHẤT QUÁN: mỗi câu hỏi 1 fact, hỏi nhiều cách/nhiều lần → cốt lõi phải KHÔNG ĐỔI.
//   extract(reply) trả về "dấu vân tay" của fact (chuỗi chuẩn hoá). Nếu qua các lần chạy mà
//   ra >1 vân tay khác nhau ⇒ BẤT NHẤT (đúng lời khách phàn nàn). "" = bot né/thiếu fact.
// ══════════════════════════════════════════════════════════════════════════
interface ConsistCase {
  name: string;
  variants: string[]; // các cách diễn đạt khác nhau CỦA CÙNG 1 câu hỏi
  extract: (reply: string) => string; // vân tay fact; "" nếu bot không đưa fact
  batBuoc?: string; // nếu set, vân tay phải == chuỗi này mới đúng
}

/** Bóc mọi khoản tiền (nghìn/triệu/k) khỏi câu, chuẩn hoá, sort → so được giữa các lần. */
function bocTien(r: string): string {
  const hits = [...r.matchAll(/\d+(?:[.,]\d+)?\s*(?:triệu|nghìn|ngàn|k)\b/gi)].map((m) =>
    m[0].toLowerCase().replace(/\s+/g, "").replace("ngàn", "nghìn").replace(/k$/, "nghìn"),
  );
  return [...new Set(hits)].sort().join(" | ");
}

const CONSIST: ConsistCase[] = [
  {
    name: "gym 1 tháng bao nhiêu (phải luôn 500 nghìn)",
    variants: [
      "Gym 1 tháng bao nhiêu tiền ạ",
      "Cho em hỏi phí tập gym theo tháng",
      "Tập gym giá thế nào em",
    ],
    extract: bocTien,
    batBuoc: "500nghìn",
  },
  {
    name: "giờ mở cửa (phải luôn 05:00–20:30)",
    variants: [
      "Trung tâm mở cửa mấy giờ ạ",
      "Mình tập buổi tối muộn được không, mấy giờ đóng cửa ạ",
      "Bên mình làm việc khung giờ nào vậy em",
    ],
    // Bóc mốc giờ → chỉ lấy MỞ (sớm nhất) và ĐÓNG (muộn nhất). Bỏ mốc giữa (vd bể bơi 06:00) vì
    // nêu thêm giờ bể là chi tiết ĐÚNG, không phải mâu thuẫn — chỉ soi mở/đóng cửa trung tâm.
    extract: (r) => {
      const hits = [...r.matchAll(/\b([0-2]?\d)\s*[h:g]\s*([0-5]\d)?\b/g)].map((m) => {
        const hh = m[1].padStart(2, "0");
        const mm = (m[2] ?? "00").padStart(2, "0");
        return `${hh}h${mm}`;
      });
      const uniq = [...new Set(hits)].sort();
      return uniq.length ? `${uniq[0]}-${uniq[uniq.length - 1]}` : "";
    },
  },
  {
    name: "địa chỉ (phải luôn 32A Nguyễn Chí Thanh)",
    variants: [
      "Trung tâm ở đâu ạ",
      "Cho em xin địa chỉ với",
      "Chỗ mình gần khu nào ở Vĩnh Yên vậy em",
    ],
    extract: (r) => (/32a?\s+nguyễn chí thanh/i.test(r) ? "32A Nguyễn Chí Thanh" : r.match(/địa chỉ[^\n.]{0,40}/i)?.[0]?.trim() ?? ""),
    batBuoc: "32A Nguyễn Chí Thanh",
  },
  {
    name: "học phí học bơi (phải luôn lớp nhóm 1.5 triệu)",
    variants: [
      "Em chưa biết bơi, học 1 khoá hết bao nhiêu tiền ạ",
      "Khoá học bơi cho người lớn giá thế nào em",
      "Đăng ký học bơi từ đầu bao nhiêu 1 khoá ạ",
    ],
    extract: bocTien,
  },
  {
    name: "bơi người lớn 1 tháng (phải luôn 700 nghìn)",
    variants: [
      "Mình biết bơi rồi, mua thẻ bơi 1 tháng bao nhiêu ạ",
      "Vé bơi tháng cho người lớn giá bao nhiêu em",
    ],
    extract: bocTien,
    batBuoc: "700nghìn",
  },
  {
    // CHỈ hỏi 1 câu "có mấy cơ sở" bằng nhiều cách — cùng 1 câu hỏi → vân tay phải luôn [FAMI].
    // (Câu "có phải vườn ổi không" là câu hỏi KHÁC — tách sang PHẦN D VUONOI với soi hiểu phủ định,
    //  vì trả lời ĐÚNG buộc phải nhắc "vườn ổi" để phủ nhận → không dùng match chuỗi trần ở đây được.)
    name: "có mấy cơ sở (Fami chỉ 1 cơ sở 32A, không lẫn giải cơ)",
    variants: [
      "Bên mình có mấy cơ sở ở Vĩnh Yên ạ",
      "Trung tâm có nhiều chi nhánh không hay chỉ một chỗ thôi ạ",
      "Fami có mấy địa điểm vậy em",
    ],
    // vân tay = có nhắc đúng địa chỉ Fami & KHÔNG tự nhận giải cơ/Hoa Sen/vườn ổi là cơ sở của mình.
    extract: (r) => {
      const lanGiaiCo = /vườn ổi|hoa sen|kim ngọc/i.test(r) ? "LẪN-GIAICO" : "";
      const fami = /nguyễn chí thanh/i.test(r) ? "FAMI" : "";
      return [fami, lanGiaiCo].filter(Boolean).join("+") || "khác";
    },
    batBuoc: "FAMI",
  },
];

// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const only = (process.argv[2] ?? "").toUpperCase();
  const rounds = Number(process.env.ROUNDS ?? "1");
  const consistN = Number(process.env.CONSIST ?? "3");
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");

  let fail = 0;
  const ask = async (msg: string, threadId: string): Promise<string> => {
    const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
    return out.reply ?? "";
  };

  // ── PHẦN A + C + D ── (kịch bản + FAQ + ranh giới, cùng cấu trúc turn/expect)
  //   only=""         → chạy A, C, D (bỏ B)
  //   "A"/"C"/"D"     → chỉ nhóm đó · "A4"/"C6"/"D10" → chỉ 1 case
  //   B tách riêng bên dưới.
  const GROUPS = ["A", "C", "D"];
  const runScenarios = !only || GROUPS.some((g) => only.startsWith(g));
  if (runScenarios) {
    const pool = [...SCENARIOS, ...FAQ, ...FAQ2];
    for (let round = 1; round <= rounds; round++) {
      for (const scn of pool) {
        const nameU = scn.name.toUpperCase();
        // only là tên 1 nhóm ("A"/"C"/"D") → chạy cả nhóm; là tên case ("A4") → khớp tiền tố.
        if (only && GROUPS.includes(only) && !nameU.startsWith(only)) continue;
        if (only && !GROUPS.includes(only) && !nameU.startsWith(only)) continue;
        const threadId = `real-A-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        console.log(`\n${"═".repeat(78)}\n▶ [vòng ${round}] ${scn.name}\n${"═".repeat(78)}`);
        const replies: string[] = [];
        for (const [i, turn] of scn.turns.entries()) {
          console.log(`\nKH: ${turn.msg}`);
          const t0 = Date.now();
          let reply = "";
          try {
            reply = await ask(turn.msg, threadId);
          } catch (e) {
            console.error(`  ✗ LỖI LƯỢT:`, (e as Error)?.message);
            fail++;
            continue;
          }
          console.log(`BOT (${((Date.now() - t0) / 1000).toFixed(1)}s): ${reply}`);
          replies.push(reply);
          const loi = judge(reply, turn.expect);
          if (turn.expect) {
            if (loi.length) {
              fail++;
              console.log(`  ❌ lượt ${i + 1} TRƯỢT — ${loi.join(" · ")}`);
            } else console.log(`  ✅ lượt ${i + 1} đạt`);
          }
        }
        const lc = scn.soiCuoc?.(replies) ?? "";
        if (lc) {
          fail++;
          console.log(`  ❌ cả cuộc TRƯỢT — ${lc}`);
        }
      }
    }
  }

  // ── PHẦN B ──
  if (!only || only === "B") {
    console.log(`\n\n${"█".repeat(78)}\n█ PHẦN B — NHẤT QUÁN (mỗi câu ${consistN} lần, cốt lõi phải KHÔNG ĐỔI)\n${"█".repeat(78)}`);
    for (const cc of CONSIST) {
      console.log(`\n${"─".repeat(78)}\n◆ ${cc.name}\n${"─".repeat(78)}`);
      const vans: string[] = [];
      for (let k = 0; k < consistN; k++) {
        const msg = cc.variants[k % cc.variants.length];
        const threadId = `real-B-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        let reply = "";
        try {
          reply = await ask(msg, threadId);
        } catch (e) {
          console.error(`  ✗ LỖI:`, (e as Error)?.message);
          fail++;
          continue;
        }
        const van = cc.extract(reply);
        vans.push(van);
        console.log(`\n  KH: ${msg}`);
        console.log(`  BOT: ${reply}`);
        console.log(`  ⇒ cốt lõi: [${van || "∅ KHÔNG CÓ FACT"}]`);
      }
      const uniq = [...new Set(vans)];
      const coRong = vans.some((v) => v === "");
      const batBuocSai = cc.batBuoc && uniq.some((v) => v && v !== cc.batBuoc);
      if (uniq.length > 1) {
        fail++;
        console.log(`\n  ❌ BẤT NHẤT — ${uniq.length} đáp án khác nhau: ${uniq.map((v) => `[${v || "∅"}]`).join(" ")}`);
      } else if (coRong) {
        fail++;
        console.log(`\n  ❌ THIẾU FACT — bot né không đưa cốt lõi ở ≥1 lần`);
      } else if (batBuocSai) {
        fail++;
        console.log(`\n  ❌ SAI CHUẨN — cốt lõi [${uniq[0]}] khác mức đúng [${cc.batBuoc}]`);
      } else {
        console.log(`\n  ✅ nhất quán: [${uniq[0]}]`);
      }
    }
  }

  console.log(`\n${fail === 0 ? "✅ TẤT CẢ ĐẠT" : `❌ ${fail} điểm TRƯỢT`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

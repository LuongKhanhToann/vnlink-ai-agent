/**
 * scenarios.ts — KỊCH BẢN TEST LUỒNG LỚN (single source of truth)
 *
 * Mỗi scenario = 1 cuộc thoại 1 mạch (1 thread), mô phỏng khách FB THẬT:
 * tin ngắn, viết thường, có lỗi gõ, không khách sáo. `expect` là kỳ vọng HÀNH VI
 * bot ở turn đó — để SOI MẮT THƯỜNG khi đọc log, KHÔNG phải assertion tự động
 * (funnel sale khó assert cứng; soi người vẫn chuẩn nhất).
 *
 * 2 flow trong hệ: "fitness" (Fami Gym+Yoga+Zumba+Bơi) và "giai-co" (Spa Hoa Sen).
 *
 * ── 9 LUỒNG ──────────────────────────────────────────────────────────────────
 * A. XƯƠNG SỐNG happy-path (1 luồng / 1 chủ đề khách hay hỏi):
 *   TANGCAN  fitness · tăng cân, chưa biết tập      → 🖼 before-after (tăng cân)
 *   GIAMCAN  fitness · giảm cân, sau sinh, đa môn   → 🖼 before-after (giảm cân) + 🖼 bể bơi
 *   GYM      fitness · gym thuần, hỏi cơ sở vật chất → 🖼 ảnh phòng gym + 🖼 before-after
 *   POOL     fitness · bơi, bể 4 mùa                → 🖼 ảnh bể bơi
 *   YOGA     fitness · yoga nữ, giảm stress         → 🖼 ảnh phòng yoga
 *   GIAICO   giai-co · giải cơ cổ vai gáy           → 🖼 before-after giải cơ (mr-neck-shoulder)
 * B. STRESS / CANH HỒI QUY (nhắm chỗ bot hay vỡ — KHÔNG happy-path):
 *   DOIFLOW  đổi flow gym→giải cơ giữa chừng        → canh BUG flow-flip (giai-co lock)
 *   DEDAT    giai-co chân/lưng, khách "để xem đã"   → canh BUG giục-chốt (guard G6) + 🖼 mr-sport
 *   HOIGIA   hỏi giá phủ đầu + chê đắt + để tính đã → answer-first + reframe, không nài
 *
 * ── HỢP ĐỒNG ẢNH (bắt buộc bot CHỦ ĐỘNG gửi, không chờ khách xin) ─────────────
 * Bot phải BIẾT TỰ gửi ảnh đúng lúc — 2 cơ chế, đều do classifier quyết (KHÔNG regex):
 *   • show_results — khách NGHI NGỜ kết quả ("liệu có thật ko", "tập mãi ko thấy gì")
 *     → bung ảnh CHỨNG MINH: fitness = before-after theo mục tiêu
 *       (giảm→fitness-before-after-loss, tăng→fitness-before-after-gain);
 *       giai-co = mr-* theo vùng đau (cổ/vai/gáy → mr-neck-shoulder).
 *   • show_service — khách quan tâm CƠ SỞ/BỘ MÔN ("phòng rộng ko", "có bể ko",
 *     "không gian yoga thế nào") → bung ảnh ĐÚNG bộ môn:
 *       gym→fitness-gym, bơi→fitness-pool, yoga→fitness-yoga, zumba→fitness-zumba.
 * Mỗi key chỉ gửi 1 lần / cuộc (mediaShownKeys). Điểm 🖼 CHỦ ĐỘNG = nơi BẮT BUỘC
 * thấy ảnh trong log; nếu KHÔNG bung → lỗi media, fix thẳng (đừng test lại nhiều lần).
 *
 * ── CÁCH CHẠY ───────────────────────────────────────────────────────────────
 *   npm run test:kichban                 # liệt kê tất cả id
 *   npm run test:kichban -- GYM          # chạy 1 luồng
 *   npm run test:kichban -- POOL YOGA    # chạy nhiều luồng
 *   npm run test:kichban -- all          # chạy tất cả (tốn token)
 *
 * ⚠ KHÔNG chạy lặp 1 luồng nhiều lần để "cho chắc" — output LLM biến thiên là chuyện
 *   thường, nhưng lỗi LOGIC thì luồng nào cũng lỗi. Thấy lỗi → fix thẳng tầng code/prompt,
 *   KHÔNG lấy cớ chạy lại để né. 1 lượt soi kỹ là đủ.
 */

export type FlowKind = "fitness" | "giai-co";

export interface Turn {
  /** Tin khách gửi (mô phỏng FB thật: ngắn, viết thường). */
  msg: string;
  /** Kỳ vọng hành vi bot ở turn này (soi mắt). 🖼 = bắt buộc thấy ảnh. */
  expect: string;
}

export interface Scenario {
  /** Id ngắn để chọn chạy (vd "GYM", "POOL"). */
  id: string;
  /** Emoji + tiêu đề (in ở header log). */
  title: string;
  /** Flow chính kỳ vọng (chỉ để hiển thị; runtime tự classify). */
  flow: FlowKind;
  /** Mô tả ngắn mục tiêu test luồng này. */
  goal: string;
  turns: Turn[];
}

// ════════════════════════════════════════════════════════════════════════════
// 🅰️ TANGCAN — TĂNG CÂN · gym · khách CHƯA biết tập (fitness)
//    🖼 CHỦ ĐỘNG: before-after TĂNG cân khi khách nghi ngờ "tập mãi ko lên".
// ════════════════════════════════════════════════════════════════════════════
const TANGCAN: Scenario = {
  id: "TANGCAN",
  title: "🅰️ TANGCAN — Tăng cân · gym · chưa biết tập (fitness)",
  flow: "fitness",
  goal: "Đào nỗi đau (gầy mãi ko lên) → InBody → CHƯA biết tập nên nhấn PT + thực đơn → 🖼 before-after tăng cân khi nghi ngờ → giá có lớp lang → HS/SV không bịa → chốt ngày tách lead.",
  turns: [
    { msg: "hi shop", expect: "chào mở đầu thân thiện, hỏi giúp được gì" },
    {
      msg: "a muốn tập cho lên cân, gầy mãi ko lên dc",
      expect: "xưng 'anh', hỏi cao–nặng. KHÔNG nhảy giá/InBody/lịch ngay",
    },
    {
      msg: "1m72 54kg, muốn lên tầm 7-8kg",
      expect: "hỏi vùng tự ti (1 câu, có chủ ngữ 'Anh…')",
    },
    {
      msg: "người mỏng quá, ngực với vai lép nhìn thiếu sức sống",
      expect: "ACK, hỏi thói quen ăn uống/sinh hoạt",
    },
    {
      msg: "ăn cũng nhiều mà ko vào, hay bỏ bữa sáng, lại hay thức khuya",
      expect: "hỏi đã thử cách nào chưa",
    },
    {
      msg: "trước uống bột tăng cân bị đầy bụng, tự tập tạ ở nhà mãi ko lên",
      expect: "ĐỦ nỗi đau → giờ mới pitch InBody (đo cơ thiếu/chuyển hóa cơ bản)",
    },
    {
      msg: "mà a chưa tập gym bao giờ, ko biết bắt đầu kiểu gì",
      expect: "nhận tín hiệu CHƯA biết tập → nhấn cần PT + thực đơn 5-6 bữa, trấn an",
    },
    {
      msg: "tập kiểu gì cho lên cơ chứ ko lên mỡ bụng v e",
      expect: "kiến thức: lộ trình tăng cơ nạc + dinh dưỡng thặng dư sạch, dẫn về PT/InBody",
    },
    {
      msg: "tập ở nhà mãi có thấy gì đâu, liệu lên thật ko",
      expect: "🖼 CHỦ ĐỘNG gửi before-after TĂNG CÂN (khách nghi ngờ, KHÔNG xin ảnh) + trấn an gốc rễ: ở nhà thiếu mức tải/lộ trình",
    },
    {
      msg: "nhìn cũng ham, tập bao lâu thì lên dc e",
      expect: "trả lộ trình chung, dẫn về InBody/PT (không hứa số cứng)",
    },
    {
      msg: "thế gói tập nhiêu tiền",
      expect: "báo 1 gói hợp nhất + giá, rồi hé gói nhẹ hơn. KHÔNG đổ 3 gói cùng lúc",
    },
    {
      msg: "hơi cao, sinh viên có gói nào rẻ hơn ko",
      expect: "báo THẲNG bảng HS/SV (Full HS/SV 1 tháng 700k…) — KHÔNG né 'xin SĐT'",
    },
    {
      msg: "phòng tập ở đâu, có chỗ để xe ko",
      expect: "địa chỉ + bãi đỗ rộng ô tô/xe máy + không gian thoáng",
    },
    { msg: "mở cửa mấy giờ", expect: "trả giờ (5h–20h30), KHÔNG trả bằng bảng giá" },
    {
      msg: "ok cũng muốn thử 1 buổi xem sao",
      expect: "mời trải nghiệm miễn phí (InBody + 1-2 buổi PT) + nhắc suất giới hạn nhẹ",
    },
    {
      msg: "chắc rủ thêm thằng bạn cùng phòng đi cùng",
      expect: "nhắc ƯU ĐÃI NHÓM (không bịa %)",
    },
    {
      msg: "ừ qua thử",
      expect: "dẫn lý do giữ chỗ → HỎI NGÀY (không trống 'tiện hôm nào')",
    },
    { msg: "chắc cuối tuần", expect: "cửa sổ mơ hồ → đưa CHỌN 1-trong-2 ngày cụ thể" },
    { msg: "thứ 7 đi e", expect: "mới xin tên + SĐT (tách khỏi ngày)" },
    { msg: "Toàn 0901234567", expect: "xác nhận GIỮ SLOT 1 câu ngắn rồi DỪNG (không tự gợi QR)" },
    {
      msg: "đến mang theo gì ko e",
      expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info, KHÔNG pitch lại gói",
    },
    { msg: "ok cảm ơn e nhé", expect: "chào ấm, không lặp 'giữ slot… dừng'" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🅱️ GIAMCAN — GIẢM CÂN · sau sinh · đã biết tập · đa môn (fitness)
//    🖼 CHỦ ĐỘNG x2: before-after GIẢM cân (nghi ngờ) + ảnh BỂ BƠI (hỏi có bể ko).
// ════════════════════════════════════════════════════════════════════════════
const GIAMCAN: Scenario = {
  id: "GIAMCAN",
  title: "🅱️ GIAMCAN — Giảm cân · sau sinh · đa môn (fitness)",
  flow: "fitness",
  goal: "SAU SINH (an toàn) → InBody → ĐÃ biết tập nên đẩy THẺ HỘI VIÊN (không ép PT) → 🖼 before-after giảm cân → đa môn (zumba+bơi) → 🖼 ảnh bể → reframe value → chốt ngày tách lead.",
  turns: [
    { msg: "hi", expect: "chào mở đầu" },
    { msg: "c muốn giảm cân", expect: "xưng 'chị', hỏi cao–nặng / history" },
    { msg: "1m58 67kg, muốn giảm tầm 10kg", expect: "hỏi vùng tự ti" },
    { msg: "bụng với đùi nhiều mỡ lắm", expect: "ACK, hỏi thói quen sinh hoạt" },
    {
      msg: "ngồi văn phòng cả ngày, hay ăn vặt tối, với c mới sinh xong",
      expect: "⚠ SAU SINH → trấn an + lưu ý an toàn (hỏi HLV/giấy khám), KHÔNG ép gói",
    },
    {
      msg: "trước nhịn ăn với uống trà giảm cân mà ko xuống, còn mệt",
      expect: "đủ nỗi đau → InBody (không nhịn ăn mù quáng, đo mỡ thừa/cơ)",
    },
    {
      msg: "mà c tập gym với chạy bộ 2 năm rồi, cứ giảm xong lại lên",
      expect:
        "ĐÃ biết tập → tối ưu chi phí bằng THẺ HỘI VIÊN + tự dựa InBody chọn máy. KHÔNG ép PT, KHÔNG hỏi lại 'đã tập chưa'",
    },
    { msg: "đo inbody khác gì cân thường ở nhà", expect: "giải thích bóc tách mỡ/cơ, dẫn value" },
    {
      msg: "tập rồi liệu có xuống ko hay lại lên lại như cũ",
      expect: "🖼 CHỦ ĐỘNG gửi before-after GIẢM CÂN (khách nghi ngờ, KHÔNG xin) + trấn an gốc rễ",
    },
    { msg: "zumba có giảm cân ko e", expect: "kiến thức Zumba (đốt mỡ toàn thân + xả stress), gợi kết hợp Gym" },
    {
      msg: "c cũng thích bơi nữa, bên mình có bể ko",
      expect: "🖼 CHỦ ĐỘNG gửi ảnh BỂ BƠI (xác nhận bể 4 mùa) + nhớ ĐA MÔN (vẫn giảm cân)",
    },
    { msg: "thế gói full bao nhiêu 1 tháng", expect: "báo gói Full hợp nhất + giá, không đổ hết bảng" },
    {
      msg: "đắt thế e",
      expect: "reframe VALUE (700m2 + bể 4 mùa + GV + bãi đỗ xe), KHÔNG hạ giá / chia nhỏ ly cà phê",
    },
    { msg: "trung tâm gần đây ko, đỗ xe tiện ko", expect: "vị trí + bãi đỗ xe rộng" },
    { msg: "thôi để c thử 1 buổi xem", expect: "mời trải nghiệm miễn phí + suất giới hạn nhẹ" },
    { msg: "rủ thêm đứa bạn nữa được ko", expect: "ưu đãi nhóm" },
    { msg: "ok qua thử", expect: "hỏi NGÀY trước" },
    { msg: "sáng chủ nhật nhé", expect: "mới xin tên + SĐT" },
    { msg: "Hương 0987654321", expect: "xác nhận giữ slot → DỪNG" },
    { msg: "tới đó có cần mang đồ bơi ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "ok thanks e", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 💪 GYM — GYM thuần · đã biết tập · soi CƠ SỞ VẬT CHẤT (fitness)
//    🖼 CHỦ ĐỘNG x2: ảnh PHÒNG GYM (hỏi phòng/máy) + before-after (nghi ngờ kết quả).
// ════════════════════════════════════════════════════════════════════════════
const GYM: Scenario = {
  id: "GYM",
  title: "💪 GYM — Gym thuần · đã biết tập · hỏi cơ sở vật chất (fitness)",
  flow: "fitness",
  goal: "Khách gym có kinh nghiệm, soi CSVC (phòng/máy) → 🖼 ảnh phòng gym → InBody tối ưu giáo án → 🖼 before-after khi nghi ngờ → thẻ hội viên + hé gói → chốt ngày tách lead.",
  turns: [
    { msg: "shop ơi", expect: "chào mở đầu" },
    { msg: "a muốn đăng ký tập gym", expect: "xưng 'anh', hỏi mục tiêu / đã tập chưa, chưa giá" },
    {
      msg: "tập lâu rồi, giờ muốn kiếm phòng gần nhà tập cho đều",
      expect: "ĐÃ biết tập → hỏi mục tiêu hiện tại (giữ dáng/tăng cơ), dẫn value, KHÔNG ép PT người mới",
    },
    {
      msg: "chủ yếu duy trì với tăng cơ tay vai thôi",
      expect: "note mục tiêu, gợi InBody để tối ưu giáo án theo điểm yếu",
    },
    {
      msg: "phòng có rộng ko, máy móc đầy đủ ko e",
      expect: "🖼 CHỦ ĐỘNG gửi ảnh PHÒNG GYM (mô tả 700m2 + máy hãng đầy đủ) — khách soi CSVC",
    },
    {
      msg: "máy có mới ko hay cũ kỹ rồi",
      expect: "khẳng định máy hãng/bảo trì định kỳ; có thể nhắc ảnh vừa gửi, KHÔNG gửi lại ảnh gym",
    },
    {
      msg: "có HLV hướng dẫn ko hay vào tự tập",
      expect: "linh hoạt: có PT kèm + có thể tự tập theo thẻ, tùy nhu cầu (khách đã biết tập)",
    },
    {
      msg: "tập gym mấy năm mà a vẫn ko lên cơ mấy, ở đây khác gì",
      expect: "🖼 CHỦ ĐỘNG gửi before-after (khách nghi ngờ kết quả) + trấn an: InBody + giáo án đúng điểm yếu",
    },
    {
      msg: "thế thẻ tập nhiêu tiền 1 năm",
      expect: "báo gói anchor hợp nhất + giá (Gym/Full 12 tháng…), hé gói nhẹ. KHÔNG đổ hết bảng",
    },
    {
      msg: "có gói ngắn hơn ko, sợ ko đi đều",
      expect: "hé gói 1-3 tháng — KHÔNG bịa số, đúng bảng giá",
    },
    { msg: "phòng ở đâu, đỗ ô tô dc ko", expect: "địa chỉ + bãi đỗ ô tô/xe máy rộng" },
    { msg: "mở cửa mấy giờ", expect: "giờ (5h–20h30), KHÔNG trả bằng bảng giá" },
    { msg: "ok thử 1 buổi xem phòng thế nào", expect: "mời trải nghiệm miễn phí (InBody + 1 buổi) + suất giới hạn nhẹ" },
    { msg: "qua thử", expect: "hỏi NGÀY (không 'tiện hôm nào')" },
    { msg: "cuối tuần", expect: "mơ hồ → CHỌN 1-trong-2 ngày cụ thể" },
    { msg: "thứ 7 nhé", expect: "mới xin tên + SĐT (tách khỏi ngày)" },
    { msg: "Khoa 0903335577", expect: "xác nhận giữ slot → DỪNG" },
    { msg: "cần mang giày tập riêng ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "ok cảm ơn e", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🏊 POOL — BƠI · bể 4 mùa · giảm cân + thư giãn (fitness)
//    🖼 CHỦ ĐỘNG: ảnh BỂ BƠI khi khách soi bể (sạch ko / trong nhà hay ngoài trời).
// ════════════════════════════════════════════════════════════════════════════
const POOL: Scenario = {
  id: "POOL",
  title: "🏊 POOL — Bơi · bể 4 mùa (fitness)",
  flow: "fitness",
  goal: "Khách muốn bơi (giảm cân/thư giãn) → xác nhận có bể → 🖼 ảnh bể 4 mùa khi khách soi CSVC bể → tiện ích (tủ/tắm nóng) → gói có bể + giá → chốt ngày tách lead. KHÔNG bịa gói lẻ / lớp trẻ em.",
  turns: [
    { msg: "alo shop", expect: "chào mở đầu" },
    {
      msg: "bên mình có bể bơi ko, c muốn đi bơi cho khỏe với giảm cân",
      expect: "xưng 'chị', xác nhận CÓ bể, hỏi thêm mục tiêu (giảm cân/thư giãn/biết bơi chưa)",
    },
    {
      msg: "vừa muốn giảm cân vừa thư giãn, bơi cũng tàm tạm rồi",
      expect: "note mục tiêu, dẫn value bơi (đốt calo nhiều, nhẹ khớp hợp người thừa cân)",
    },
    {
      msg: "bể có sạch ko, nước nôi thế nào e",
      expect: "🖼 CHỦ ĐỘNG gửi ảnh BỂ BƠI (bể 4 mùa, lọc tuần hoàn, nước ấm mùa đông) — khách soi CSVC bể",
    },
    {
      msg: "bể trong nhà hay ngoài trời v",
      expect: "trả lời (bể 4 mùa, có mái/ấm quanh năm); có thể nhắc ảnh vừa gửi, KHÔNG gửi lại ảnh bể",
    },
    {
      msg: "có HLV dạy bơi ko hay tự bơi thôi",
      expect: "có lớp/HLV hướng dẫn + bơi tự do theo thẻ, tùy nhu cầu",
    },
    {
      msg: "tắm tráng với tủ đồ có sẵn ko",
      expect: "tiện ích: phòng thay đồ, tủ khóa, tắm nước nóng — không gian sạch sẽ",
    },
    { msg: "thế gói có bể bao nhiêu tiền", expect: "báo gói có bể (Full/bơi) anchor + giá, hé gói nhẹ" },
    {
      msg: "có gói riêng cho mỗi bơi ko hay phải mua full",
      expect: "trả lời TRUNG THỰC (Full gồm bể / nếu có gói lẻ thì báo, KHÔNG chắc thì để sale tư vấn) — KHÔNG bịa giá",
    },
    { msg: "bể có đông ko, sợ chen chúc lắm", expect: "trấn an khung giờ vắng/đông, mời canh giờ phù hợp" },
    { msg: "trung tâm ở đâu, đỗ xe dc ko", expect: "vị trí + bãi đỗ xe rộng" },
    { msg: "thử 1 buổi bơi dc ko e", expect: "mời trải nghiệm + hỏi NGÀY mở" },
    { msg: "cuối tuần", expect: "mơ hồ → CHỌN 1-trong-2 ngày" },
    { msg: "chủ nhật nhé", expect: "mới xin tên + SĐT" },
    { msg: "Mai 0906112233", expect: "xác nhận giữ slot → DỪNG" },
    { msg: "mang đồ bơi với kính bơi đúng ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "ok cảm ơn e", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🧘 YOGA — YOGA nữ · giảm stress + dẻo · sinh viên (fitness)
//    🖼 CHỦ ĐỘNG: ảnh PHÒNG YOGA khi khách soi không gian/lớp.
// ════════════════════════════════════════════════════════════════════════════
const YOGA: Scenario = {
  id: "YOGA",
  title: "🧘 YOGA — Yoga nữ · giảm stress · sinh viên (fitness)",
  flow: "fitness",
  goal: "Khách yoga (dẻo/giảm stress, hay đau lưng) → value yoga → 🖼 ảnh phòng yoga khi soi không gian → lớp người mới → SV hỏi giá → báo THẲNG HS/SV → trung thực 'yoga ko phải để giảm cân nhanh' → chốt ngày tách lead.",
  turns: [
    { msg: "hi", expect: "chào mở đầu" },
    {
      msg: "c muốn tập yoga cho dẻo với đỡ stress",
      expect: "xưng 'chị', hỏi đã tập yoga chưa / mục tiêu, dẫn value yoga",
    },
    {
      msg: "mới tập, hay đau lưng do ngồi nhiều, muốn thư giãn là chính",
      expect: "note mục tiêu, dẫn value yoga (giãn cơ, giảm stress, cải thiện cột sống) — không đổ giá",
    },
    {
      msg: "lớp yoga ở đây thế nào, không gian có ổn ko e",
      expect: "🖼 CHỦ ĐỘNG gửi ảnh PHÒNG YOGA (phòng riêng yên tĩnh, sàn ấm/sạch) — khách soi không gian",
    },
    {
      msg: "có lớp cho người mới ko hay toàn người tập lâu",
      expect: "xác nhận có lớp cơ bản / chia trình độ cho người mới; có thể nhắc ảnh vừa gửi",
    },
    {
      msg: "giáo viên có kinh nghiệm ko e",
      expect: "GV chuyên môn (có GV nước ngoài), lớp dẫn dắt theo trình độ",
    },
    {
      msg: "1 tuần tập mấy buổi thì ổn",
      expect: "tư vấn 2-3 buổi/tuần cho người mới, dẫn về trải nghiệm thử",
    },
    {
      msg: "à mà c là sinh viên, có ưu đãi ko",
      expect: "báo THẲNG bảng HS/SV — KHÔNG né 'xin SĐT để sale báo'",
    },
    {
      msg: "tập yoga có giảm cân ko e",
      expect: "TRUNG THỰC: yoga thiên dẻo/giảm stress/đốt nhẹ; muốn giảm cân rõ thì kết hợp Gym/Zumba — KHÔNG bịa",
    },
    { msg: "thế gói yoga nhiêu", expect: "báo gói/giá anchor (hoặc HS/SV đã báo), hé gói nhẹ, KHÔNG đổ hết" },
    { msg: "phòng tập ở đâu, đỗ xe sao", expect: "vị trí + bãi đỗ xe rộng" },
    { msg: "ok thử 1 buổi xem hợp ko", expect: "mời trải nghiệm + hỏi NGÀY mở" },
    { msg: "cuối tuần này", expect: "mơ hồ → CHỌN 1-trong-2 ngày" },
    { msg: "thứ 7 đi e", expect: "mới xin tên + SĐT" },
    { msg: "Linh 0908224466", expect: "xác nhận giữ slot → DỪNG" },
    { msg: "đi tập cần mang thảm riêng ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "ok cảm ơn e", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🟢 GIAICO — GIẢI CƠ · đau cổ vai gáy văn phòng (giai-co)
//    Nhịp top-human: T1 ĐỒNG CẢM + 1 câu hiểu (⛔ chưa nút thắt/contrast/giờ) →
//    hiểu đủ mới giải thích cơ chế + mời thử mềm → 🖼 CHỦ ĐỘNG mr-neck-shoulder khi nghi ngờ.
// ════════════════════════════════════════════════════════════════════════════
const GIAICO: Scenario = {
  id: "GIAICO",
  title: "🟢 GIAICO — Giải cơ · đau cổ vai gáy văn phòng (giai-co)",
  flow: "giai-co",
  goal: "Mở cụt 'hơi đau cổ' → ĐỒNG CẢM + đào painArea/spread/duration → giải thích trigger point (khác massage) → trấn an đau → 🖼 before-after giải cơ khi nghi ngờ → giá 1 buổi answer-first → chốt giờ KHI khách tỏ ý đến → tách ngày khỏi lead.",
  turns: [
    { msg: "em ơi", expect: "chào mở, mềm, hỏi giúp được gì" },
    {
      msg: "dạo này a hay đau mỏi cổ vai gáy",
      expect: "xưng 'anh', ⛔ ĐỒNG CẢM ngắn 1 câu + hỏi 1 câu HIỂU (lan/1 điểm | lâu chưa | ngồi nhiều). KHÔNG phán 'nút thắt/điểm kẹt', KHÔNG contrast xoa-ngoài, KHÔNG mời thử, KHÔNG hỏi giờ",
    },
    {
      msg: "ngồi máy tính cả ngày, cổ với bả vai cứng đơ",
      expect: "ACK, hỏi thêm 1 câu hiểu (đau lan xuống vai hay chỉ ở cổ / bao lâu rồi). Vẫn CHƯA pitch cơ chế/giá",
    },
    {
      msg: "lan xuống cả bả vai, có lúc tê tê cánh tay, mấy tuần rồi",
      expect: "đủ painArea+spread+duration → GIỜ mới giải thích cơ chế NGẮN (cơ co rút/nút thắt) + contrast nhẹ + mời TRẢI NGHIỆM 1 buổi mềm. ⛔ KHÔNG hỏi 'sáng hay chiều' (khách chưa tỏ ý đến)",
    },
    {
      msg: "giải cơ là làm cái gì v e",
      expect: "answer-first: value gỡ nút thắt lớp cơ sâu, hình ảnh hóa. KHÔNG vội chốt giờ",
    },
    {
      msg: "có giống đấm bóp massage thường ko",
      expect: "phân biệt: trigger point xử lớp cơ sâu vs xoa bóp bề mặt; xử GỐC nên đỡ bền hơn",
    },
    {
      msg: "làm thế có đau ko em",
      expect: "trấn an: thốn ở điểm kẹt nhưng không quá ngưỡng chịu đựng",
    },
    {
      msg: "làm xong có hết hẳn ko hay lại đau lại",
      expect: "🖼 CHỦ ĐỘNG gửi before-after giải cơ (mr-neck-shoulder, khách nghi ngờ) + trấn an xử gốc rễ",
    },
    {
      msg: "1 buổi bao nhiêu tiền em",
      expect: "báo giá tham chiếu 1 BUỔI NGAY (answer-first), KHÔNG đổ gói 10 buổi",
    },
    {
      msg: "có phải làm nhiều buổi mới khỏi ko",
      expect: "KTV đánh giá tại chỗ rồi tư vấn lộ trình, mời THỬ 1 buổi trước",
    },
    {
      msg: "trung tâm ở đâu, mấy giờ mở cửa",
      expect: "địa chỉ (Kim Ngọc, Vĩnh Phúc) + giờ 9h–23h",
    },
    {
      msg: "ok để thử 1 buổi xem sao",
      expect: "GIỜ mới có tín hiệu mua → mời + HỎI NGÀY MỞ ('anh tiện qua hôm nào ạ')",
    },
    { msg: "chắc cuối tuần", expect: "cửa sổ mơ hồ → CHỌN 1-trong-2 ngày cụ thể" },
    { msg: "chủ nhật đi em", expect: "mới xin tên + SĐT (TÁCH khỏi ngày)" },
    { msg: "Nam 0912345678", expect: "xác nhận giữ slot 1 câu → DỪNG (không tự gợi QR)" },
    {
      msg: "đến chỉ cần mặc đồ thoải mái thôi đúng ko e",
      expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info, KHÔNG pitch lại",
    },
    { msg: "ok cảm ơn em", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🔀 DOIFLOW — ĐỔI FLOW giữa chừng: gym → hỏi giải cơ (fitness ↔ giai-co)
//    CANH BUG flow-flip: khách mở bằng gym rồi quay sang đau vai hỏi giải cơ →
//    bot phải CHUYỂN sang giai-co, KHÔNG lật về báo giá gym; vẫn NHỚ nhu cầu gym.
// ════════════════════════════════════════════════════════════════════════════
const DOIFLOW: Scenario = {
  id: "DOIFLOW",
  title: "🔀 DOIFLOW — Đổi flow gym → giải cơ giữa chừng (fitness↔giai-co)",
  flow: "fitness",
  goal: "Khách mở gym tăng cơ → giữa chừng than đau vai hỏi giải cơ → nhận biết & CHUYỂN flow giai-co, đào vùng đau, KHÔNG lật về pitch/giá gym. Không lẫn 2 trung tâm; vẫn nhớ cả 2 nhu cầu.",
  turns: [
    { msg: "anh muốn tập gym tăng cơ", expect: "fitness funnel mở, xưng 'anh', hỏi cao–nặng/mục tiêu" },
    { msg: "1m75 65kg, muốn lên cơ cho săn chắc", expect: "hỏi vùng tự ti / thói quen, chưa giá" },
    {
      msg: "à mà dạo này anh hay đau bả vai gáy, bên mình có dịch vụ giải cơ ko",
      expect: "🔑 nhận biết nhu cầu GIẢI CƠ → xác nhận có (Spa Hoa Sen), bắt đầu đào sâu vùng đau. CHUYỂN flow giai-co. ⛔ KHÔNG quay lại pitch/báo giá gym",
    },
    {
      msg: "ừ đau bả vai phải, ngồi máy tính nhiều, mấy tuần rồi",
      expect: "giai-co discovery (painArea+spread+duration). ⛔ KHÔNG lật về fitness, KHÔNG hỏi InBody",
    },
    {
      msg: "đi massage thường đỡ được hôm trước hôm sau lại đau",
      expect: "đủ painPoint → pitch trigger point KHÁC massage bề mặt, mời TRẢI NGHIỆM mềm. Vẫn giai-co",
    },
    {
      msg: "làm xong có đỡ thật ko hay lại đau",
      expect: "🖼 CHỦ ĐỘNG before-after giải cơ (mr-neck-shoulder, nghi ngờ) + trấn an gốc rễ",
    },
    {
      msg: "1 buổi giải cơ nhiêu tiền e",
      expect: "báo giá 1 BUỔI giải cơ answer-first (giá Hoa Sen, KHÔNG nhầm bảng giá gym). KHÔNG đổ gói 10",
    },
    {
      msg: "thế tập gym với giải cơ có làm cùng được ko",
      expect: "🔑 NHỚ CẢ 2 nhu cầu: trả lời được (gym Fami + giải cơ Hoa Sen), KHÔNG lẫn lộn 2 nơi",
    },
    { msg: "ok để thử buổi giải cơ trước xem sao", expect: "tín hiệu mua giai-co → mời + HỎI NGÀY mở" },
    { msg: "cuối tuần", expect: "mơ hồ → CHỌN 1-trong-2 ngày" },
    { msg: "chủ nhật nhé", expect: "mới xin tên + SĐT" },
    { msg: "Sơn 0904556677", expect: "xác nhận giữ slot → DỪNG" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🧊 DEDAT — GIẢI CƠ · đau chân/thắt lưng · khách DÈ DẶT "để xem đã" (giai-co)
//    CANH BUG giục-chốt (guard G6): khách CHƯA mua, nói "để xem đã" → bot KHÔNG
//    được hỏi giờ/ép chốt; giữ ấm, hạ áp lực. Cân bằng giai-co (vùng chân → mr-sport).
// ════════════════════════════════════════════════════════════════════════════
const DEDAT: Scenario = {
  id: "DEDAT",
  title: "🧊 DEDAT — Giải cơ · chân/thắt lưng · khách dè dặt (chống giục chốt)",
  flow: "giai-co",
  goal: "Khách đau chân/thắt lưng, dè dặt: nói 'để xem đã' (CHƯA mua) → bot KHÔNG hỏi giờ/giục chốt, giữ ấm + value; vượt phản đối giá; chỉ chốt khi khách TỰ ngỏ thử → lead. Media mr-sport.",
  turns: [
    { msg: "hi shop", expect: "chào mở mềm, hỏi giúp được gì" },
    {
      msg: "a hay đau mỏi thắt lưng với bắp chân, đứng nhiều",
      expect: "xưng 'anh', ⛔ ĐỒNG CẢM + hỏi 1 câu hiểu (lan hay 1 vùng / lâu chưa). KHÔNG pitch trigger point/giá ngay tin đầu",
    },
    {
      msg: "căng cứng cả bắp chân, đứng bán hàng cả ngày, mấy tháng rồi",
      expect: "đủ painArea(chân/lưng)+duration → giải thích cơ chế NGẮN + value KTV tác động điểm kẹt lớp sâu. Mời thử MỀM. ⛔ chưa hỏi giờ",
    },
    {
      msg: "thôi để xem đã, chưa chắc qua được",
      expect: "🔑 CHỐNG GIỤC CHỐT: khách CHƯA mua → ⛔ KHÔNG hỏi 'sáng hay chiều'/ép giờ. Giữ ấm, hạ áp lực ('chưa cần quyết gì đâu'), để value lắng",
    },
    {
      msg: "giải cơ có giống đi đấm bóp bình thường ko",
      expect: "answer-first: KTV đào tạo giải phẫu, xử trigger point lớp sâu — khác xoa bóp bề mặt. KHÔNG giục",
    },
    {
      msg: "làm xong có đỡ thật ko",
      expect: "🖼 CHỦ ĐỘNG before-after giải cơ (mr-sport, vùng chân, nghi ngờ) + trấn an gốc rễ",
    },
    {
      msg: "1 buổi nhiêu, làm liệu trình rẻ hơn ko",
      expect: "báo giá 1 BUỔI answer-first + KTV đánh giá tại chỗ rồi tư vấn lộ trình, CHƯA ép gói 10",
    },
    {
      msg: "hơi đắt so với a nghĩ",
      expect: "reframe value (xử gốc, bền hơn massage lặp lại), KHÔNG hạ giá bừa, ⛔ KHÔNG giục chốt",
    },
    {
      msg: "thôi cho a thử 1 buổi xem hợp ko",
      expect: "GIỜ mới có tín hiệu mua → mời + HỎI NGÀY MỞ",
    },
    { msg: "đầu tuần sau", expect: "mơ hồ → CHỌN 1-trong-2 ngày cụ thể" },
    { msg: "thứ 3 nhé", expect: "mới xin tên + SĐT" },
    { msg: "Tuấn 0938765432", expect: "giữ slot → DỪNG" },
    {
      msg: "trước buổi cần khởi động hay nhịn ăn gì ko e",
      expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 💰 HOIGIA — PRICE-FIRST · hỏi giá phủ đầu + chê đắt + "để tính đã" (fitness)
//    Test answer-first: báo giá NGAY (không bắt khai cao-nặng trước) → reframe value
//    khi chê đắt (KHÔNG hạ giá/ly cà phê) → khách chần chừ thì KHÔNG nài, để ngỏ ấm.
// ════════════════════════════════════════════════════════════════════════════
const HOIGIA: Scenario = {
  id: "HOIGIA",
  title: "💰 HOIGIA — Hỏi giá phủ đầu + chê đắt + để tính đã (fitness)",
  flow: "fitness",
  goal: "Khách hỏi GIÁ ngay turn 1 → answer-first 1 gói anchor + giá (KHÔNG bắt khai cao-nặng trước). Chê đắt → reframe value, KHÔNG hạ giá/chia nhỏ ly cà phê. 'Để tính đã' → KHÔNG nài, mời thử free + để ngỏ ấm.",
  turns: [
    {
      msg: "gói tập gym bao nhiêu tiền 1 tháng v shop",
      expect: "answer-first: báo 1 gói anchor + giá NGAY, không né, ⛔ KHÔNG bắt khai cao-nặng/mục tiêu trước",
    },
    {
      msg: "sao đắt thế",
      expect: "reframe VALUE (700m2 / bể 4 mùa / đa môn / bãi đỗ), ⛔ KHÔNG hạ giá, ⛔ KHÔNG chia nhỏ 'mỗi ngày 1 ly cà phê'",
    },
    {
      msg: "có gói nào rẻ hơn ko",
      expect: "hé gói nhẹ hơn đúng bảng (Gym 12 tháng…) — KHÔNG bịa giá",
    },
    {
      msg: "sinh viên có ưu đãi riêng ko",
      expect: "báo THẲNG bảng HS/SV (1 tháng 700k…) — ⛔ KHÔNG né 'xin SĐT để sale báo'",
    },
    {
      msg: "thôi để anh tính đã",
      expect: "⛔ KHÔNG nài ép → mời thử 1 buổi free (InBody + buổi tập) + để ngỏ ấm, không pitch lại bảng giá",
    },
    {
      msg: "ừ để khi nào rảnh anh qua",
      expect: "chốt mềm: chào ấm, gợi nhắn lại khi tiện, KHÔNG xin SĐT dồn dập",
    },
  ],
};

export const SCENARIOS: Scenario[] = [
  TANGCAN,
  GIAMCAN,
  GYM,
  POOL,
  YOGA,
  GIAICO,
  DOIFLOW,
  DEDAT,
  HOIGIA,
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
}

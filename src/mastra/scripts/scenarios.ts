/**
 * scenarios.ts — KỊCH BẢN TEST LUỒNG LỚN (single source of truth)
 *
 * Mỗi scenario = 1 cuộc thoại 1 mạch (1 thread), mô phỏng khách thật.
 * `expect` là kỳ vọng HÀNH VI bot ở turn đó — để soi mắt thường khi đọc log,
 * KHÔNG phải assertion tự động (funnel sale khó assert cứng, soi người vẫn chuẩn nhất).
 *
 * 2 flow trong hệ: "fitness" (Fami Gym+Yoga+Zumba+Bơi) và "giai-co" (Spa Hoa Sen).
 *
 * Chạy:
 *   npm run test:kichban             # liệt kê tất cả id
 *   npm run test:kichban -- L1       # chạy 1 luồng
 *   npm run test:kichban -- L3 E1    # chạy nhiều luồng
 *   npm run test:kichban -- all      # chạy tất cả (tốn token)
 *
 * Thêm luồng mới: append vào SCENARIOS. Giữ id ngắn, title rõ flow + chân dung khách.
 */

export type FlowKind = "fitness" | "giai-co";

export interface Turn {
  /** Tin khách gửi. */
  msg: string;
  /** Kỳ vọng hành vi bot (soi mắt). */
  expect: string;
}

export interface Scenario {
  /** Id ngắn để chọn chạy (vd "L1", "E3"). */
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
// 🅰️ LUỒNG 1 — TĂNG CÂN · khách CHƯA biết tập (fitness)
// ════════════════════════════════════════════════════════════════════════════
const L1: Scenario = {
  id: "L1",
  title: "🅰️ LUỒNG 1 — TĂNG CÂN · khách chưa biết tập (fitness)",
  flow: "fitness",
  goal: "Đào nỗi đau → InBody → nhấn cần PT+thực đơn (chưa biết tập) → before-after → giá có lớp lang → HS/SV không bịa → chốt ngày → lead.",
  turns: [
    { msg: "hi shop", expect: "chào mở đầu thân thiện" },
    {
      msg: "a muốn tập gym tăng cân, gầy mãi ko lên dc",
      expect: "xưng 'anh', hỏi cao–nặng. KHÔNG nhảy giá/InBody/lịch",
    },
    {
      msg: "1m70 52kg, muốn lên tầm 8kg",
      expect: "hỏi vùng tự ti (1 câu, có chủ ngữ 'Anh…')",
    },
    {
      msg: "người mỏng quá, ngực với vai lép nhìn thiếu sức sống",
      expect: "hỏi thói quen ăn uống/sinh hoạt",
    },
    {
      msg: "ăn cũng nhiều mà ko vào, hay bỏ bữa sáng, lại hay thức khuya",
      expect: "hỏi đã thử cách nào chưa",
    },
    {
      msg: "trước uống thuốc tăng cân bị tích nước, tự tập ở nhà mãi ko lên",
      expect: "ĐỦ nỗi đau → giờ mới pitch InBody (cơ thiếu/chuyển hóa cơ bản)",
    },
    {
      msg: "mà a chưa tập gym bao giờ, ko biết bắt đầu kiểu gì",
      expect: "nhận tín hiệu CHƯA biết tập → nhấn cần PT + thực đơn 5-6 bữa",
    },
    {
      msg: "đo inbody là đo cái gì v e",
      expect: "giải thích value, KHÔNG hỏi 'sáng hay chiều', chưa báo giá",
    },
    {
      msg: "liệu tập có lên thật ko, t tập ở nhà mãi có thấy gì đâu",
      expect: "🖼 GỬI ẢNH BEFORE-AFTER (đang nghi ngờ) + trấn an",
    },
    {
      msg: "nhìn cũng ham, tập gym bao lâu thì lên dc e",
      expect: "trả lộ trình chung, dẫn về InBody/PT",
    },
    {
      msg: "thế gói tập nhiêu tiền",
      expect: "báo 1 gói hợp nhất + giá, rồi hé gói nhẹ hơn. KHÔNG đổ 3 gói",
    },
    {
      msg: "hơi cao, sinh viên có gói nào rẻ hơn ko",
      expect: "báo THẲNG bảng HS/SV (Full HS/SV 1 tháng 700k…) — KHÔNG né 'xin SĐT'",
    },
    {
      msg: "trung tâm ở đâu, có chỗ đỗ ô tô ko",
      expect: "địa chỉ + BÃI ĐỖ XE RỘNG ô tô/xe máy + không gian thoáng",
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
    { msg: "Toàn, 0901234567", expect: "xác nhận GIỮ SLOT 1 câu ngắn rồi DỪNG" },
    {
      msg: "đến mang theo gì ko e",
      expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info, KHÔNG pitch lại gói",
    },
    { msg: "ok cảm ơn e nhé", expect: "chào ấm, không lặp 'giữ slot… dừng'" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🅱️ LUỒNG 2 — GIẢM CÂN · khách ĐÃ biết tập (fitness) — mirror testLuong2GiamCan.ts
// ════════════════════════════════════════════════════════════════════════════
const L2: Scenario = {
  id: "L2",
  title: "🅱️ LUỒNG 2 — GIẢM CÂN · khách đã biết tập (fitness)",
  flow: "fitness",
  goal: "SAU SINH (an toàn) → InBody → THẺ HỘI VIÊN (không ép PT) → before-after → đa môn (zumba+bơi) → giá → reframe value → chốt ngày → lead.",
  turns: [
    { msg: "hi", expect: "chào mở đầu" },
    { msg: "c muốn giảm cân", expect: "xưng 'chị', hỏi cao–nặng / history" },
    { msg: "1m58 68kg, muốn giảm tầm 10kg", expect: "hỏi vùng tự ti" },
    { msg: "bụng với đùi nhiều mỡ lắm", expect: "hỏi thói quen sinh hoạt" },
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
      expect: "🖼 GỬI ẢNH BEFORE-AFTER (đang nghi ngờ) + trấn an",
    },
    { msg: "zumba có giảm cân ko e", expect: "kiến thức Zumba (giảm mỡ toàn thân + xả stress), gợi kết hợp Gym" },
    {
      msg: "c cũng thích bơi nữa, bên mình có bể ko",
      expect: "nhớ ĐA MÔN: xác nhận có bơi (bể 4 mùa) + nhớ cả giảm cân",
    },
    { msg: "thế gói full bao nhiêu 1 tháng", expect: "báo gói Full hợp nhất + giá, không đổ hết bảng" },
    {
      msg: "đắt thế e",
      expect: "reframe VALUE (700m2 + bể 4 mùa + GV Ấn Độ + bãi đỗ xe), KHÔNG hạ giá / chia nhỏ ly cà phê",
    },
    { msg: "trung tâm gần đây ko, đỗ xe tiện ko", expect: "vị trí + bãi đỗ xe rộng" },
    { msg: "thôi để c thử 1 buổi xem", expect: "mời trải nghiệm miễn phí + suất giới hạn nhẹ" },
    { msg: "rủ thêm đứa bạn nữa được ko", expect: "ưu đãi nhóm" },
    { msg: "ok qua thử", expect: "hỏi NGÀY trước" },
    { msg: "sáng chủ nhật nhé", expect: "mới xin tên + SĐT" },
    { msg: "Hương, 0987654321", expect: "xác nhận giữ slot → DỪNG" },
    { msg: "tới đó có cần mang đồ bơi ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "ok thanks e", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🟢 LUỒNG 3 — GIẢI CƠ · dân văn phòng đau cổ vai gáy (giai-co)
// ════════════════════════════════════════════════════════════════════════════
const L3: Scenario = {
  id: "L3",
  title: "🟢 LUỒNG 3 — GIẢI CƠ · dân văn phòng đau cổ vai gáy (giai-co)",
  flow: "giai-co",
  goal: "Đào painArea/painSpread/painDuration/pastMethod → pitch trigger point (khác massage thường) → trấn an đau → before-after → giá 1 buổi (không đổ gói 10) → trial → chốt ngày → lead.",
  turns: [
    { msg: "em ơi", expect: "chào mở, mềm, hỏi giúp được gì" },
    {
      msg: "anh bị đau mỏi cổ vai gáy mấy nay",
      expect: "xưng 'anh', hỏi sâu vùng đau. KHÔNG pitch dịch vụ/giá ngay",
    },
    {
      msg: "ngồi máy tính cả ngày, cổ với bả vai cứng đơ",
      expect: "ACK, hỏi đau lan ra xung quanh hay 1 điểm cố định (painSpread)",
    },
    {
      msg: "đau lan xuống cả bả vai, có lúc tê tê cánh tay",
      expect: "note painSpread (lan), hỏi đau bao lâu rồi (painDuration)",
    },
    {
      msg: "cũng vài tháng rồi, dạo này nặng hơn",
      expect: "mãn tính (KHÔNG cấp tính) → hỏi đã thử cách gì chưa (pastMethod)",
    },
    {
      msg: "đi massage thường với dán cao, đỡ hôm trước hôm sau lại đau",
      expect: "đủ painPoint → pitch giải cơ chuyên sâu (trigger point) KHÁC massage bề mặt",
    },
    {
      msg: "giải cơ là làm cái gì, có giống đấm bóp ko e",
      expect: "giải thích value (gỡ nút thắt lớp cơ sâu), hình ảnh hóa. KHÔNG vội chốt giờ",
    },
    {
      msg: "làm thế có đau ko em",
      expect: "trấn an: thốn ở điểm kẹt nhưng không quá ngưỡng",
    },
    {
      msg: "liệu làm xong có hết thật ko hay lại đau lại",
      expect: "🖼 GỬI ẢNH/MEDIA before-after (mr-neck-shoulder) + trấn an gốc rễ",
    },
    {
      msg: "1 buổi bao nhiêu tiền em",
      expect: "báo giá tham chiếu 1 BUỔI ngay (answer-first), KHÔNG đổ gói 10 buổi",
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
      msg: "thế để thử 1 buổi xem sao",
      expect: "mời + HỎI NGÀY mở ('anh tiện qua hôm nào ạ')",
    },
    { msg: "chắc cuối tuần", expect: "cửa sổ mơ hồ → CHỌN 1-trong-2 ngày cụ thể" },
    { msg: "chủ nhật đi em", expect: "mới xin tên + SĐT (tách khỏi ngày)" },
    { msg: "Nam, 0912345678", expect: "xác nhận giữ slot 1 câu → DỪNG" },
    {
      msg: "đến chỉ cần mặc đồ thoải mái thôi đúng ko e",
      expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info, KHÔNG pitch lại",
    },
    { msg: "ok cảm ơn em", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🟢 LUỒNG 4 — GIẢI CƠ · gym/chạy bộ cơ căng mãn (giai-co, media mr-sport)
// ════════════════════════════════════════════════════════════════════════════
const L4: Scenario = {
  id: "L4",
  title: "🟢 LUỒNG 4 — GIẢI CƠ · người tập gym/chạy bộ, cơ căng mãn (giai-co)",
  flow: "giai-co",
  goal: "Khách thể thao → giải cơ sâu hơn foam roller → media mr-sport → giá 1 buổi + lộ trình đánh giá tại chỗ → trial → lead.",
  turns: [
    { msg: "hi shop", expect: "chào mở mềm" },
    {
      msg: "anh tập gym với chạy bộ, dạo này đùi sau với thắt lưng căng cứng mãi ko giãn",
      expect: "xưng 'anh', hỏi sâu vùng căng. Chưa pitch/giá",
    },
    {
      msg: "kéo giãn với khởi động kỹ rồi mà vẫn đơ, tập nặng là tức",
      expect: "ACK, hỏi tình trạng này bao lâu rồi (painDuration)",
    },
    {
      msg: "cũng mấy tuần rồi, không phải mới bị",
      expect: "mãn tính → hỏi đã tự xử lý cách nào (pastMethod)",
    },
    {
      msg: "tự lăn foam roller với giãn cơ ở nhà mà ko ăn thua",
      expect: "pitch giải cơ sâu xử trigger point lớp sâu — hơn foam roller bề mặt",
    },
    {
      msg: "khác gì tự lăn foam ở nhà",
      expect: "value: KTV đào tạo giải phẫu, tác động ĐÚNG điểm kẹt lớp sâu",
    },
    {
      msg: "cho anh xem vài ca thể thao giống anh với",
      expect: "🖼 GỬI MEDIA mr-sport (khách xin trực tiếp)",
    },
    {
      msg: "1 buổi nhiêu, làm liệu trình có rẻ hơn ko",
      expect: "báo giá 1 buổi + đánh giá tại chỗ rồi tư vấn lộ trình, CHƯA ép gói 10",
    },
    { msg: "ok thử 1 buổi", expect: "hỏi NGÀY mở" },
    { msg: "đầu tuần sau", expect: "mơ hồ → CHỌN 1-trong-2 ngày" },
    { msg: "thứ 3 nhé", expect: "mới xin tên + SĐT" },
    { msg: "Tuấn, 0938765432", expect: "giữ slot → DỪNG" },
    { msg: "trước buổi có cần khởi động hay nhịn ăn gì ko em", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
    { msg: "thanks em", expect: "chào ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// 🟠 LUỒNG 5 — GIẢM CÂN · khách CHƯA biết tập (fitness, PT-heavy)
// ════════════════════════════════════════════════════════════════════════════
const L5: Scenario = {
  id: "L5",
  title: "🟠 LUỒNG 5 — GIẢM CÂN · khách chưa biết tập (fitness)",
  flow: "fitness",
  goal: "Đối chiếu L2: cùng mục tiêu giảm cân NHƯNG chưa biết tập → phải nhấn PT + lộ trình kèm cặp (KHÔNG đẩy thẻ hội viên tự tập như L2).",
  turns: [
    { msg: "alo shop ơi", expect: "chào mở" },
    { msg: "e muốn giảm mỡ bụng mà chưa biết tập gì", expect: "hỏi cao–nặng / mục tiêu, chưa giá" },
    { msg: "1m65 72kg, muốn về tầm 60kg", expect: "hỏi vùng tự ti" },
    { msg: "bụng dưới với bắp tay to lắm, mặc gì cũng xấu", expect: "hỏi thói quen sinh hoạt" },
    { msg: "làm văn phòng, lười vận động, hay trà sữa", expect: "hỏi đã thử cách nào chưa" },
    { msg: "tải app tập theo youtube mà nản, bỏ giữa chừng hoài", expect: "đủ nỗi đau → InBody + nhấn cần người kèm" },
    {
      msg: "thật ra e chưa đi phòng gym bao giờ, sợ vào ko biết dùng máy",
      expect: "CHƯA biết tập → trấn an + nhấn PT kèm cặp + thực đơn, KHÔNG đẩy 'tự tập thẻ hội viên'",
    },
    { msg: "có PT kèm thật ko hay vào tự bơi", expect: "khẳng định PT kèm 1-1 + lộ trình cá nhân hóa" },
    { msg: "tập với PT liệu có giảm thật ko", expect: "🖼 before-after + trấn an" },
    { msg: "gói có PT bao nhiêu", expect: "báo gói PT anchor + giá (PT 20 buổi 6tr…), hé gói nhẹ hơn" },
    { msg: "đắt quá so với ngân sách của e", expect: "reframe value / hé gói nhẹ, KHÔNG hạ giá bừa" },
    { msg: "thôi cho e thử 1 buổi xem hợp ko", expect: "mời trial free (InBody + buổi PT) + suất giới hạn nhẹ" },
    { msg: "ok qua thử", expect: "hỏi NGÀY mở" },
    { msg: "cuối tuần này", expect: "mơ hồ → CHỌN 1-trong-2 ngày" },
    { msg: "thứ 7", expect: "mới xin tên + SĐT" },
    { msg: "Linh, 0977222333", expect: "giữ slot → DỪNG" },
    { msg: "mặc đồ gì đi tập v e", expect: "sau chốt: trả lời tự nhiên" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ⚡ EDGE E1 — GIẢI CƠ CẤP TÍNH (an toàn): vừa bị, sưng nóng <72h → KHUYÊN NGHỈ
// ════════════════════════════════════════════════════════════════════════════
const E1: Scenario = {
  id: "E1",
  title: "⚡ EDGE 1 — GIẢI CƠ cấp tính <72h (giai-co, safety)",
  flow: "giai-co",
  goal: "Chấn thương CẤP (vừa bị, sưng nóng, đi không nổi) → KHUYÊN nghỉ 3-5 ngày + chườm đá + khám nếu nặng. TUYỆT ĐỐI KHÔNG mời giải cơ ngay / không chốt đơn.",
  turns: [
    {
      msg: "em ơi anh vừa bị lật cổ chân lúc đá bóng chiều nay, giờ sưng vù đi ko nổi",
      expect: "⚠ CẤP TÍNH → khuyên nghỉ 3-5 ngày + chườm đá + khám nếu nặng. KHÔNG mời giải cơ ngay, KHÔNG báo giá",
    },
    {
      msg: "thế lúc nào qua giải cơ được",
      expect: "hướng dẫn qua khi hết sưng nóng cấp (sau 3-5 ngày), chưa ép chốt ngày/lead",
    },
    { msg: "ok cảm ơn em", expect: "chào ấm, KHÔNG pitch gói" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ⚡ EDGE E2 — PRICE-FIRST + CHÊ ĐẮT (fitness)
// ════════════════════════════════════════════════════════════════════════════
const E2: Scenario = {
  id: "E2",
  title: "⚡ EDGE 2 — Hỏi giá ngay câu đầu + chê đắt (fitness)",
  flow: "fitness",
  goal: "Khách hỏi GIÁ ngay turn 1 → answer-first báo 1 gói anchor + giá (KHÔNG bắt khai báo cao-nặng trước). Chê đắt → reframe value, KHÔNG hạ giá / chia nhỏ ly cà phê.",
  turns: [
    { msg: "gói tập gym bao nhiêu tiền 1 tháng v shop", expect: "answer-first: báo 1 gói anchor + giá NGAY, không né, không bắt khai cao-nặng trước" },
    { msg: "sao đắt thế", expect: "reframe VALUE (700m2 / bể 4 mùa / đa môn / bãi đỗ), KHÔNG hạ giá, KHÔNG chia nhỏ ly cà phê" },
    { msg: "có gói nào rẻ hơn ko", expect: "hé gói nhẹ hơn (Gym 4.5tr/12 tháng…) — KHÔNG bịa giá" },
    { msg: "thôi để anh tính đã", expect: "KHÔNG nài ép, mời thử buổi free + để ngỏ ấm" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ⚡ EDGE E3 — HỌC SINH/SINH VIÊN + YOGA nữ (fitness, pricing thật)
// ════════════════════════════════════════════════════════════════════════════
const E3: Scenario = {
  id: "E3",
  title: "⚡ EDGE 3 — Sinh viên hỏi Yoga + giá HS/SV (fitness)",
  flow: "fitness",
  goal: "Khách SV hỏi ưu đãi → báo THẲNG bảng HS/SV (Full HS/SV 1 tháng 700k / 3 tháng 2tr / 6 tháng 3tr / 12 tháng 4tr). TUYỆT ĐỐI KHÔNG né 'xin SĐT' khi đã có bảng HS/SV.",
  turns: [
    { msg: "chị muốn tập yoga cho dẻo với giảm stress", expect: "xưng 'chị', hỏi sâu (đã tập yoga chưa / mục tiêu), dẫn value yoga" },
    { msg: "mới tập, chủ yếu muốn thư giãn với gọn eo", expect: "note mục tiêu, dẫn value yoga, chưa đổ giá" },
    { msg: "à mà chị là sinh viên, có giá ưu đãi ko", expect: "báo THẲNG bảng HS/SV — KHÔNG né 'xin SĐT để sale báo'" },
    { msg: "có lớp yoga riêng cho người mới ko", expect: "xác nhận có lớp nhóm/cơ bản cho người mới" },
    { msg: "ok để qua thử 1 buổi", expect: "mời trial + hỏi NGÀY mở" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ⚡ EDGE E4 — KHÁCH DOANH NGHIỆP / công ty mua gói nhóm (fitness)
// ════════════════════════════════════════════════════════════════════════════
const E4: Scenario = {
  id: "E4",
  title: "⚡ EDGE 4 — Doanh nghiệp mua gói cho nhân viên (fitness)",
  flow: "fitness",
  goal: "Tín hiệu DOANH NGHIỆP → KHÔNG có bảng cố định → 'có ưu đãi riêng cho đoàn/công ty, xin SĐT em báo lại sale'. TUYỆT ĐỐI KHÔNG bịa số/người.",
  turns: [
    {
      msg: "bên anh là công ty, muốn mua gói tập cho nhân viên tầm 20 người",
      expect: "nhận tín hiệu doanh nghiệp → ưu đãi riêng cho đoàn, xin SĐT/đầu mối để sale báo. KHÔNG bịa bảng",
    },
    { msg: "tầm bao nhiêu 1 người", expect: "KHÔNG bịa số doanh nghiệp → xin đầu mối/SĐT để báo phương án cụ thể" },
    { msg: "ok số anh 0900111222, tên Hùng phòng HC", expect: "xác nhận đã ghi nhận, chuyển sale báo lại — DỪNG, không pitch gói lẻ" },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ⚡ EDGE E5 — ĐỔI FLOW giữa chừng: gym → hỏi giải cơ (fitness ↔ giai-co)
// ════════════════════════════════════════════════════════════════════════════
const E5: Scenario = {
  id: "E5",
  title: "⚡ EDGE 5 — Đổi flow giữa chừng + nhớ đa nhu cầu (fitness↔giai-co)",
  flow: "fitness",
  goal: "Khách mở bằng gym rồi quay sang đau vai hỏi giải cơ → nhận biết & chuyển flow giai-co, vẫn nhớ nhu cầu gym. Không lẫn lộn 2 trung tâm.",
  turns: [
    { msg: "anh muốn tập gym tăng cơ", expect: "fitness funnel mở, hỏi cao-nặng/mục tiêu" },
    {
      msg: "à mà dạo này anh hay đau vai gáy, bên mình có dịch vụ giải cơ ko",
      expect: "nhận biết nhu cầu giải cơ → xác nhận có, bắt đầu hỏi sâu vùng đau (có thể chuyển flow giai-co)",
    },
    { msg: "ừ đau bả vai phải, ngồi nhiều", expect: "giai-co discovery (painArea/painSpread), không bỏ rơi" },
    {
      msg: "thế tập gym với giải cơ có làm cùng được ko",
      expect: "trả lời được, NHỚ cả 2 nhu cầu (gym tăng cơ + giải cơ vai), không lẫn lộn",
    },
  ],
};

export const SCENARIOS: Scenario[] = [L1, L2, L3, L4, L5, E1, E2, E3, E4, E5];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());
}

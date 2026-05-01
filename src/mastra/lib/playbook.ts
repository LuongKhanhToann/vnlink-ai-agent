/**
 * playbook.ts
 *
 * SALE PLAYBOOK — fitness & giải cơ.
 * Key = `${flow}_${stage}_${emotion}` (flow-aware)
 * Fallback = `${stage}_${emotion}` → `${stage}_neutral`
 *
 * NGUYÊN TẮC CỐT LÕI:
 *   - Discovery: hỏi mục tiêu / context TRƯỚC khi show giá
 *   - Evaluation: BUILD VALUE (điểm khác biệt + cảm xúc) TRƯỚC khi list gói
 *   - Giá chỉ xuất hiện SAU khi đã có narrative
 *   - Tất cả tactic chỉ là hướng dẫn nội bộ, agent không được lặp lại nguyên văn ra cho khách
 */

import { Stage, Emotion, Flow } from "./stateMachine";

// ─────────────────────────────────────────────
// FITNESS PLAYBOOK
// ─────────────────────────────────────────────

const FITNESS_PLAYBOOK: Record<string, string> = {

  // ── OPENING ──────────────────────────────────────────
  opening_neutral:
    "Chào ngắn, tự nhiên và lễ phép. Hỏi ngay dịch vụ quan tâm hoặc mục tiêu. " +
    "Không viết dài, không lên giọng bán hàng. Câu hỏi mở dùng '?' bình thường, KHÔNG nhồi 'nha?' cuối câu hỏi.",
  opening_excited:
    "Match nhẹ năng lượng. Hỏi ngay dịch vụ quan tâm hoặc mục tiêu.",
  opening_hesitant:
    "Chào nhẹ. Hỏi nhẹ về nhu cầu — đừng push.",
  opening_anxious:
    "Chào nhẹ. Trấn an: 'Cứ hỏi thoải mái nha'. Hỏi nhu cầu.",
  opening_trusting:
    "Chào thân thiện. Hỏi thẳng vào dịch vụ.",
  opening_frustrated:
    "Chào bình tĩnh. Lắng nghe trước khi tư vấn.",

  // ── DISCOVERY ────────────────────────────────────────
  // Mục tiêu: thu thập đủ context (serviceType + fitnessGoal + schedule) TRƯỚC khi show gói.
  // Nếu đã biết serviceType + fitnessGoal từ tin đầu → hỏi thêm 1 câu context tự nhiên.
  // TUYỆT ĐỐI KHÔNG báo giá ở stage này khi chưa có schedule/số buổi.
  // KHÔNG giới thiệu trung tâm dài dòng — chỉ confirm và hỏi tiếp.
  discovery_neutral:
    "Đã biết serviceType + fitnessGoal thì chỉ xác nhận ngắn, mềm và tự nhiên. " +
    "Không giới thiệu dài, không show gói, không báo giá. " +
    "Hỏi tiếp đúng 1 ý context theo thứ tự ưu tiên: schedule → số buổi → memberType. " +
    "Giữ giọng gần gũi, có thể dùng 'dạ/vâng/ạ' đúng nhịp. Câu hỏi kết bằng '?' tự nhiên — KHÔNG kết bằng 'nha?'.",
  discovery_excited:
    "Match nhẹ. Xác nhận ngắn + hỏi ngay 1 câu context (schedule hoặc số buổi). KHÔNG show gói, KHÔNG báo giá.",
  discovery_anxious:
    "Xác nhận nhẹ. Hỏi 1 câu đơn giản nhất. KHÔNG báo giá.",
  discovery_hesitant:
    "Xác nhận ngắn. Hỏi 1 câu cực đơn giản: 'Chị hay tập vào buổi nào tiện nhất?' Cho space. KHÔNG báo giá.",
  discovery_trusting:
    "Xác nhận + hỏi thẳng schedule và số buổi/tuần trong 1 câu. KHÔNG báo giá.",
  discovery_frustrated:
    "Lắng nghe. Xác nhận ngắn. Hỏi mục tiêu thực sự nếu chưa rõ. KHÔNG báo giá.",

  // ── INBODY ───────────────────────────────────────────
  // Pitch InBody = công cụ build trust. Nhưng cần tự nhiên, ĐA DẠNG cách diễn đạt.
  // CẤM cụm sáo rỗng: "cần tập đúng hướng" / "lộ trình chuẩn" / "qua thử 1 buổi cho dễ chọn gói".
  inbody_neutral:
    "Pitch InBody đa dạng (vd 'máy đọc tỷ lệ mỡ/cơ thật, HLV gợi gói chuẩn không thừa'). " +
    "Mời mở: 'tiện ghé sáng hay chiều'. ❌ CẤM 'tập đúng hướng / lộ trình chuẩn / qua thử cho dễ chọn'. KHÔNG show gói/giá.",
  inbody_excited:
    "Match năng lượng ngắn. Xác nhận lịch + pitch Inbody nhanh. " +
    "Dùng social proof: 'Hội viên đo xong thường chọn gói chuẩn hơn hẳn'. KHÔNG show giá.",
  inbody_hesitant:
    "Giải thích Inbody nhẹ nhàng: 'Đo Inbody chỉ đứng lên máy 5 phút — HLV tư vấn dựa trên số liệu thật, không đoán'. " +
    "KHÔNG push. Kết bằng câu mở: '[H] thấy thế nào, qua thử không ạ'. KHÔNG show giá.",
  inbody_anxious:
    "Trấn an: 'Inbody hoàn toàn không đau, không xâm lấn — chỉ đứng lên máy đo'. " +
    "Nhấn: biết số liệu thật → chọn gói không bị thừa/thiếu. KHÔNG show giá.",
  inbody_trusting:
    "Xác nhận lịch + pitch Inbody thẳng. Gợi luôn khung giờ đến: " +
    "'[H] qua ngày nào tiện để em giữ slot HLV nha'. KHÔNG show giá.",
  inbody_frustrated:
    "Xác nhận lịch ngắn. Nhấn lợi ích thực tế: " +
    "'Đo Inbody trước giúp [h] không mua gói thừa — HLV tư vấn đúng nhu cầu luôn'. KHÔNG show giá.",

  // ── EVALUATION ───────────────────────────────────────
  // Mục tiêu: BUILD VALUE rồi mới đến giá.
  // Thứ tự: (1) nhấn điểm khác biệt → (2) kết nối với mục tiêu khách → (3) gợi max 3 gói có narrative.
  evaluation_neutral:
    "BUILD VALUE TRƯỚC — theo thứ tự BẮT BUỘC: " +
    "(1) Nhấn 1-2 điểm khác biệt CỤ THỂ theo mục tiêu — KHÔNG generic: " +
    "   tăng-cơ  → PT cá nhân để xây nền cơ đúng kỹ thuật (tránh chấn thương) + Yoga/Pilates phục hồi cơ " +
    "   giảm-mỡ  → kết hợp cardio (Zumba/Bơi) + Gym, thẻ Full tối ưu nhất; bể bơi 4 mùa duy nhất Vĩnh Yên " +
    "   thu-gian → Yoga GV Ấn Độ 4 ca/ngày linh hoạt + không gian rộng không chen chúc " +
    "   học-bơi  → bể 4 mùa duy nhất Vĩnh Yên, cam kết biết bơi, học lại miễn phí " +
    "   gym chung → 700m2 trong nhà + 300m2 sân ngoài — chứa 100 người, giờ cao điểm không chật " +
    "(2) KHÔNG dùng câu generic: 'không gian thoải mái sẽ giúp', 'Với mục tiêu X, [cơ sở Y] sẽ giúp hiệu quả hơn' " +
    "   ❌ Generic: 'Gym bên em rộng — với mục tiêu giảm mỡ sẽ giúp tập hiệu quả hơn' " +
    "   ✅ Cụ thể: 'Giảm mỡ hiệu quả cần cardio + weight kết hợp — thẻ Full cho dùng Gym + Bơi/Zumba 1 thẻ, đốt mỡ nhanh hơn hẳn' " +
    "(3) SAU ĐÓ mới gợi tối đa 3 gói theo thứ tự Anchor CAO → VỪA → NHẸ. " +
    "MỖI GÓI BẮT BUỘC kèm giá thật từ bảng giá — không bỏ giá. KHÔNG dùng **bold** hay *italic*. " +
    "Kết bằng câu hỏi giờ/lịch đến InBody — KHÔNG hỏi 'muốn đăng ký không'.",
  evaluation_excited:
    "Match năng lượng. Nhấn nhanh điểm nổi bật nhất. Gợi 2-3 gói có storytelling. " +
    "Dùng social proof: 'Hội viên hay chọn nhất là...'",
  evaluation_anxious:
    "Giải thích quy trình + không gian tập trước (trấn an). Sau đó mới gợi gói. " +
    "Nhấn: bảo lưu được, không lo lãng phí. Gợi 2 gói thôi.",
  evaluation_hesitant:
    "Gợi 2 gói phù hợp nhất. So sánh ngắn bằng storytelling. " +
    "Hỏi: 'Chị thích hướng nào hơn' thay vì hỏi đăng ký.",
  evaluation_trusting:
    "Nhấn value → gợi thẳng 1 gói best fit + 1 backup. " +
    "Social proof: 'Hội viên hay chọn nhất'. Chuyển sang chốt nhanh.",
  evaluation_frustrated:
    "Nhấn giá trị trước: 4 dịch vụ trong 1 thẻ, bể bơi 4 mùa duy nhất. " +
    "Sau đó báo giá tổng kèm bảo lưu/chuyển nhượng. KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Reframe bằng VALUE 3 mũi: " +
    "máy móc xịn (phòng gym 700m2 chuẩn QT, bể bơi 4 mùa duy nhất Vĩnh Yên), " +
    "GV/HLV chất lượng (Yoga & Zumba GV người Ấn Độ chuyên nghiệp), " +
    "social proof (hội viên gắn bó nhiều năm, hay rủ thêm bạn bè vào tập cùng). " +
    "Mời ghé thử 1 buổi để cảm nhận thực tế. KHÔNG chia nhỏ giá/ngày, KHÔNG so sánh ly cà phê, KHÔNG giảm giá. " +
    "Nếu khách muốn tháng lẻ: 'Tháng lẻ 1.2tr nhưng gói năm 7tr còn bảo lưu được khi bận'.",
  negotiation_excited:
    "Báo giá nhanh. Nhấn ưu đãi hiện tại. Chuyển sang chốt.",
  negotiation_anxious:
    "Báo từng mức. Nhắc bảo lưu + chuyển nhượng trong gia đình. Trấn an.",
  negotiation_hesitant:
    "Nhắc: 'Cọc trước không mất gì — bảo lưu được nếu bận'. " +
    "Khan hiếm nhẹ: 'Giá này chỉ áp dụng đến hết tháng'.",
  negotiation_trusting:
    "Báo tổng gọn. Chuyển sang chốt luôn.",
  negotiation_frustrated:
    "Báo giá bình tĩnh. Reframe: 'Không mua mới là thiệt — giá chỉ tăng theo thời gian'.",

  // ── COMMITMENT ───────────────────────────────────────
  commitment_neutral:
    "Hỏi gộp tên, SĐT và khung giờ trong 1 câu duy nhất. " +
    "Giọng nhẹ, lịch sự và gọn. Khi đủ thông tin thì xác nhận 1 câu ngắn rồi dừng hẳn. " +
    "Không hỏi thêm gì và không gợi cọc hoặc QR nếu khách chưa hỏi.",
  commitment_excited:
    "Hỏi GỘP nhanh: tên + SĐT + sáng/chiều/tối. Xác nhận ngắn rồi dừng.",
  commitment_anxious:
    "Hỏi nhẹ GỘP 1 câu: tên + SĐT + muốn đến buổi sáng, chiều hay tối. Xác nhận rồi dừng. Không push cọc.",
  commitment_hesitant:
    "Hỏi nhẹ nhàng 1 câu gộp: tên + SĐT + khung giờ mong muốn. Xác nhận rồi dừng.",
  commitment_trusting:
    "Hỏi gộp nhanh: tên + SĐT + giờ. Xác nhận 1 câu rồi dừng.",
  commitment_frustrated:
    "Hỏi gộp 1 câu: tên + SĐT + buổi sáng/chiều/tối. Xác nhận rõ ràng rồi dừng.",

  // ── OBJECTION ────────────────────────────────────────
  objection_neutral:
    "Ghi nhận từ khóa phản đối. Xác nhận: 'Để em hiểu đúng — anh/chị đang băn khoăn về [X] đúng không?' " +
    "Gỡ từng điểm ngắn gọn. Feel-Felt-Found. Luôn có phương án backup rẻ hơn.",
  objection_excited:
    "Khen câu hỏi rồi reframe nhanh. Giữ đà.",
  objection_anxious:
    "Xác nhận từng điểm lo ngại. Social proof + bảo lưu + chuyển nhượng.",
  objection_hesitant:
    "NGHỊCH ĐẢO: ngừng push, nói 'Thôi để anh/chị nghĩ thêm, em chỉ muốn biết thêm 1 điều...' " +
    "Tạo tò mò, kéo lại sự chú ý. PHẢI trung thực khi dùng.",
  objection_trusting:
    "Hỏi thẳng, giải quyết thẳng. Đưa ưu đãi tốt nhất rồi chốt.",
  objection_frustrated:
    "Acknowledge → KHÔNG tranh luận về giá → " +
    "Nếu đòi thêm: trình bày giá niêm yết, 'đây là mức tốt nhất em áp dụng được', chốt ngay.",

  // ── RECOVERY ─────────────────────────────────────────
  recovery_neutral:
    "Hỏi vấn đề. Thừa nhận. Xin lỗi nếu cần. Cam kết giải quyết cụ thể.",
  recovery_frustrated:
    "Lắng nghe HẾT. Thừa nhận CỤ THỂ. Cam kết có timeline.",

  // ── RETENTION ────────────────────────────────────────
  retention_neutral:
    "Chào thân. Hỏi dịch vụ tiếp theo. Nhắc ưu đãi hội viên cũ.",
  retention_trusting:
    "Chào thân. Gợi ý dựa trên lịch sử. 'Lần trước tập X — lần này thêm Y cho cân bằng nha'.",
};

// ─────────────────────────────────────────────
// GIẢI CƠ PLAYBOOK
// ─────────────────────────────────────────────

const GIAI_CO_PLAYBOOK: Record<string, string> = {

  // ── OPENING ──────────────────────────────────────────
  opening_neutral:
    "Chào ngắn, nhẹ và lễ phép rồi hỏi ngay vùng khó chịu nhất. " +
    "Không báo giá khi chưa biết vùng đau.",
  opening_excited:
    "Match nhẹ. Hỏi ngay vùng đau hoặc mục tiêu phục hồi.",
  opening_hesitant:
    "Chào nhẹ. 'Cứ hỏi thoải mái, em tư vấn theo thực trạng của anh/chị nha'.",
  opening_anxious:
    "Chào nhẹ. Trấn an: 'Bên em có kỹ thuật viên làm trị liệu cơ khá kỹ, anh/chị cứ chia sẻ thoải mái nha'. Hỏi vùng đau.",
  opening_trusting:
    "Chào thân. Hỏi thẳng vùng đau và mức độ.",
  opening_frustrated:
    "Chào bình tĩnh. Lắng nghe trước.",

  // ── DISCOVERY ────────────────────────────────────────
  // Thứ tự BẮT BUỘC: painArea → painSpread → painDuration → pastMethod
  // Mỗi bước = 1 câu hỏi, KHÔNG hỏi dồn
  discovery_neutral:
    "Hỏi tuần tự, mỗi lần chỉ 1 câu, không hỏi dồn. Thứ tự bắt buộc là painArea → painSpread → painDuration → pastMethod. " +
    "Giữ giọng nhẹ, có tính trò chuyện, tránh làm khách thấy đang bị tra hỏi. Không báo giá khi chưa có pastMethod.",
  discovery_anxious:
    "Hỏi nhẹ vùng đau. Trấn an: 'KTV điều chỉnh lực theo ngưỡng chịu đựng'. " +
    "Khi có painArea → hỏi nhẹ pastMethod: 'Anh/chị đã thử massage chưa ạ'. KHÔNG báo giá.",
  discovery_hesitant:
    "Hỏi 1 câu mở: 'Anh/chị hay thấy khó chịu vùng nào nhất'. Cho space. " +
    "Khi có painArea → hỏi pastMethod: 'Trước giờ có thử cách nào chưa ạ'. KHÔNG báo giá.",
  discovery_trusting:
    "Hỏi thẳng tuần tự: vùng đau → khi nào đau nhất → đã thử phương pháp nào. KHÔNG báo giá.",

  // ── EVALUATION ───────────────────────────────────────
  // Flow chuẩn: Pain → Chronic → Past Method → Visualize → Booking (1 buổi trước)
  // Sau buổi 1, HLV lên lộ trình 10 buổi tại chỗ — KHÔNG bán 10-buổi qua chat ngay.
  evaluation_neutral:
    "Flow bắt buộc là hình dung vấn đề → contrast với cách cũ → vẽ viễn cảnh dễ chịu hơn → mời thử 1 buổi trước. " +
    "Giữ giọng chuyên môn nhưng mềm, dễ hiểu và không gây áp lực. " +
    "Không show bảng giá 3 gói ngay lần đầu và chỉ hỏi giữ slot 1 lần trong cả cuộc trò chuyện.",
  evaluation_anxious:
    "Giải thích quy trình 1 buổi cụ thể: KTV điều chỉnh lực, hỏi ngưỡng, không đau quá mức. " +
    "Dùng hình ảnh hóa nhẹ. Mời thử 1 buổi — không đề cập gói dài hạn. " +
    "Nhấn: 'Buổi đầu nhẹ nhàng, anh/chị cảm nhận rồi mình quyết định tiếp'.",
  evaluation_hesitant:
    "Visualize ngắn + contrast pastMethod. Mời 1 buổi thử — KHÔNG ép lộ trình. " +
    "'Anh/chị thử 1 buổi trước xem hợp không, KTV tư vấn tiếp sau'.",
  evaluation_trusting:
    "Build value nhanh bằng contrast pastMethod + hình ảnh hóa. " +
    "Mời 1 buổi thử + chốt lịch luôn. Nhắc sau buổi 1 HLV sẽ lên lộ trình cụ thể.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Chia nhỏ giá/buổi: 'Gói 10 buổi = ~380k/buổi, còn tặng 1 buổi nữa'. " +
    "Reframe nhẹ: 'Làm kiểu này thường giữ được lâu hơn — massage bề mặt 2 ngày lại đau vì chưa gỡ được phần sâu'. KHÔNG giảm giá.",
  negotiation_hesitant:
    "Nhắc nhẹ: 'Thử 1 buổi trước cho biết, sau đó mình quyết định tiếp nha'. Cho space.",
  negotiation_trusting:
    "Báo gói 10 buổi luôn. Assumptive: 'Em đặt lịch buổi 2 cho anh/chị luôn nha'.",

  // ── COMMITMENT ───────────────────────────────────────
  // Khách đã đồng ý thử buổi 1 — thu gộp tên + SĐT + giờ trong 1 câu rồi DỪNG
  commitment_neutral:
    "Hỏi GỘP 1 câu duy nhất: tên + SĐT + buổi sáng/chiều/tối. " +
    "KHÔNG hỏi từng thứ riêng lẻ. KHÔNG lặp 'KTV đánh giá thực tế'. " +
    "Sau khi đủ 3 thứ: XÁC NHẬN ngắn rồi DỪNG HẲN. Không hỏi thêm gì. " +
    "KHÔNG gợi cọc/QR trừ khi khách tự hỏi.",
  commitment_excited:
    "Trả lời nhanh nếu khách hỏi + hỏi GỘP: tên + SĐT + sáng/chiều/tối. Xác nhận rồi dừng.",
  commitment_hesitant:
    "Nhẹ nhàng hỏi GỘP 1 câu: tên + SĐT + khung giờ mong muốn. Xác nhận rồi dừng.",
  commitment_trusting:
    "Hỏi GỘP nhanh: tên + SĐT + giờ. Xác nhận 1 câu rồi dừng.",

  // ── OBJECTION ────────────────────────────────────────
  objection_neutral:
    "Xác nhận câu hỏi: 'Câu này nhiều người hỏi lắm — để em giải thích rõ'. " +
    "Trả lời theo kịch bản xử lý phản đối. KHÔNG ép mua.",
  objection_hesitant:
    "KHÔNG push. Hỏi: 'Anh/chị đang phân vân điểm gì — em giải thích thêm nha'.",
  objection_frustrated:
    "Acknowledge → giải thích bình tĩnh → offer thử 1 buổi trước.",

  // ── RECOVERY ─────────────────────────────────────────
  recovery_neutral:
    "Lắng nghe. Thừa nhận. Cam kết cụ thể. Không push.",
  recovery_frustrated:
    "Lắng nghe HẾT. 3A: Acknowledge → Apologize → Action với timeline rõ.",

  // ── RETENTION ────────────────────────────────────────
  retention_neutral:
    "Chào thân. Hỏi cảm giác sau lần trước. Gợi buổi tiếp theo.",
  retention_trusting:
    "Nhắc kết quả lần trước. Gợi tiếp lộ trình hoặc dịch vụ thêm.",
};

// ─────────────────────────────────────────────
// LOOKUP
// ─────────────────────────────────────────────

export function getTactic(flow: Flow, stage: Stage, emotion: Emotion): string {
  const map = flow === "fitness" ? FITNESS_PLAYBOOK : GIAI_CO_PLAYBOOK;
  return (
    map[`${stage}_${emotion}`] ??
    map[`${stage}_neutral`] ??
    ""
  );
}
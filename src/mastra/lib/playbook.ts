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
 */

import { Stage, Emotion, Flow } from "./stateMachine";

// ─────────────────────────────────────────────
// FITNESS PLAYBOOK
// ─────────────────────────────────────────────

const FITNESS_PLAYBOOK: Record<string, string> = {

  // ── OPENING ──────────────────────────────────────────
  opening_neutral:
    "Chào ngắn 1 câu. Hỏi ngay dịch vụ quan tâm hoặc mục tiêu. " +
    "KHÔNG dùng dấu '?' riêng dòng — kết bằng 'nha' hoặc 'ạ'. KHÔNG giới thiệu dài dòng.",
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
    "Đã biết serviceType + fitnessGoal → KHÔNG giới thiệu trung tâm, KHÔNG show gói, KHÔNG báo giá. " +
    "Chỉ cần: xác nhận ngắn 1 câu ('dạ, giảm mỡ thì [h] tập gym là hợp lý rồi ạ') " +
    "rồi hỏi 1 câu context tiếp theo — ưu tiên theo thứ tự: " +
    "1. Chưa biết schedule → 'Chị hay tập vào khung giờ nào, sáng hay chiều tối ạ' " +
    "2. Chưa biết số buổi/tuần → 'Chị định tập mấy buổi một tuần?' " +
    "3. Chưa biết memberType → 'Chị tập cùng gia đình hay cá nhân thôi?' " +
    "Giữ câu xác nhận tự nhiên, ngắn, KHÔNG overload thông tin.",
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
  // Mục tiêu: pitch Inbody miễn phí — công cụ build trust + justify gói TRƯỚC khi show giá.
  // TUYỆT ĐỐI KHÔNG show gói/giá ở bước này.
  // Thứ tự: (1) xác nhận lịch tập 1 câu → (2) pitch Inbody → (3) câu mời nhẹ
  inbody_neutral:
    "Xác nhận lịch tập ngắn 1 câu (dùng thông tin schedule đã biết). " +
    "Sau đó pitch Inbody: 'Bên em đo Inbody miễn phí lần đầu — HLV phân tích mỡ/cơ tư vấn lộ trình luôn nha'. " +
    "Kết bằng câu mời nhẹ tự nhiên: '[H] qua thử 1 buổi trước cho dễ chọn gói nha'. " +
    "TUYỆT ĐỐI KHÔNG show gói/giá ở tin này.",
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
    "(3) SAU ĐÓ mới gợi tối đa 3 gói theo thứ tự Anchor cao → vừa → nhẹ. " +
    "KHÔNG dùng **bold** hay *italic*. Mỗi gói 1 câu lý do gắn với mục tiêu. " +
    "Kết bằng câu hỏi về lịch / số buổi — KHÔNG hỏi 'muốn đăng ký không'.",
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
    "Sau đó mới báo giá với chia nhỏ/ngày.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Chia nhỏ giá/ngày: 'Full 12 tháng chỉ ~19k/ngày — rẻ hơn ly cà phê mà sức khỏe cả năm'. " +
    "Nhấn giá trị: 4 dịch vụ, GV Ấn Độ, bể bơi 4 mùa. KHÔNG giảm giá. " +
    "Nếu khách muốn tháng lẻ: 'Tháng lẻ 1.2tr nhưng gói năm chỉ 583k/tháng — còn bảo lưu được'.",
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
    "Tóm tắt gói đã chọn. Soft close: 'Em ghi nhận cho anh/chị nha'. " +
    "KHÔNG hỏi 'muốn đăng ký không'. " +
    "Assumptive close: cư xử như đã chốt, hỏi tên/SĐT để 'hoàn thiện thủ tục'.",
  commitment_excited:
    "Tóm lại + match energy. 'Ok em làm thủ tục luôn nha!'",
  commitment_anxious:
    "Tóm tắt chi tiết. Nhắc bảo lưu + chính sách linh hoạt.",
  commitment_hesitant:
    "Assumptive nhẹ: 'Em giữ suất cho anh/chị nha — cọc nhỏ là chắc'.",
  commitment_trusting:
    "Chốt ngay: 'Ok em lên đơn luôn!'",
  commitment_frustrated:
    "Tóm tắt cẩn thận. Nhắc cam kết chất lượng.",

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
    "Chào ngắn, hỏi ngay: 'Anh/chị đang cảm thấy khó chịu ở vùng nào nhất'. " +
    "KHÔNG báo giá ngay khi chưa hỏi về vùng đau.",
  opening_excited:
    "Match nhẹ. Hỏi ngay vùng đau hoặc mục tiêu phục hồi.",
  opening_hesitant:
    "Chào nhẹ. 'Cứ hỏi thoải mái, em tư vấn theo thực trạng của anh/chị nha'.",
  opening_anxious:
    "Chào nhẹ. Trấn an: 'Bên em có KTV chuyên sâu, anh/chị yên tâm chia sẻ'. Hỏi vùng đau.",
  opening_trusting:
    "Chào thân. Hỏi thẳng vùng đau và mức độ.",
  opening_frustrated:
    "Chào bình tĩnh. Lắng nghe trước.",

  // ── DISCOVERY ────────────────────────────────────────
  // Thứ tự BẮT BUỘC: painArea → painSpread → painDuration → pastMethod
  // Mỗi bước = 1 câu hỏi, KHÔNG hỏi dồn
  discovery_neutral:
    "Hỏi tuần tự — 1 câu mỗi lần, KHÔNG hỏi dồn: " +
    "BƯỚC 1: Chưa biết painArea → hỏi vùng đau " +
    "BƯỚC 2: Biết painArea, chưa biết painSpread → hỏi: 'đau lan ra xung quanh hay một điểm cố định thôi ạ?' " +
    "BƯỚC 3: Biết painSpread, chưa biết painDuration → hỏi: 'cơn đau này đã bao lâu rồi / hay nhắc nhở lúc nào nhất?' " +
    "BƯỚC 4: Chưa biết pastMethod → HỎI BẮT BUỘC: 'Trước giờ anh/chị có đi massage hay dùng thuốc chưa — đỡ được lâu không?' " +
    "   pastMethod là bước mở khóa contrast quan trọng nhất — dùng câu trả lời để dẫn dắt: " +
    "   đã massage → 'Đúng, massage làm mềm bề mặt tạm thời, nhưng nút thắt sâu vẫn còn' " +
    "   chưa thử → 'Vậy là cơ thể anh/chị chưa được xử lý gốc lần nào' " +
    "TUYỆT ĐỐI KHÔNG hỏi BƯỚC 4 trước khi biết painSpread. KHÔNG báo giá khi chưa có pastMethod.",
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
    "THỨ TỰ BẮT BUỘC — visualize TRƯỚC, booking single session SAU: " +
    "(1) Dùng hình ảnh hóa phù hợp vùng đau (cầu dao điện / sợi guitar căng / cuộn len rối). " +
    "(2) CONTRAST với pastMethod đã biết: " +
    "   pastMethod=massage → 'Massage làm mềm bề mặt nhất thời — nút thắt sâu vẫn còn, đó là lý do đỡ rồi lại đau' " +
    "   pastMethod=chua-thu → 'Cơ thể anh/chị chưa được xử lý gốc lần nào — đây là lúc phù hợp nhất' " +
    "   pastMethod=thuoc → 'Thuốc giảm viêm bề mặt nhưng không gỡ được điểm kích hoạt bên trong' " +
    "(3) VẼ VIỄN CẢNH SAU KHI GỠ: 'Sáng dậy không còn cảm giác khựng / cứng cổ nữa'. " +
    "(4) Chỉ mời THỬ 1 BUỔI TRƯỚC — KHÔNG show gói 10 buổi ngay lần đầu. " +
    "   'Anh/chị thử 1 buổi trước — KTV đánh giá thực tế rồi tư vấn lộ trình phù hợp luôn'. " +
    "(5) Chốt lịch bằng Double Alternative: 'Sáng hay chiều tiện hơn cho anh/chị'. " +
    "KHÔNG show bảng giá 3 gói. Không làm khách cảm thấy đang bị bán.",
  evaluation_anxious:
    "Giải thích quy trình 1 buổi cụ thể: KTV điều chỉnh lực, hỏi ngưỡng, không đau quá mức. " +
    "Dùng hình ảnh hóa nhẹ. Mời thử 1 buổi — không đề cập gói dài hạn. " +
    "Nhấn: 'Buổi đầu nhẹ nhàng, anh/chị cảm nhận rồi mình quyết định tiếp'.",
  evaluation_hesitant:
    "Visualize ngắn + contrast pastMethod. Mời 1 buổi thử — KHÔNG ép lộ trình. " +
    "'Trải nghiệm 1 buổi xong KTV tư vấn tiếp, không cam kết gì trước'.",
  evaluation_trusting:
    "Build value nhanh bằng contrast pastMethod + hình ảnh hóa. " +
    "Mời 1 buổi thử + chốt lịch luôn. Nhắc sau buổi 1 HLV sẽ lên lộ trình cụ thể.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Chia nhỏ giá/buổi: 'Gói 10 buổi = ~380k/buổi, còn tặng 1 buổi nữa'. " +
    "Reframe: 'Không trả tiền cho thời gian, trả tiền cho kết quả bền vững'. " +
    "So sánh: 'Massage bề mặt 200k/lần mà 2 ngày đau lại — giải cơ xử lý tận gốc'. KHÔNG giảm giá.",
  negotiation_hesitant:
    "Nhắc: 'Thử 1 buổi trước, không cam kết liệu trình ngay'. Cho space.",
  negotiation_trusting:
    "Báo gói 10 buổi luôn. Assumptive: 'Em đặt lịch buổi 2 cho anh/chị luôn nha'.",

  // ── COMMITMENT ───────────────────────────────────────
  // Ngữ cảnh: khách đã đồng ý thử buổi 1 — đang chốt tên/SĐT/QR
  // KHÔNG lặp lại lý do tư vấn đã nói ở evaluation
  commitment_neutral:
    "Trả lời câu hỏi khách NGẮN GỌN (1 câu) — sau đó HỎI NGAY tên/SĐT để giữ slot. " +
    "TUYỆT ĐỐI KHÔNG lặp 'KTV sẽ đánh giá thực tế' / 'tư vấn lộ trình phù hợp' — đã nói rồi. " +
    "Assumptive close: cư xử như đã chốt, hỏi 'Cho em xin tên với SĐT để giữ slot [giờ] nha?'",
  commitment_excited:
    "Trả lời nhanh + hỏi tên/SĐT. Assumptive: 'Ok em giữ slot luôn — cho em tên với SĐT nha!'",
  commitment_hesitant:
    "Trả lời ngắn + soft: 'Cho em xin tên với SĐT để giữ slot trước, không cam kết gì thêm nha?'",
  commitment_trusting:
    "Chốt nhanh: trả lời 1 câu + hỏi tên/SĐT + giờ muốn đặt.",

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
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

  // ── EVALUATION ───────────────────────────────────────
  // Mục tiêu: BUILD VALUE rồi mới đến giá.
  // Thứ tự: (1) nhấn điểm khác biệt → (2) kết nối với mục tiêu khách → (3) gợi max 3 gói có narrative.
  evaluation_neutral:
    "BUILD VALUE TRƯỚC — theo thứ tự BẮT BUỘC: " +
    "(1) Nhấn 1-2 điểm khác biệt cụ thể của dịch vụ phù hợp mục tiêu khách " +
    "   (bể bơi 4 mùa duy nhất Vĩnh Yên / GV Ấn Độ 4 ca/ngày / Pilates máy quốc tế / Gym 700m2...) " +
    "(2) Kết nối điểm đó với mục tiêu khách: 'Với mục tiêu [X] của chị, [điểm khác biệt Y] sẽ giúp...' " +
    "(3) SAU ĐÓ mới gợi tối đa 3 gói theo thứ tự Anchor cao → vừa → nhẹ, có narrative. " +
    "KHÔNG liệt kê gói khô khan. Mỗi gói phải có 1 câu lý do tại sao phù hợp với khách. " +
    "Kết bằng câu hỏi dẫn dắt về lịch hoặc số buổi — KHÔNG hỏi 'muốn đăng ký không'.",
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
  discovery_neutral:
    "Dùng kịch bản mở khóa thực trạng — hỏi tuần tự (1 câu/lần): " +
    "1. Đau điểm cụ thể hay lan tỏa? " +
    "2. Đau từ bao lâu, hay nhắc nhở lúc nào nhất? " +
    "3. Đã thử massage thông thường chưa — hiệu quả kéo dài được bao lâu? " +
    "Dùng câu trả lời để dẫn dắt: đau lan = Referred Pain, đau mãn tính = nút thắt xơ hóa. " +
    "KHÔNG báo giá ở stage này.",
  discovery_anxious:
    "Hỏi nhẹ về vùng đau. Trấn an: 'KTV sẽ điều chỉnh lực phù hợp'. KHÔNG báo giá.",
  discovery_hesitant:
    "Hỏi 1 câu mở: 'Anh/chị hay thấy khó chịu vùng nào nhất'. Cho space. KHÔNG báo giá.",
  discovery_trusting:
    "Hỏi thẳng đủ 3 điểm: vùng đau, thời gian, đã thử phương pháp nào. KHÔNG báo giá.",

  // ── EVALUATION ───────────────────────────────────────
  evaluation_neutral:
    "BUILD VALUE TRƯỚC — theo thứ tự BẮT BUỘC: " +
    "(1) Dùng hình ảnh hóa phù hợp vùng đau (cầu dao điện / cuộn len rối / dòng sông bị đập). " +
    "(2) Giải thích TẠI SAO massage không đủ: 'Đau [vùng] lâu như vậy là nút thắt đã xơ hóa — " +
    "    massage bề mặt không thể gỡ được, phải vào tận lớp cơ sâu mới xử lý gốc'. " +
    "(3) SAU ĐÓ mới gợi tối đa 3 gói từ phù hợp nhất → nhẹ nhất. " +
    "Mỗi gói phải có 1 câu lý do tại sao phù hợp với vùng đau khách. " +
    "Nhấn ưu tiên gói 10 buổi nếu khách đã đau lâu. " +
    "Kết bằng Double Alternative Close: 'khung sáng hay chiều tiện hơn'.",
  evaluation_anxious:
    "Giải thích quy trình cụ thể: KTV điều chỉnh lực, hỏi ngưỡng chịu đựng. " +
    "Dùng hình ảnh hóa. Sau đó gợi gói nhẹ trước (lẻ hoặc 5 buổi). " +
    "Nhấn: 'Buổi đầu thường nhẹ 50-70% ngay'.",
  evaluation_hesitant:
    "Gợi thử 1 buổi lẻ trước: 'Hoàn toàn hợp lý — trải nghiệm xong tư vấn lộ trình tiếp'. " +
    "Không ép gói liệu trình ngay.",
  evaluation_trusting:
    "Build value nhanh. Gợi thẳng gói 10 buổi — đủ thấy kết quả bền vững. Anchor bằng giá/buổi.",

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
  commitment_neutral:
    "Kịch bản sau buổi 1: Re-test động tác → đo lại mức đau → giải thích lộ trình 10 buổi. " +
    "Soft close: 'Anh/chị muốn bắt đầu buổi 2 vào thứ mấy để cơ không kịp co rút lại'.",
  commitment_excited:
    "Assumptive close: 'Em đặt lịch buổi 2 luôn nha — thứ mấy tiện cho anh/chị'.",
  commitment_hesitant:
    "Double Alternative Close: '10h sáng hay 3h chiều hôm nay tiện hơn cho anh/chị'.",
  commitment_trusting:
    "Chốt ngay lịch buổi 2. 'Em giữ slot [giờ] — chuyển khoản cọc là chắc chỗ'.",

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
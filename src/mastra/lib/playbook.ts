/**
 * playbook.ts
 *
 * SALE PLAYBOOK — fitness & giải cơ.
 * Key = `${flow}_${stage}_${emotion}` (flow-aware)
 * Fallback = `${stage}_${emotion}` → `${stage}_neutral`
 */

import { Stage, Emotion, Flow } from "./stateMachine";

// ─────────────────────────────────────────────
// FITNESS PLAYBOOK
// ─────────────────────────────────────────────

const FITNESS_PLAYBOOK: Record<string, string> = {
  // ── OPENING ──────────────────────────────────────────
  opening_neutral:
    "Chào ngắn 1 câu, hỏi ngay dịch vụ quan tâm hoặc mục tiêu tập luyện. " +
    "KHÔNG dùng '?' — kết bằng 'nha' hoặc 'ạ'. KHÔNG giới thiệu dài dòng.",
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
  discovery_neutral:
    "ĐÃ BIẾT info → dùng luôn, gợi ý cụ thể. Chưa biết → hỏi 1 câu quan trọng nhất. " +
    "Thu thập: dịch vụ quan tâm, số buổi/tuần, khung giờ có thể tập, mục tiêu.",
  discovery_excited:
    "Gợi ngay hướng phù hợp. Hỏi gọn để xác nhận.",
  discovery_anxious:
    "Dùng info đã có, trấn an. Hỏi nhẹ 1 câu nếu còn thiếu.",
  discovery_hesitant:
    "Cho space. Hỏi 1 câu đơn giản nhất: 'Anh/chị đang quan tâm dịch vụ nào'",
  discovery_trusting:
    "Gợi ý thẳng. 'Em tư vấn luôn theo nhu cầu nha'",
  discovery_frustrated:
    "Lắng nghe. Sau đó hỏi về mục tiêu thực sự.",

  // ── EVALUATION ───────────────────────────────────────
  evaluation_neutral:
    "Chưa show gói → gửi tối đa 3 gói theo thứ tự Best→Better→Good. " +
    "Đã show rồi → KHÔNG show lại, tư vấn thẳng câu hỏi khách. " +
    "Anchoring: gợi gói cao trước để gói vừa trông 'hợp lý'. " +
    "Dùng Inbody như lý do: 'Đo Inbody miễn phí trước để em tư vấn gói chuẩn nhất'",
  evaluation_excited:
    "Gửi 2-3 gói. Nhấn gói Full — nhiều dịch vụ nhất, giá tốt nhất. Giữ năng lượng.",
  evaluation_anxious:
    "Gửi 2-3 gói. Giải thích ngắn từng gói. Nhấn 'bảo lưu được, không lo lãng phí'.",
  evaluation_hesitant:
    "Gửi 2 gói phù hợp nhất. So sánh ngắn. Hỏi 'Anh/chị thích hướng nào hơn'",
  evaluation_trusting:
    "Gợi thẳng 1 gói best fit. Kèm 1 backup. Social proof: 'hội viên hay chọn nhất'.",
  evaluation_frustrated:
    "Gửi 2-3 gói. Nhấn giá trị: 4 dịch vụ trong 1 thẻ, bể bơi duy nhất Vĩnh Yên.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Chia nhỏ giá/ngày: 'Full 12 tháng chỉ ~19k/ngày — rẻ hơn ly cà phê'. " +
    "Nhấn giá trị: 4 dịch vụ, GV Ấn Độ, bể bơi 4 mùa. KHÔNG giảm giá. " +
    "Nếu khách muốn tháng lẻ: 'Tháng lẻ đắt hơn nhiều, gói năm còn bảo lưu được'",
  negotiation_excited:
    "Báo giá nhanh. Nhấn ưu đãi hiện tại. Chuyển sang chốt.",
  negotiation_anxious:
    "Báo từng mức. Nhắc bảo lưu + chuyển nhượng. Trấn an.",
  negotiation_hesitant:
    "Nhắc: 'Book trước không mất gì — bảo lưu được nếu bận'. " +
    "Chiến thuật khan hiếm nhẹ: 'Giá này chỉ áp dụng đến hết tháng'",
  negotiation_trusting:
    "Báo tổng gọn. Chuyển sang chốt luôn.",
  negotiation_frustrated:
    "Báo giá bình tĩnh. Reframe: 'Không mua mới là thiệt — giá chỉ tăng theo thời gian'",

  // ── COMMITMENT ───────────────────────────────────────
  commitment_neutral:
    "Tóm tắt gói đã chọn. Soft close: 'Em ghi nhận cho anh/chị nha' KHÔNG hỏi 'muốn đăng ký không'. " +
    "Assumptive close: cư xử như đã chốt, hỏi tên/SĐT để 'hoàn thiện thủ tục'.",
  commitment_excited:
    "Tóm lại + match energy. 'Ok em làm thủ tục luôn nha!'",
  commitment_anxious:
    "Tóm tắt chi tiết. Nhắc bảo lưu + chính sách linh hoạt.",
  commitment_hesitant:
    "Assumptive nhẹ: 'Em giữ suất cho anh/chị nha — cọc nhỏ là chắc'",
  commitment_trusting:
    "Chốt ngay: 'Ok em lên đơn luôn!'",
  commitment_frustrated:
    "Tóm tắt cẩn thận. Nhắc cam kết chất lượng.",

  // ── OBJECTION ────────────────────────────────────────
  objection_neutral:
    "CUỐN SỔ TAY: Ghi nhận từ khóa phản đối của khách (ngắn gọn), " +
    "xác nhận lại: 'Để em hiểu đúng — anh/chị đang băn khoăn về [X] đúng không?' " +
    "Rồi gỡ từng điểm ngắn gọn, không giải thích dài. " +
    "Feel-Felt-Found. Luôn có phương án backup rẻ hơn.",
  objection_excited:
    "Khen ngợi câu hỏi rồi reframe nhanh: 'Câu này hay — thực ra đây là ưu điểm của bên em'. Giữ đà.",
  objection_anxious:
    "Xác nhận từng điểm lo ngại. Social proof + chính sách bảo lưu + chuyển nhượng.",
  objection_hesitant:
    "NGHỊCH ĐẢO khi gần thất bại: ngừng push, chuyển sang 'Thôi để anh/chị suy nghĩ thêm, " +
    "em chỉ muốn anh/chị biết thêm một điều trước khi quyết định...' — " +
    "tạo tò mò, kéo lại sự chú ý. PHẢI trung thực khi dùng chiến thuật này.",
  objection_trusting:
    "Hỏi thẳng, giải quyết thẳng. Đưa ra ưu đãi tốt nhất có thể rồi chốt ngay.",
  objection_frustrated:
    "Acknowledge → KHÔNG tranh luận về giá → " +
    "Case đặc biệt (quen sếp/đòi ưu đãi thêm): trình bày giá niêm yết trước, " +
    "đưa chương trình tốt nhất hiện có, chốt ngay không kéo dài.",

  // ── RECOVERY ─────────────────────────────────────────
  recovery_neutral:
    "Hỏi vấn đề. Thừa nhận. Xin lỗi nếu cần. Cam kết giải quyết cụ thể.",
  recovery_frustrated:
    "Lắng nghe HẾT. Thừa nhận CỤ THỂ. Cam kết có timeline.",

  // ── RETENTION ────────────────────────────────────────
  retention_neutral:
    "Chào thân. Hỏi dịch vụ tiếp theo. Nhắc ưu đãi hội viên cũ.",
  retention_trusting:
    "Chào thân. Gợi ý dựa trên lịch sử. 'Lần trước anh/chị tập X — lần này thêm Y cho cân bằng nha'",
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
    "Chào nhẹ. 'Cứ hỏi thoải mái, em tư vấn theo thực trạng của anh/chị nha'",
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
    "Dùng câu trả lời để dẫn dắt: đau lan = Referred Pain, đau mãn tính = nút thắt xơ hóa.",
  discovery_anxious:
    "Hỏi nhẹ về vùng đau. Trấn an bằng facts: 'KTV sẽ điều chỉnh lực phù hợp'.",
  discovery_hesitant:
    "Hỏi 1 câu mở: 'Anh/chị hay thấy khó chịu vùng nào nhất'. Cho space.",
  discovery_trusting:
    "Hỏi thẳng đủ 3 điểm: vùng đau, thời gian, đã thử phương pháp nào.",

  // ── EVALUATION ───────────────────────────────────────
  evaluation_neutral:
    "Personalize tư vấn theo vùng đau đã biết. " +
    "Dùng hình ảnh hóa: 'Đau vai gáy là Trigger Point — như cầu dao điện ở vai làm bóng đèn ở đầu sáng'. " +
    "Gợi tối đa 3 gói từ phù hợp nhất → nhẹ nhất. " +
    "Nhấn sự khác biệt: giải cơ xử lý gốc rễ, massage chỉ thư giãn tạm.",
  evaluation_anxious:
    "Giải thích quy trình cụ thể trước khi báo giá. Nhắc KTV điều chỉnh lực. " +
    "Tặng thêm: 'Buổi đầu thường nhẹ 50-70% ngay'.",
  evaluation_hesitant:
    "Gợi thử 1 buổi trước: 'Hoàn toàn hợp lý — trải nghiệm xong em tư vấn lộ trình tiếp'",
  evaluation_trusting:
    "Gợi thẳng gói 10 buổi — đủ thấy kết quả bền vững. Anchor bằng giá/buổi.",

  // ── NEGOTIATION ──────────────────────────────────────
  negotiation_neutral:
    "Chia nhỏ giá/buổi: 'Gói 10 buổi = ~380k/buổi, còn tặng 1 buổi'. " +
    "Reframe: 'Không trả tiền cho thời gian, trả tiền cho kết quả'. " +
    "So sánh: 'Massage bề mặt 200k/lần nhưng 2 ngày đau lại — giải cơ xử lý tận gốc'. " +
    "KHÔNG giảm giá.",
  negotiation_hesitant:
    "Nhắc: 'Thử 1 buổi trước, không cam kết liệu trình ngay'. Cho space.",
  negotiation_trusting:
    "Báo gói 10 buổi luôn. Assumptive: 'Em đặt lịch buổi 2 cho anh/chị luôn nha'",

  // ── COMMITMENT ───────────────────────────────────────
  commitment_neutral:
    "Kịch bản sau buổi 1: Re-test động tác → đo lại mức đau → giải thích lộ trình 10 buổi. " +
    "Soft close: 'Anh/chị muốn bắt đầu buổi 2 vào thứ mấy để cơ không kịp co rút lại'",
  commitment_excited:
    "Assumptive close: 'Em đặt lịch buổi 2 luôn nha — thứ mấy tiện cho anh/chị'",
  commitment_hesitant:
    "Double Alternative Close: '10h sáng hay 3h chiều hôm nay tiện hơn cho anh/chị'",
  commitment_trusting:
    "Chốt ngay lịch buổi 2. 'Em giữ slot [giờ] — chuyển khoản cọc là chắc chỗ'",

  // ── OBJECTION ────────────────────────────────────────
  objection_neutral:
    "Xác nhận câu hỏi: 'Câu này nhiều người hỏi lắm — để em giải thích rõ'. " +
    "Trả lời theo kịch bản xử lý phản đối (đau/ê ẩm/giá/bệnh lý/thời gian). " +
    "KHÔNG ép mua.",
  objection_hesitant:
    "KHÔNG push. Hỏi: 'Anh/chị đang phân vân điểm gì — em giải thích thêm nha'",
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
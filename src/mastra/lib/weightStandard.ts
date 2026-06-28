/**
 * weightStandard.ts
 *
 * BẢNG CÂN NẶNG CHUẨN theo CHIỀU CAO + GIỚI TÍNH (kg) — nguồn dữ liệu DUY NHẤT.
 *
 * Suy ra từ chỉ số BMI (cân nặng = BMI × cao(m)²):
 *   - Nam: BMI 21–25  (cân đối → săn chắc)
 *   - Nữ:  BMI 19–23  (thon gọn → cân đối)
 * Nam chuẩn cao hơn nữ cùng chiều cao vì khối cơ nhiều hơn.
 *
 * Vì sao deterministic (không để model tự tính cao−100):
 *   - Số liệu tư vấn PHẢI đúng & nhất quán giữa các lượt → cưỡng chế bằng bảng, mini-model
 *     chỉ ĐỌC mốc rồi diễn đạt, không làm phép tính dễ sai.
 *   - Dùng khi tư vấn giảm/tăng cân: đối chiếu chiều cao khách → nói mốc cân đối + lệch mấy kg,
 *     KHÔNG hỏi "muốn giảm/tăng xuống bao nhiêu" (khách không tự biết — mình tư vấn).
 *
 * Nội suy chiều cao lẻ; chưa rõ giới tính → nói khoảng chung hoặc ước theo ngữ cảnh.
 */
export const WEIGHT_STANDARD_HINT =
  "[BẢNG CÂN CHUẨN (kg) theo chiều cao — Nam | Nữ. Đối chiếu chiều cao khách → nêu mốc cân đối " +
  "rồi chỉ ra khách đang lệch mấy kg; ĐỪNG hỏi khách muốn nặng bao nhiêu:\n" +
  "150cm: 47-56 | 43-52\n" +
  "155cm: 50-60 | 46-55\n" +
  "160cm: 54-64 | 49-59\n" +
  "165cm: 57-68 | 52-63\n" +
  "170cm: 61-72 | 55-66\n" +
  "175cm: 64-77 | 58-70\n" +
  "180cm: 68-81 | 62-75\n" +
  "185cm: 72-86 | 65-79\n" +
  "Cao lẻ → nội suy; chưa rõ giới tính → ước theo ngữ cảnh hoặc nói khoảng chung.]";

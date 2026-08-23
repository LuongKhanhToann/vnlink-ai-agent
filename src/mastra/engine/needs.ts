/**
 * engine/needs.ts — L2: Bản đồ nhu cầu bề nổi / nhu cầu ẩn theo dịch vụ (Mục IV.1 của tài liệu).
 *
 * Dùng SỚM: ở các lượt đầu khách thường giấu mục tiêu (chưa đủ để bind kịch bản L3) — lúc đó bơm
 * needs-map để dẫn dắt theo "nhu cầu dự báo" đúng chỉ thị Mục IV.1. Nội dung giữ NGUYÊN VĂN tài liệu.
 * Tra trực tiếp theo service (≤ 8 bản ghi, KHÔNG vector, KHÔNG cache). Dịch vụ không có map riêng thì
 * KẾ THỪA map của dịch vụ gốc gần nhất.
 */

import type { ServiceCode } from "./taxonomy";

export interface NeedsMap {
  surface: string[]; // nhu cầu bề nổi
  hidden: string[]; // nhu cầu ẩn (tảng băng chìm)
  hiddenTitle?: string; // tiêu đề nhóm nhu cầu ẩn nếu tài liệu có đặt tên
}

/** 5 bản ghi gốc (Mục IV.1.1–IV.1.5). Các service khác kế thừa (xem INHERIT). */
const RECORDS: Partial<Record<ServiceCode, NeedsMap>> = {
  // IV.1.1 — Đăng ký học bơi cho con
  swim_kid: {
    surface: [
      "Kỹ năng sinh tồn: giúp con phòng chống tai nạn đuối nước.",
      "Phát triển thể chất: tăng trưởng chiều cao, cải thiện sức bền và độ dẻo dai.",
      "Giải trí lành mạnh: giúp con rời xa màn hình điện thoại, tivi.",
    ],
    hiddenTitle: "Sự an tâm và tự do tâm trí",
    hidden: [
      'Giải phóng nỗi sợ vô hình: cha mẹ luôn lo lắng thường trực về rủi ro quanh con. "Mua" khóa học bơi thực chất là "mua một tấm bảo hiểm tâm lý" — con biết bơi thì nỗi sợ mỗi khi con đi du lịch, dã ngoại, gần vùng sông nước được rũ bỏ.',
      "Sự tự do của cha mẹ: con tự bảo vệ được mình dưới nước thì cha mẹ bớt canh 24/7, có thêm thời gian và không gian tinh thần.",
    ],
  },
  // IV.1.2 — Đăng ký tập Gym
  gym: {
    surface: [
      "Thay đổi vóc dáng: muốn cơ bắp săn chắc, eo thon hoặc tăng cân theo ý muốn.",
      "Cải thiện sức khỏe: tăng sức bền, giảm nguy cơ bệnh tật, thêm năng lượng.",
      "Mục đích y tế: theo lời khuyên bác sĩ để phục hồi chấn thương hoặc trị bệnh.",
    ],
    hiddenTitle: "Nhu cầu ẩn quan trọng nhất",
    hidden: [
      "Xóa bỏ tự ti: muốn thay đổi vóc dáng quá gầy hoặc quá béo đang làm họ mặc cảm.",
      "Cải thiện mối quan hệ: vóc dáng đẹp tạo thuận lợi cho các mối quan hệ gia đình và công việc.",
      "Sự công nhận: hy vọng nhận lời khen ngợi tích cực từ người xung quanh về sự thay đổi.",
    ],
  },
  // IV.1.3 — Đăng ký dịch vụ bơi theo tháng hoặc năm
  swim_4season: {
    surface: [
      "Cải thiện thể chất: tăng sức bền, phát triển cơ bắp, giữ vóc dáng cân đối.",
      "Chăm sóc sức khỏe: giảm đau lưng, cải thiện hô hấp, phục hồi xương khớp.",
      "Tiết kiệm chi phí: mua gói tháng hoặc năm rẻ hơn vé lượt lẻ.",
      "Mục tiêu rõ ràng: hoàn thành mục tiêu biết bơi hoặc duy trì thói quen vận động mỗi ngày.",
    ],
    hiddenTitle: "Nhu cầu ẩn quan trọng nhất",
    hidden: [
      "Giảm tải tinh thần: tìm không gian riêng tư dưới nước để ngắt kết nối lo âu, áp lực công việc.",
      "Nhu cầu xã hội: gia nhập nhóm cùng sở thích, tạo dựng quan hệ mới tại câu lạc bộ bơi.",
      "Khẳng định bản thân: xây dựng hình ảnh người năng động, biết chăm sóc bản thân, lối sống lành mạnh.",
      "Thỏa mãn cảm giác kiểm soát: đi bơi đều đặn giúp thấy có kỷ luật, làm chủ cuộc sống tốt hơn.",
    ],
  },
  // IV.1.4 — Đăng ký dịch vụ Yoga
  yoga: {
    surface: [
      "Giảm đau lưng và vai gáy do ngồi văn phòng nhiều.",
      "Tăng cường sự dẻo dai, thăng bằng và sức mạnh cơ bắp.",
      "Giảm cân, giữ gìn vóc dáng thon gọn và săn chắc.",
      "Cải thiện chất lượng giấc ngủ và nâng cao sức đề kháng.",
    ],
    hiddenTitle: "Nhu cầu ẩn quan trọng nhất",
    hidden: [
      "Giải tỏa áp lực: tìm không gian trốn tránh căng thẳng từ công việc và cuộc sống.",
      "Kết nối bản thân: muốn tĩnh tâm, hiểu rõ hơn về cơ thể và cảm xúc của chính mình.",
      "Sự công nhận và thuộc về: muốn hòa nhập lối sống tích cực, có bạn đồng hành cùng tần số.",
      "Lấy lại quyền kiểm soát: tạo thói quen kỷ luật riêng để thấy cuộc sống có trật tự hơn.",
    ],
  },
  // IV.1.5 — Giải pháp Giảm cân (kiểm soát cân nặng) - cân bằng chuyển hóa
  weightloss_female: {
    surface: [
      "Giảm cân nặng và thu gọn vòng eo rõ rệt trong thời gian ngắn.",
      "Có ngay một giải pháp ăn uống, tập luyện dễ áp dụng hàng ngày.",
      "Tìm kiếm sản phẩm, thực đơn hoặc liệu trình cụ thể để kiểm soát cơn thèm ăn.",
      "Sở hữu vẻ ngoài thon gọn để tự tin mặc đồ và giao tiếp.",
    ],
    hiddenTitle: "Nhu cầu ẩn quan trọng nhất",
    hidden: [
      "Sợ hãi cảm giác đói lả, mệt mỏi hay tăng cân bù (hiệu ứng yoyo) sau khi ngừng ép cân.",
      "Mong mỏi một cơ chế chuyển hóa tự nhiên để ăn không lo béo, thay vì đếm từng calo suốt đời.",
      "Giải tỏa áp lực tâm lý, cảm giác tự ti về ngoại hình trước ánh nhìn của người khác.",
      "Khát khao sự thấu hiểu và đồng hành cá nhân hóa thay vì những lời khuyên chung chung.",
    ],
  },
};

/** Dịch vụ không có map riêng → kế thừa map của dịch vụ gốc gần nhất (Mục IV.1). */
const INHERIT: Record<ServiceCode, ServiceCode> = {
  swim_kid: "swim_kid",
  gym: "gym",
  swim_4season: "swim_4season",
  yoga: "yoga",
  weightloss_female: "weightloss_female",
  swim_adult: "swim_4season", // người lớn học bơi kế thừa nhu cầu bơi tháng/năm
  weightloss_male: "weightloss_female", // nam giảm cân dùng chung map giảm cân/chuyển hóa
  metabolic_male: "weightloss_female", // nam cân bằng chuyển hóa dùng chung map giảm cân/chuyển hóa
};

/** Tra needs-map cho 1 service (có kế thừa). null nếu service null/không xác định. */
export function needsMap(service: ServiceCode | null | undefined): NeedsMap | null {
  if (!service) return null;
  const src = INHERIT[service] ?? service;
  return RECORDS[src] ?? null;
}

/** Khối bơm vào prompt (≤ ~6 dòng). "" nếu không có map. */
export function needsBlock(map: NeedsMap | null): string {
  if (!map) return "";
  const surface = map.surface.map((s) => `• ${s}`).join("\n");
  const hidden = map.hidden.map((s) => `• ${s}`).join("\n");
  return `NHU CẦU DỰ BÁO CỦA KHÁCH (dùng để dẫn dắt khi khách chưa lộ mục tiêu — chạm đúng nhu cầu ẩn, đừng hỏi lộ liễu):
Bề nổi:
${surface}
Ẩn (${map.hiddenTitle ?? "tảng băng chìm"}):
${hidden}`;
}

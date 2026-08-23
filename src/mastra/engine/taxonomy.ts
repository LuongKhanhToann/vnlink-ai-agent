/**
 * engine/taxonomy.ts — Không gian nhãn phân loại (tập ĐÓNG) cho luồng kịch bản Fami.
 *
 * Nguồn: tài liệu "Định vị & Vai trò AI Agent" — Mục V (8 nhóm dịch vụ × ~50 tình huống).
 * Dùng ở 3 nơi: L5 (classifier chọn service/segment/objection), L3 (chọn kịch bản theo khoá),
 * L6 (kiểm ràng buộc theo stage). Tất cả là DỮ LIỆU tĩnh — đọc trực tiếp, KHÔNG vector, KHÔNG cache.
 *
 * Nguyên tắc (theo global rule của chủ dự án): việc GẮN nhãn là của model (classifier) qua prompt +
 * mô tả rõ ràng bên dưới, KHÔNG dùng keyword/regex để quyết định nghiệp vụ. Các trường `keywords`
 * chỉ là GỢI Ý ngữ cảnh bơm vào prompt classifier (đúng "Từ khóa bổ sung" của tài liệu), không phải
 * bộ lọc if/else.
 */

// ── Dịch vụ gốc (8 nhóm Mục V) ──
export const SERVICE_CODES = [
  "swim_kid", // 1.1 Bố mẹ quan tâm học bơi cho con
  "swim_adult", // 1.2 Người lớn học bơi
  "gym", // 1.3 Tập Gym
  "swim_4season", // 1.4 Bơi bốn mùa
  "yoga", // 1.5 Yoga
  "weightloss_male", // 1.6 Nam giảm cân
  "weightloss_female", // 1.7 Nữ giảm cân
  "metabolic_male", // 1.8 Nam giảm cân & cân bằng chuyển hóa
] as const;
export type ServiceCode = (typeof SERVICE_CODES)[number];

/** Nhãn tiếng Việt + "Từ khóa bổ sung" (Mục V) — bơm vào prompt classifier làm gợi ý, KHÔNG dùng làm bộ lọc. */
export const SERVICE_INFO: Record<ServiceCode, { label: string; keywords: string }> = {
  swim_kid: { label: "Học bơi cho con (trẻ em)", keywords: "học bơi cho trẻ em / trẻ con / cho bé / cho con" },
  swim_adult: {
    label: "Người lớn học bơi",
    keywords: "học bơi người lớn / khóa học bơi người lớn / người lớn đăng ký học bơi",
  },
  gym: { label: "Tập Gym", keywords: "gói gym / tập gym / phòng gym" },
  swim_4season: {
    label: "Bơi bốn mùa (bơi tháng/năm, bể nước ấm trong nhà)",
    keywords: "bơi năm / bơi bốn mùa / bơi tháng / vé bơi / bể bơi nước ấm",
  },
  yoga: { label: "Yoga", keywords: "yoga / tập yoga / lớp yoga" },
  weightloss_male: { label: "Nam giảm cân", keywords: "nam giảm cân / giảm mỡ bụng / bụng bia (nam)" },
  weightloss_female: { label: "Nữ giảm cân", keywords: "nữ giảm cân / giảm mỡ / lấy lại vóc dáng (nữ)" },
  metabolic_male: {
    label: "Nam giảm cân & cân bằng chuyển hóa",
    keywords: "rối loạn chuyển hóa / cân bằng chuyển hóa / mỡ nội tạng / gan nhiễm mỡ (nam)",
  },
};

// ── Phân khúc khách (thuộc tính phụ mô tả nhân khẩu/bối cảnh) ──
export const SEGMENT_CODES = [
  "phu_huynh",
  "nguoi_lon_tuoi",
  "nu_van_phong",
  "me_bim",
  "phu_nu_sau_sinh",
  "nu_trung_nien",
  "nam_trung_nien",
  "nam_doanh_nhan",
  "skinny_fat",
  "ex_athlete",
  "khac",
] as const;
export type SegmentCode = (typeof SEGMENT_CODES)[number];

export const SEGMENT_LABEL: Record<SegmentCode, string> = {
  phu_huynh: "phụ huynh tìm dịch vụ cho con",
  nguoi_lon_tuoi: "người lớn tuổi",
  nu_van_phong: "nữ nhân viên văn phòng",
  me_bim: "mẹ bỉm sữa (con nhỏ)",
  phu_nu_sau_sinh: "phụ nữ sau sinh",
  nu_trung_nien: "nữ trung niên",
  nam_trung_nien: "nam trung niên",
  nam_doanh_nhan: "nam doanh nhân",
  skinny_fat: "gầy nhưng mỡ bụng (skinny fat)",
  ex_athlete: "từng chơi thể thao, nay giảm phong độ",
  khac: "khác / chưa rõ",
};

// ── Rào cản / kiểu từ chối (KHOÁ CHÍNH để chọn kịch bản) ──
export const OBJECTION_CODES = [
  "price_probe",
  "price_hide_goal",
  "price_doubt_value",
  "price_compare",
  "procrastinate_busy",
  "fear_water",
  "fear_body_change",
  "fear_fail_yoyo",
  "trial_only",
  "medical_therapy",
  "silence_followup",
  "indecisive_service",
  "deny_need",
  "low_commitment",
  "belief_wrong_method",
  "savvy_defensive",
  "khac_khong_ro", // nhánh thoát bắt buộc — fail-open về L0 + L2
] as const;
export type ObjectionCode = (typeof OBJECTION_CODES)[number];

export const OBJECTION_DESC: Record<ObjectionCode, string> = {
  price_probe: "Hỏi dò giá / tìm gói rẻ, chưa lộ mục tiêu",
  price_hide_goal: "Hỏi giá nhưng giấu mục tiêu / nỗi đau thật",
  price_doubt_value: "Do dự về giá, chưa thấy giá trị toàn diện",
  price_compare: "So sánh giá với nơi khác / bể ngoài trời",
  procrastinate_busy: "Viện cớ bận rộn / trì hoãn (để hè, dạo này bận)",
  fear_water: "Nhát nước / sợ sặc / sợ nước sâu / sợ nước lạnh / sợ học lâu không biết bơi",
  fear_body_change: "Sợ tập nặng bị to cơ / đau mỏi / sợ mồ hôi",
  fear_fail_yoyo: "Từng thất bại nhiều lần, sợ hiệu ứng Yoyo / sợ mất tiền",
  trial_only: "Chỉ muốn tập thử ngắn hạn, ngại thẻ dài hạn",
  medical_therapy: "Đau khớp / thoát vị / sau sinh / bệnh lý, tìm giải pháp trị liệu",
  silence_followup: "Đã xem / đọc tin nhưng im lặng, cần bám đuổi",
  indecisive_service: "Đắn đo giữa hai dịch vụ (Gym hay Bơi)",
  deny_need: "Phủ nhận nhu cầu vóc dáng, nêu lý do khác (giãn gân cốt, dễ ngủ, cho khỏe, cho mát)",
  low_commitment: "Đăng ký cho có phong trào / thiếu cam kết",
  belief_wrong_method: "Niềm tin sai (nhịn ăn là được)",
  savvy_defensive: "Phòng thủ cao / tỏ vẻ sành sỏi, giấu thất bại cũ",
  khac_khong_ro: "Ngoài các mục trên — nhánh thoát",
};

// ── Kiến thức mồi (khái niệm chuyển hóa để giải thích — chỉ là TAG gợi ý cho model) ──
export const KNOWLEDGE_CODES = [
  "ty_the",
  "khang_insulin",
  "fructose",
  "cortisol",
  "hieu_ung_yoyo",
  "axit_lactic",
  "testosterone_nu",
  "he_vi_sinh",
  "mo_noi_tang",
  "tofi",
  "nan_doi_vi_chat",
] as const;
export type KnowledgeCode = (typeof KNOWLEDGE_CODES)[number];

// ── Bước bán hàng (Mục III) ──
export const STAGE_CODES = ["S1", "S2", "S3", "S4", "S5"] as const;
export type StageCode = (typeof STAGE_CODES)[number];

// ── Bộ kiểm nhanh (dùng khi parse JSON của classifier / nạp dữ liệu) ──
const SERVICE_SET = new Set<string>(SERVICE_CODES);
const SEGMENT_SET = new Set<string>(SEGMENT_CODES);
const OBJECTION_SET = new Set<string>(OBJECTION_CODES);

export const isServiceCode = (v: unknown): v is ServiceCode => typeof v === "string" && SERVICE_SET.has(v);
export const isSegmentCode = (v: unknown): v is SegmentCode => typeof v === "string" && SEGMENT_SET.has(v);
export const isObjectionCode = (v: unknown): v is ObjectionCode => typeof v === "string" && OBJECTION_SET.has(v);

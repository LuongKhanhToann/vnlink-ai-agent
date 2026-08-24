/**
 * engine/stages.ts — L1: Máy trạng thái 5 bước bán hàng (Mục III của tài liệu).
 *
 * Classifier (L5) chỉ đề xuất stage_move ∈ {hold, advance}. Hệ thống KHÔNG cho lùi bước (trừ khi
 * brain phát hiện reset hội thoại — khách quay lại sau thời gian dài). Mục tiêu bước hiện tại được
 * bơm vào prompt dưới dạng chỉ thị 1 dòng (stageDirective). Thuần logic + văn bản, không I/O.
 */

import type { StageCode } from "./taxonomy";
import { STAGE_CODES } from "./taxonomy";

export interface StageDef {
  code: StageCode;
  name: string;
  goal: string; // mục tiêu lượt (chỉ thị 1 dòng bơm vào prompt)
  advanceWhen: string; // điều kiện chuyển tiếp (để classifier tham chiếu, tài liệu hoá)
}

export const STAGES: Record<StageCode, StageDef> = {
  S1: {
    code: "S1",
    name: "Tiếp cận & đồng cảm",
    goal: "Chào thân thiện, xưng hô lịch sự, khen/đồng cảm mục tiêu của khách. CHƯA báo giá dồn, chưa chốt.",
    advanceWhen: "Đã chào và khách phản hồi lại.",
  },
  S2: {
    code: "S2",
    name: "Khai thác nhu cầu",
    goal: "Đặt 1 câu hỏi mở tìm mục tiêu/nỗi đau thật của khách (tiền sử tập, chấn thương, thời gian rảnh). Chưa chốt.",
    advanceWhen: "Đã xác định được mục tiêu hoặc nỗi đau của khách.",
  },
  S3: {
    code: "S3",
    name: "Giới thiệu giải pháp & mời trải nghiệm",
    goal: "Nối nhu cầu của khách với gói phù hợp; nhấn quyền lợi khi tới trải nghiệm trực tiếp (tập thử, đo InBody, dùng thử xông hơi/hồ bơi).",
    advanceWhen: "Khách quan tâm gói hoặc nêu phản đối cụ thể.",
  },
  S4: {
    code: "S4",
    name: "Xử lý từ chối & chốt lịch",
    goal: "Lắng nghe, không tranh cãi. Đưa HAI mốc giờ cụ thể để khách chọn, rồi xin Họ tên + Số điện thoại để tạo voucher/phiếu trải nghiệm.",
    advanceWhen: "Khách chốt được một mốc hẹn hoặc để lại số điện thoại.",
  },
  S5: {
    code: "S5",
    name: "Chăm sóc & nhắc lịch",
    goal: "Xác nhận lịch hẹn; hẹn sẽ nhắc trước giờ 2-4 tiếng; hướng dẫn chỗ gửi xe, trang phục cần mang.",
    advanceWhen: "—",
  },
};

/** Chỉ thị 1 dòng cho prompt theo bước hiện tại. */
export function stageDirective(stage: StageCode): string {
  const s = STAGES[stage];
  return `BƯỚC BÁN HÀNG HIỆN TẠI — ${s.name}: ${s.goal}`;
}

/**
 * Tiến trạng thái: chỉ hold/advance, KHÔNG lùi. advance nhảy đúng 1 bước tới S5 rồi dừng.
 * reset (khách quay lại sau thời gian dài) do brain xử lý riêng (đưa về S1), không phải ở đây.
 */
export function advanceStage(current: StageCode | null | undefined, move: "hold" | "advance"): StageCode {
  const cur: StageCode = current && STAGE_CODES.includes(current) ? current : "S1";
  if (move !== "advance") return cur;
  const idx = STAGE_CODES.indexOf(cur);
  return STAGE_CODES[Math.min(idx + 1, STAGE_CODES.length - 1)];
}

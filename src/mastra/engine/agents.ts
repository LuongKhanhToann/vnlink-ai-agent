/**
 * engine/agents.ts — Agent + Tool cho engine mới.
 *
 * 2 tool (recordLead / sendQR) là "hành động" model chủ động gọi. execute chỉ trả ACK ngắn để
 * vòng tool-call của Mastra tiếp tục; brain.ts đọc lại toolCalls SAU generate rồi làm phần
 * deterministic (merge slot vào knownInfo, resolve QR). An toàn đa luồng (không state chia sẻ
 * trong tool) + khớp Mastra 1.17 (result.toolCalls / onIterationComplete).
 *
 * ẢNH/VIDEO KHÔNG do reply-agent gọi tool nữa: model nhỏ hay BỎ NHỊP gửi ảnh (dịp nghi ngờ /
 * soi cơ sở). Thay bằng CỔNG DETERMINISTIC — turnRouter (classifier rẻ, chạy sẵn mỗi lượt)
 * quyết THẲNG bộ ảnh `media`, brain.ts fetch cưỡng chế 1 lần/cuộc. Đây là hành vi phải-đúng-100%
 * nên cưỡng chế bằng code, không phó mặc model nhỏ có thèm gọi tool hay không.
 */

import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { memory } from "../config/memory";
import { replyModel, classifierModel } from "../config/openai";
import { FITNESS_PROMPT, GIAI_CO_PROMPT } from "./prompts";

// ── recordLead: lưu thông tin đặt lịch khách vừa cung cấp ─────────────
const recordLeadTool = createTool({
  id: "recordLead",
  description:
    "Lưu thông tin đặt lịch khi vừa biết thêm từ khách. Gọi mỗi khi khách cho thông tin mới " +
    "liên quan đặt lịch (tên, số điện thoại, giờ/ngày muốn đến, bộ môn / vùng đau, mục tiêu). " +
    "Đủ tên + SĐT + ngày-giờ cụ thể → hệ thống tự chốt đơn. CHỈ lưu đúng cái khách NÓI, không bịa.",
  inputSchema: z.object({
    name: z.string().nullish().describe("Tên riêng của khách, đã bỏ động từ/kính ngữ (vd 'Trung' không phải 'là Trung'). Khi khách đưa liên hệ dạng '<Tên> <SĐT>' thì cụm chữ LÀ TÊN — kể cả khi trùng âm với từ thời gian (vd 'Mai 090...' → tên='Mai', KHÔNG phải 'ngày mai'). MỘT KÍNH NGỮ đứng trơ (anh/chị/em/cô/chú/bạn) KHÔNG phải tên — nếu khách chưa cho tên riêng thì để null, ĐỪNG lấy kính ngữ làm tên."),
    phone: z.string().nullish().describe("Số điện thoại"),
    preferredTime: z.string().nullish().describe("Cụm giờ/buổi khách muốn đến, nguyên văn (vd '2h chiều', '10h sáng mai'). CHỈ trích khi khách thật sự nói về THỜI ĐIỂM sẽ đến — một tên riêng đứng cạnh SĐT KHÔNG phải giờ."),
    appointmentDate: z.string().nullish().describe("Ngày hẹn tuyệt đối DD/MM/YYYY nếu xác định được từ tin khách; null nếu khách chưa nêu ngày cụ thể. Một tên riêng (vd 'Mai') đứng cạnh SĐT KHÔNG phải ngày — đừng suy 'Mai' thành 'ngày mai'."),
    service: z.string().nullish().describe("Bộ môn fitness: gym/yoga/zumba/boi/pilates/full"),
    goal: z.string().nullish().describe("Mục tiêu fitness: giam-mo/tang-co/tang-can/thu-gian/hoc-boi/suc-khoe/giu-dang"),
    painArea: z.string().nullish().describe("Vùng đau (giải cơ): vai-gay/lung/chan/toan-than/..."),
  }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

// ── sendQR: gửi mã QR đặt cọc ─────────────────────────────────────────
const sendQRTool = createTool({
  id: "sendQR",
  description:
    "Gửi mã QR đặt cọc cho khách. CHỈ gọi khi đã có tên + SĐT và khách hỏi/đồng ý đặt cọc.",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

const brainTools = {
  recordLead: recordLeadTool,
  sendQR: sendQRTool,
};

export const fitnessBrainAgent = new Agent({
  name: "FitnessBrain",
  id: "fitness-brain",
  model: replyModel,
  tools: brainTools,
  memory,
  instructions: FITNESS_PROMPT,
});

export const giaiCoBrainAgent = new Agent({
  name: "GiaiCoBrain",
  id: "giai-co-brain",
  model: replyModel,
  tools: brainTools,
  memory,
  instructions: GIAI_CO_PROMPT,
});

// ── Turn router: mỗi lượt quyết (1) nhánh business + (2) bộ ảnh nên gửi ──
// 2 công ty khác nhau (Fami fitness / Hoa Sen giải cơ) → cần tách để không rò giá/địa chỉ chéo.
// Chạy sẵn mỗi lượt (classifier rẻ, temp 0) → gánh luôn quyết định MEDIA (cổng deterministic,
// thay cho việc reply-agent tự gọi tool hay bỏ nhịp). Không tool, không memory.
export const flowRouterAgent = new Agent({
  name: "TurnRouter",
  id: "turn-router",
  model: classifierModel,
  instructions: `Bạn đọc tin khách + ngữ cảnh, trả 2 quyết định: "flow" và "media".

① flow — nhánh dịch vụ. Đây là page của trung tâm FITNESS → "fitness" là nhánh MẶC ĐỊNH.
- "fitness": mọi nhu cầu TẬP (gym / yoga / zumba / bơi / pilates) và mọi MỤC TIÊU của việc tập — giảm cân, tăng cân, tăng cơ, giữ dáng, sức khoẻ, thể hình, và cả THƯ GIÃN / xả stress / thả lỏng người. Hỏi giá gói tập, đặt lịch tập thử.
- "giai-co": khách ĐANG ĐAU MỎI cơ-xương-khớp và muốn TRỊ LIỆU cho hết đau (chứ không phải để tập), hoặc khách hỏi thẳng dịch vụ giải cơ / massage / bấm huyệt.
⛔ giai-co là DOANH NGHIỆP KHÁC (spa) — đẩy khách sang đó khi họ không có nhu cầu trị liệu là SAI NGHIÊM TRỌNG. Chỉ chọn giai-co khi khách NÊU CƠN ĐAU hoặc HỎI THẲNG dịch vụ trị liệu. Muốn "thư giãn" mà KHÔNG kèm đau = mục tiêu của việc TẬP → "fitness". Mơ hồ / chưa đủ tín hiệu → "fitness".
STICKY: khách ĐANG ở nhánh hiện tại — chỉ đổi khi khách RÕ RÀNG chuyển sang nhu cầu khác hẳn. Tin mơ hồ / nối tiếp / cung cấp tên-SĐT-giờ → GIỮ nhánh hiện tại. Người vừa than đau rồi hỏi giá/lịch vẫn là giai-co; người đang tư vấn gói tập rồi cho SĐT vẫn là fitness.

② media — bộ ảnh minh hoạ hệ thống nên GỬI KÈM lượt này, hoặc "none" nếu lượt này KHÔNG nên gửi.
Chọn 1 bộ (khác "none") CHỈ KHI tin khách rơi vào 1 trong 2:
- Khách NGHI NGỜ / phân vân KẾT QUẢ, hiệu quả (không tin tập hay trị liệu sẽ có tác dụng, sợ làm xong lại như cũ) → gửi ảnh CHỨNG MINH.
- Khách TÒ MÒ cơ sở — tức HỎI VỀ chính nơi tập/thiết bị/không gian (bể bơi ra sao, phòng gym có máy gì, không gian yoga/lớp zumba thế nào) → gửi ảnh bộ môn đó.
⛔ PHÂN BIỆT RÕ: khách chỉ NÊU nhu cầu / bộ môn muốn tập ("muốn tập bơi", "muốn tập gym", "quan tâm yoga", "mình tập giảm cân") = ĐANG KHAI NHU CẦU lúc discovery, KHÔNG phải tò mò cơ sở → "none". Chỉ tò mò cơ sở khi khách HỎI VỀ nơi tập, KHÔNG phải khi khách nói muốn tập.
Còn lại (chào hỏi, đang khai nhu cầu, hỏi giá / địa chỉ / giờ, chốt lịch, hỏi mang gì) → "none". ⛔ TIN ĐẦU / khách vừa vào / mới chào → LUÔN "none" (chưa có tín hiệu gì để gửi ảnh).
⛔ KHÔNG gửi ảnh khi: khách vừa BÁO chấn thương/đau (mới tả tình trạng, chưa nghi ngờ kết quả) — nhất là chấn thương CẤP (mới bị, sưng, nóng) thì tuyệt đối "none" (đây là lúc dặn nghỉ an toàn, không phải lúc khoe demo).
CHỌN ĐÚNG BỘ:
- fitness + nghi ngờ kết quả → theo MỤC TIÊU: tăng cân/tăng cơ → "fitness-before-after-gain"; giảm cân/giảm mỡ → "fitness-before-after-loss".
- fitness + tò mò cơ sở → "fitness-gym" (phòng gym/máy), "fitness-pool" (bể bơi), "fitness-yoga" (yoga), "fitness-zumba" (zumba).
- giai-co + nghi ngờ kết quả → theo VÙNG ĐAU (ưu tiên "vùng đau" trong bối cảnh đã biết, rồi tới các tin gần đây): cổ/vai/gáy (gồm slug vai-gay, co-vai-gay) → "mr-neck-shoulder"; chân/bắp chân/chấn thương thể thao → "mr-sport"; lưng/thắt lưng/toàn thân/chưa rõ → "mr-general". Đã biết vùng cổ vai gáy thì KHÔNG chọn mr-general.
Dựa vào "bối cảnh đã biết" (mục tiêu / bộ môn / vùng đau) + các tin khách gần đây để chọn đúng chiều before-after và đúng vùng mr-*. Không chắc rơi vào 2 case trên → "none".

③ ready — khách đã tỏ ý MUỐN ĐẾN/thử/đặt lịch chưa (true/false):
- true khi: đồng ý thử 1 buổi, hỏi lịch/cách đặt, tự nêu ngày-giờ muốn đến, hoặc đưa tên/SĐT để đặt.
- false khi: mới hỏi thông tin / than đau / phân vân / nói "để xem đã", "để tính đã", "chưa chắc" (đang chần chừ, CHƯA quyết đến).`,
});

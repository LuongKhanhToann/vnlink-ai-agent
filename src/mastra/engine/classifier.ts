/**
 * engine/classifier.ts — L5: Turn Classifier. 1 call LLM nhẹ (fastModels, temp 0) xuất JSON:
 *   { service, segment, objections[], stage_move, fact_query }
 *
 * Vì sao TÁCH khỏi rewriteQuery cũ: các lượt phi-dữ-kiện (khách bộc lộ nỗi đau/từ chối, không hỏi
 * giá) là lúc CẦN phân loại nhất, nhưng rewriteQuery lại trả NONE bỏ qua. L5 gộp luôn việc viết-lại-
 * query vào trường `fact_query` để KHÔNG thêm call thứ hai cho RAG.
 *
 * Nhãn là tập ĐÓNG (taxonomy.ts) + nhánh thoát (service=null, objection=khac_khong_ro). Model gắn
 * nhãn bằng suy luận trên hội thoại (KHÔNG keyword/regex). Lỗi call/parse → FAIL-OPEN.
 */

import { generateJson, type ChatMsg } from "../llm/gemini";
import {
  OBJECTION_DESC,
  SEGMENT_LABEL,
  SERVICE_INFO,
  isObjectionCode,
  isSegmentCode,
  isServiceCode,
  type ObjectionCode,
  type SegmentCode,
  type ServiceCode,
  type StageCode,
} from "./taxonomy";
import { STAGES } from "./stages";

export interface ScoredObjection {
  code: ObjectionCode;
  confidence: number;
}
export interface TurnClassification {
  service: ServiceCode | null;
  segment: SegmentCode | null;
  objections: ScoredObjection[]; // 0..2, giảm dần theo confidence
  stage_move: "hold" | "advance";
  fact_query: string | null; // null = lượt không cần tra dữ kiện (chào/tâm sự thuần)
}

type Turn = { role: "user" | "assistant"; content: string };

function serviceMenu(): string {
  return (Object.keys(SERVICE_INFO) as ServiceCode[])
    .map((c) => `  - ${c}: ${SERVICE_INFO[c].label} (từ khóa gợi ý: ${SERVICE_INFO[c].keywords})`)
    .join("\n");
}
function segmentMenu(): string {
  return (Object.keys(SEGMENT_LABEL) as SegmentCode[]).map((c) => `  - ${c}: ${SEGMENT_LABEL[c]}`).join("\n");
}
function objectionMenu(): string {
  return (Object.keys(OBJECTION_DESC) as ObjectionCode[]).map((c) => `  - ${c}: ${OBJECTION_DESC[c]}`).join("\n");
}

function buildSystem(stage: StageCode): string {
  return `Bạn là bộ PHÂN LOẠI lượt hội thoại cho chatbot bán hàng của Fami Fitness. Đọc lịch sử + tin MỚI của khách, suy luận trên TOÀN hội thoại, rồi xuất DUY NHẤT một JSON (không giải thích, không markdown) đúng schema:
{"service": <code|null>, "segment": <code|null>, "objections": [{"code": <code>, "confidence": <0..1>}], "stage_move": "hold"|"advance", "fact_query": <chuỗi|null>}

service — khách đang quan tâm dịch vụ nào (null nếu chưa rõ):
${serviceMenu()}

segment — chân dung/nhân khẩu của khách (null nếu chưa rõ):
${segmentMenu()}

objections — rào cản / kiểu từ chối / tâm lý đang bộc lộ (0 đến 2 mã, confidence giảm dần; [] nếu chưa có rào cản rõ; dùng "khac_khong_ro" khi có rào cản nhưng ngoài danh sách):
${objectionMenu()}

stage_move — bước bán hàng hiện tại là ${stage} (${STAGES[stage].name}). Trả "advance" nếu điều kiện chuyển tiếp đã đạt (${STAGES[stage].advanceWhen}), ngược lại "hold". KHÔNG bao giờ lùi bước.

fact_query — nếu lượt này CẦN tra tài liệu để trả lời đúng (giá, gói, khuyến mại, giờ, tiện ích, kiến thức), viết MỘT câu truy vấn tiếng Việt tự đủ nghĩa, thay đại từ/tham chiếu mơ hồ ("cái kia", "gói đó", "bao nhiêu") bằng chủ thể cụ thể suy từ ngữ cảnh. Nếu chỉ là chào hỏi / cảm ơn / tâm sự thuần không cần tra tài liệu → null.
  QUAN TRỌNG: hễ khách HỎI GIÁ / gói / học phí / khuyến mại của một dịch vụ (kể cả hỏi cộc lốc "bao nhiêu", "giá", "có gói nào rẻ không") thì BẮT BUỘC đặt fact_query cụ thể theo dịch vụ đó (VD "Giá các khóa học bơi cho trẻ em tại Fami Fitness"), KHÔNG để null — vì bot phải nêu đúng mốc giá trong tài liệu.

Chỉ xuất JSON.`;
}

const FAIL_OPEN = (message: string): TurnClassification => ({
  service: null,
  segment: null,
  objections: [],
  stage_move: "hold",
  fact_query: message.trim() || null,
});

function sanitize(raw: any, message: string): TurnClassification {
  if (!raw || typeof raw !== "object") return FAIL_OPEN(message);
  const service = isServiceCode(raw.service) ? raw.service : null;
  const segment = isSegmentCode(raw.segment) ? raw.segment : null;
  const objections: ScoredObjection[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.objections)) {
    for (const o of raw.objections) {
      const code = o?.code;
      if (!isObjectionCode(code) || seen.has(code)) continue;
      const confRaw = Number(o?.confidence);
      const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0.5;
      seen.add(code);
      objections.push({ code, confidence });
      if (objections.length >= 2) break;
    }
  }
  objections.sort((a, b) => b.confidence - a.confidence);
  const stage_move = raw.stage_move === "advance" ? "advance" : "hold";
  const fq = typeof raw.fact_query === "string" ? raw.fact_query.trim() : "";
  const fact_query = fq && fq.toUpperCase() !== "NULL" && fq.toUpperCase() !== "NONE" ? fq.slice(0, 300) : null;
  return { service, segment, objections, stage_move, fact_query };
}

/** Phân loại 1 lượt. Lỗi/parse hỏng → FAIL-OPEN (service=null, objections=[], hold, fact_query=câu thô). */
export async function classify(
  history: Turn[],
  message: string,
  stage: StageCode,
  abortSignal?: AbortSignal,
): Promise<TurnClassification> {
  const msg = (message ?? "").trim();
  if (!msg) return FAIL_OPEN(msg);
  const ctx = history
    .slice(-8)
    .map((t) => `${t.role === "user" ? "Khách" : "Bot"}: ${t.content}`)
    .join("\n");
  const messages: ChatMsg[] = [
    { role: "system", content: buildSystem(stage) },
    {
      role: "user",
      content: `${ctx ? `<lịch_sử>\n${ctx}\n</lịch_sử>\n\n` : ""}<tin_mới>\n${msg}\n</tin_mới>\n\nJSON:`,
    },
  ];
  const raw = await generateJson<any>(messages, {
    maxTokens: 300,
    abortSignal,
    purpose: "Phân loại lượt",
  });
  if (raw === null) return FAIL_OPEN(msg);
  return sanitize(raw, msg);
}

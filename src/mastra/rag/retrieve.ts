/**
 * rag/retrieve.ts — Tầng ĐIỀU PHỐI truy hồi cho mỗi lượt chat (hot path).
 *
 * Pipeline "full best-practice" (giống document-Q&A của Claude/ChatGPT/Gemini):
 *   1) VIẾT LẠI QUERY theo lịch sử  — "còn cái kia?" → câu tự đủ nghĩa. Chào hỏi/tán gẫu → bỏ tra cứu.
 *   2) HYBRID  — dense (cosine, hiểu ngữ nghĩa) ∥ sparse (full-text, bắt tên gói/số buổi đúng chữ).
 *   3) RRF  — hợp nhất 2 bảng xếp hạng (Reciprocal Rank Fusion), không cần chỉnh trọng số thủ công.
 *   4) RERANK bằng LLM — chấm lại ~12 ứng viên, giữ vài đoạn THẬT khớp, bỏ ngưỡng cosine cứng.
 *   5) GHÉP khối tài liệu có TRÍCH NGUỒN [tên tài liệu] + chốt chống bịa.
 *
 * MỌI tầng FAIL-OPEN xuống mức đơn giản hơn:
 *   rewrite lỗi → dùng câu thô | sparse lỗi → dense-only | rerank lỗi → RRF top-K | hỏng cả → "".
 * Công tắc RAG_MODE=basic → chỉ dense top-k như luồng cũ (thoát hiểm tức thì, không cần deploy lại).
 * KHÔNG cache — đọc kho mới mỗi lượt.
 */

import { embedOne, toVectorLiteral } from "./embed";
import {
  hasDocs,
  denseCandidates,
  sparseCandidates,
  type Candidate,
} from "./store";
import { generateReply, fastModels, type ChatMsg } from "../llm/gemini";

const DENSE_N = 20; // ứng viên dense thô
const SPARSE_N = 20; // ứng viên sparse thô
const RRF_K = 60; // hằng số RRF chuẩn
const FUSE_KEEP = 12; // số ứng viên đưa vào rerank
const FINAL_KEEP = 5; // số đoạn cuối bơm vào prompt
const BASIC_MAX_DIST = 0.62; // ngưỡng cosine cho chế độ basic (giữ như cũ)

type Turn = { role: "user" | "assistant"; content: string };

// ── (1) Viết lại query theo hội thoại ──
const REWRITE_SYSTEM = `Bạn giúp một chatbot bán hàng TÌM tài liệu để trả lời khách. Cho lịch sử hội thoại và tin nhắn MỚI của khách, hãy viết MỘT câu truy vấn tìm kiếm tiếng Việt tự đủ nghĩa, thay các đại từ/tham chiếu mơ hồ ("cái kia", "gói đó", "vậy còn", "bao nhiêu") bằng chủ thể cụ thể suy ra từ ngữ cảnh.
- CHỈ trả về đúng câu truy vấn, không giải thích, không markdown.
- Nếu tin nhắn chỉ là chào hỏi/cảm ơn/tán gẫu, KHÔNG có gì cần tra tài liệu → trả về đúng chữ: NONE`;

async function rewriteQuery(history: Turn[], message: string): Promise<string> {
  const msg = (message ?? "").trim();
  if (!msg) return "";
  const ctx = history
    .slice(-6)
    .map((t) => `${t.role === "user" ? "Khách" : "Bot"}: ${t.content}`)
    .join("\n");
  const messages: ChatMsg[] = [
    { role: "system", content: REWRITE_SYSTEM },
    {
      role: "user",
      content: `${ctx ? `<lịch_sử>\n${ctx}\n</lịch_sử>\n\n` : ""}<tin_mới>\n${msg}\n</tin_mới>\n\nCâu truy vấn:`,
    },
  ];
  try {
    const out = (await generateReply(messages, { temperature: 0, maxTokens: 120, models: fastModels() })).trim();
    // Nhận diện sentinel "NONE" khoan dung: bỏ dấu ngoặc/chấm câu quanh nó (model hay trả `NONE.` / `"NONE"`).
    if (!out || out.replace(/[^A-Za-zÀ-ỹ]/g, "").toUpperCase() === "NONE") return ""; // "" = bỏ tra cứu lượt này
    return out.length > 300 ? out.slice(0, 300).trim() : out;
  } catch (e) {
    console.warn("[rag] rewriteQuery fail-open → dùng câu thô:", (e as Error).message);
    return msg; // fail-open: dùng nguyên câu khách
  }
}

// ── (3) Hợp nhất RRF ──
function fuseRRF(dense: Candidate[], sparse: Candidate[]): Candidate[] {
  const score = new Map<number, number>();
  const byId = new Map<number, Candidate>();
  const add = (list: Candidate[]) => {
    list.forEach((c, pos) => {
      score.set(c.id, (score.get(c.id) ?? 0) + 1 / (RRF_K + pos));
      if (!byId.has(c.id)) byId.set(c.id, c);
    });
  };
  add(dense);
  add(sparse);
  return [...byId.values()]
    .sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0))
    .slice(0, FUSE_KEEP);
}

// ── (4) Rerank bằng LLM ──
const RERANK_SYSTEM = `Bạn xếp hạng lại các đoạn tài liệu theo mức HỮU ÍCH để trả lời câu hỏi của khách.
Trả về DUY NHẤT một mảng JSON các SỐ THỨ TỰ đoạn, xếp hữu ích nhất trước, tối đa ${FINAL_KEEP} số.
ƯU TIÊN đoạn chứa thông tin CỤ THỂ đúng thứ khách hỏi (bảng giá, con số, tên gói, chính sách chi tiết) HƠN đoạn mô tả chung chung/liệt kê tổng quan.
MẶC ĐỊNH GIỮ LẠI: đoạn có thông tin liên quan thì giữ, kể cả khi lẫn nội dung khác. CHỈ trả về [] khi TẤT CẢ hoàn toàn lạc đề. Không giải thích, chỉ mảng JSON.`;

function parseIdxArray(raw: string, max: number): number[] {
  const s = raw.indexOf("[");
  const e = raw.lastIndexOf("]");
  if (s < 0 || e <= s) return [];
  try {
    const arr = JSON.parse(raw.slice(s, e + 1));
    if (!Array.isArray(arr)) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const v of arr) {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= max && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function llmRerank(query: string, cands: Candidate[]): Promise<Candidate[]> {
  if (cands.length <= 1) return cands.slice(0, FINAL_KEEP);
  const list = cands
    .map((c, i) => `[${i + 1}] (${c.title}) ${c.content.replace(/\s+/g, " ").slice(0, 480)}`)
    .join("\n");
  const messages: ChatMsg[] = [
    { role: "system", content: RERANK_SYSTEM },
    { role: "user", content: `Câu hỏi: ${query}\n\nCác đoạn:\n${list}\n\nMảng JSON số thứ tự hữu ích nhất:` },
  ];
  try {
    // Model nhẹ (nhanh): reranker chỉ cần SẮP XẾP — worst-case "[]" oan đã được BACKFILL top RRF
    // ở retrieveForTurn bù lại, nên không cần model mạnh chậm ở đây.
    const out = await generateReply(messages, { temperature: 0, maxTokens: 80, models: fastModels() });
    if (process.env.RAG_DEBUG) console.log(`[rag/dbg] rerank raw: ${JSON.stringify(out).slice(0, 200)}`);
    const picks = parseIdxArray(out, cands.length);
    if (!picks.length) return []; // model nói không có đoạn nào liên quan → tôn trọng
    return picks.map((n) => cands[n - 1]);
  } catch (e) {
    console.warn("[rag] rerank fail-open → RRF top-K:", (e as Error).message);
    return cands.slice(0, FINAL_KEEP);
  }
}

// ── Ghép khối tài liệu bơm vào system prompt ──
function formatBlock(hits: Candidate[]): string {
  if (!hits.length) return "";
  const body = hits
    .map((h, i) => `(${i + 1}) [${h.title}] ${h.content.trim()}`)
    .join("\n\n");
  return `═══ TÀI LIỆU THAM KHẢO (trích từ tài liệu Fami Fitness — dùng để trả lời CÓ CĂN CỨ) ═══
${body}
⚠ Chỉ dùng phần khớp câu hỏi; có thể dẫn theo tên tài liệu trong ngoặc. TUYỆT ĐỐI KHÔNG bịa số/giá/chính sách không có trong tài liệu.`;
}

// ── Chế độ basic (thoát hiểm): dense top-k như luồng cũ ──
async function retrieveBasic(query: string): Promise<Candidate[]> {
  const vec = toVectorLiteral(await embedOne(query, "RETRIEVAL_QUERY"));
  const dense = await denseCandidates(vec, FINAL_KEEP);
  return dense.filter((c) => (c.dist ?? 1) <= BASIC_MAX_DIST);
}

/**
 * Truy hồi cho 1 lượt chat. Trả khối [TÀI LIỆU THAM KHẢO] hoặc "" (không có gì hợp lệ).
 * FAIL-OPEN toàn cục: bất kỳ lỗi nào → "".
 */
export async function retrieveForTurn(input: { message: string; history?: Turn[] }): Promise<string> {
  const message = (input.message ?? "").trim();
  if (message.length < 2) return "";
  try {
    if (!(await hasDocs())) return "";

    const basic = (process.env.RAG_MODE || "").toLowerCase() === "basic";
    if (basic) return formatBlock(await retrieveBasic(message));

    const dbg = !!process.env.RAG_DEBUG;

    // (1) viết lại theo ngữ cảnh
    const query = await rewriteQuery(input.history ?? [], message);
    if (dbg) console.log(`[rag/dbg] rewrite: "${message}" → "${query}"`);
    if (!query) return ""; // model bảo không cần tra cứu

    // (2) hybrid: dense ∥ sparse (sparse fail-open [])
    const vecLiteral = toVectorLiteral(await embedOne(query, "RETRIEVAL_QUERY"));
    const [dense, sparse] = await Promise.all([
      denseCandidates(vecLiteral, DENSE_N),
      sparseCandidates(query, SPARSE_N).catch((e) => {
        console.warn("[rag] sparse fail-open []:", (e as Error).message);
        return [] as Candidate[];
      }),
    ]);
    if (dbg)
      console.log(
        `[rag/dbg] dense=${dense.length}(minDist=${dense[0]?.dist?.toFixed(3) ?? "-"}) sparse=${sparse.length}`,
      );
    if (!dense.length && !sparse.length) return "";

    // (3) RRF → (4) rerank (chỉ để SẮP XẾP, không để rơi)
    const fused = fuseRRF(dense, sparse);
    const reranked = await llmRerank(query, fused);

    // Hợp nhất: ưu tiên thứ tự reranker, RỒI backfill bằng top RRF cho đủ FINAL_KEEP.
    // Nhờ backfill, đoạn mạnh nhất (vd bảng giá xếp cao trong RRF) KHÔNG bao giờ bị reranker bỏ sót.
    const seen = new Set<number>();
    const hits: Candidate[] = [];
    for (const c of reranked) if (!seen.has(c.id)) (seen.add(c.id), hits.push(c));
    for (const c of fused) {
      if (hits.length >= FINAL_KEEP) break;
      if (!seen.has(c.id)) (seen.add(c.id), hits.push(c));
    }
    const final = hits.slice(0, FINAL_KEEP);
    if (dbg)
      console.log(
        `[rag/dbg] fused=${fused.length} rerank=${reranked.length} → final=${final.length}` +
          ` (backfill ${final.length - reranked.length})`,
      );
    return formatBlock(final);
  } catch (e) {
    console.error('[rag] retrieveForTurn failed → fail-open (""):', (e as Error).message);
    return "";
  }
}

/**
 * Truy hồi 1-shot không lịch sử (giữ tương thích cho smoke test / dùng nội bộ).
 * Đi qua đúng pipeline hybrid + rerank nhưng bỏ bước viết-lại-theo-hội-thoại.
 */
export async function retrieveDocs(query: string): Promise<string> {
  return retrieveForTurn({ message: query, history: [] });
}

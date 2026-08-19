/**
 * rag/contextualize.ts — Contextual Retrieval (kỹ thuật Anthropic dùng cho Claude).
 *
 * Với mỗi đoạn (chunk), đưa CẢ tài liệu + đoạn đó cho LLM để sinh 1-2 câu "định vị" đoạn trong
 * tổng thể (đoạn này nói về gì, thuộc phần nào, số/giá/đối tượng nào). Câu ngữ cảnh này được ghép
 * vào TRƯỚC đoạn rồi mới đem embed + index full-text → truy hồi trúng hơn hẳn so với embed đoạn trần
 * (vì đoạn trần hay mất chủ ngữ: "Gói này 12 tháng giá 6 triệu" không biết "gói này" là gói gì).
 *
 * Chỉ chạy lúc INGEST (không phải hot path chat). FAIL-OPEN: LLM lỗi/rỗng → "" (vẫn embed đoạn trần).
 * KHÔNG cache — đây là artifact tính sẵn lúc nạp, lưu thẳng vào DB như embedding.
 */

import { generateReply, fastModels, type ChatMsg } from "../llm/gemini";

// Giới hạn ký tự tài liệu đưa vào (đủ ngữ cảnh, ghìm token/độ trễ cho tài liệu rất dài).
const MAX_DOC_CHARS = 12_000;

const SYSTEM = `Bạn là trợ lý lập chỉ mục tài liệu. Nhiệm vụ: viết 1-2 câu ngắn (tiếng Việt) ĐỊNH VỊ một đoạn trích trong toàn bộ tài liệu, để khi tìm kiếm về sau đoạn đó không bị mất ngữ cảnh.
Câu ngữ cảnh cần nêu rõ: đoạn nói về CHỦ ĐỀ/mục nào, thuộc dịch vụ/gói/đối tượng nào nếu có (thay các đại từ mơ hồ như "gói này", "dịch vụ đó" bằng tên cụ thể lấy từ tài liệu).
CHỈ trả về câu ngữ cảnh. KHÔNG lặp lại nguyên văn đoạn. KHÔNG thêm lời dẫn, không markdown, không "Ngữ cảnh:". Nếu đoạn đã tự đủ nghĩa thì tóm tắt ngắn nó thuộc phần nào.`;

/** Sinh câu ngữ cảnh cho 1 đoạn. Fail-open "" khi lỗi. */
export async function contextualizeChunk(docText: string, chunk: string): Promise<string> {
  const doc = (docText ?? "").trim();
  const c = (chunk ?? "").trim();
  if (!c) return "";
  // Tài liệu quá ngắn (chỉ 1 đoạn) thì ngữ cảnh chẳng thêm gì → bỏ qua cho nhanh.
  if (doc.length <= c.length + 40) return "";

  const docForPrompt = doc.length > MAX_DOC_CHARS ? doc.slice(0, MAX_DOC_CHARS) : doc;
  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `<tài_liệu>\n${docForPrompt}\n</tài_liệu>\n\n<đoạn_trích>\n${c}\n</đoạn_trích>\n\nViết câu ngữ cảnh định vị đoạn trích trên:`,
    },
  ];

  try {
    const out = (
      await generateReply(messages, {
        temperature: 0,
        maxTokens: 160,
        models: fastModels(),
        purpose: "Ghi chú tài liệu (nạp)",
      })
    ).trim();
    // Gọn lại phòng model lỡ trả dài; 1-2 câu là đủ.
    return out.length > 400 ? out.slice(0, 400).trim() : out;
  } catch (e) {
    console.warn("[rag] contextualize fail-open:", (e as Error).message);
    return "";
  }
}

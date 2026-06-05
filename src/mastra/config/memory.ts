import { Memory } from "@mastra/memory";
import { storage } from "./storage";
import { vector } from "./vector";
import { embedder } from "./embeddings";

const useLibsql = process.env.STORAGE_BACKEND === "libsql";

// ─────────────────────────────────────────────
// HỒ SƠ KHÁCH (working memory, scope=resource)
// Bản tóm tắt hành vi DÀI HẠN theo TỪNG USER (xuyên suốt mọi phiên chat). Bot tự cập
// nhật sau mỗi lượt. Đây là nơi "nhớ hành vi quan trọng" — gọn, luôn nằm trong prompt,
// KHÔNG dump transcript thô (tránh bot nhại lại văn cũ).
// ─────────────────────────────────────────────
const WORKING_MEMORY_TEMPLATE = `# Hồ sơ khách (cập nhật khi có thông tin mới)
- Tên / xưng hô:
- Khách mới hay đã từng liên hệ/đặt trước đây:
- Bộ môn quan tâm:
- Mục tiêu tập (giảm cân / tăng cơ / thư giãn / học bơi / sức khỏe):
- Khung giờ / lịch tiện đi:
- Lịch đã đặt / đổi / hủy (tóm tắt ngắn):
- Mối bận tâm hay nêu (giá, sợ không theo được, đông, sức khỏe...):
- Tính cách & cách nhắn (cộc/dài, thân thiện, cần đốc thúc nhẹ...):
- Ghi chú quan trọng khác:
`;

// lastMessages=8: recency window cho TONE (giữ như cũ — ít transcript thô để bot khỏi
//   mimic pattern cũ). Ký ức dài hạn đẩy sang working memory (structured) + semantic recall.
// semanticRecall: kéo lại NGUYÊN VĂN đoạn cũ liên quan trong TOÀN BỘ lịch sử user
//   (scope=resource). topK nhỏ để khỏi loãng prompt. TẮT ở test mode (không có pgvector).
//   Số chiều index do embedder quyết định (1536) — Mastra tự lo, không set tay.
export const memory = new Memory({
  storage,
  vector,
  embedder,
  options: {
    lastMessages: 8,
    semanticRecall: useLibsql
      ? false
      : {
          topK: 4,
          messageRange: { before: 1, after: 1 },
          scope: "resource",
          indexConfig: { type: "hnsw", metric: "dotproduct" },
        },
    workingMemory: {
      enabled: true,
      scope: "resource",
      template: WORKING_MEMORY_TEMPLATE,
    },
  },
});

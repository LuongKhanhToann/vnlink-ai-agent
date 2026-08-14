# FIRST READ — BẮT BUỘC trước khi sửa hành vi hội thoại (live sales bot)

Bot đang **golive trên page thật**. Trước khi sửa/cải thiện BẤT KỲ hành vi chat nào:

1. **ĐỌC KĨ + SOI LOG SERVER trước tiên.** Kéo log bot live (pm2 log trên box val-dev) và đọc kỹ classifier quyết gì (`intentTopic`/`slots`/`mediaMove`), reply thực tế, và VÌ SAO ra hành vi đó. Chẩn đoán từ log THẬT — không đoán từ trí nhớ, không sửa mù.
2. **Sửa đúng điểm, KHÔNG ảnh hưởng luồng/logic khác.** Vá tối thiểu cho đúng case đang lỗi; không refactor lan man, không đổi hành vi bộ môn/flow khác.
3. **Test KĨ, KHÔNG sơ sài — và phải test ĐÚNG cái khách thấy.** Sửa hành vi hội thoại thì BẮT BUỘC smoke chạy REPLY THẬT qua pipeline (routerWorkflow + LLM, đặt `STORAGE_BACKEND=libsql` để không đụng prod), rồi ĐỌC câu chữ bot thực sự trả. TUYỆT ĐỐI KHÔNG chỉ unit-test logic/FSM rồi tuyên bố xong — logic đúng ≠ câu tự nhiên. Reply là ngẫu nhiên → chạy VÀI LẦN xem có ổn định không. Smoke thông minh & vừa đủ (không hàng loạt tốn token) nhưng KHÔNG được bỏ bước đọc reply thật TRƯỚC khi deploy.

# RAG hỏi-đáp tài liệu — kỹ thuật ĐÃ CÓ / CÒN THIẾU (audit 14/08/2026)

Luồng RAG tài liệu Fami (`rag/` + `engine/brain.ts`) đã nâng lên **full best-practice** như document-Q&A của Claude/ChatGPT/Gemini. Audit toàn diện `npx -y tsx src/mastra/scripts/smokeRagAudit.ts` **22/22 PASS** (2 lần, ổn định) — phủ mọi loại giá, khuyến mại, địa chỉ/giờ, pilates, xông hơi, nối-tiếp-ngữ-cảnh, gõ-không-dấu, câu-ngắn-mơ-hồ, chào/cảm-ơn-bỏ-tra-cứu, basic mode, và reply thật (giá đúng + từ chối bịa).

**ĐÃ CÓ (đủ chuẩn ở quy mô hiện tại: 3 doc / 31 đoạn):**
- **Query rewrite theo hội thoại** (`rag/retrieve.ts` rewriteQuery, fastModels): giải đại từ "còn cái kia?"; chào hỏi/cảm ơn → sentinel NONE → bỏ tra cứu.
- **Contextual Retrieval** (Anthropic — `rag/contextualize.ts`): mỗi chunk có câu định vị ghép trước khi embed.
- **Hybrid** dense (pgvector cosine) + sparse full-text tiếng Việt (`unaccent`, OR-lexeme kiểu BM25 — KHÔNG dùng `websearch_to_tsquery` vì nó AND mọi từ).
- **RRF** hợp nhất (k=60) + **LLM rerank** (fastModels) chỉ để SẮP XẾP, sau đó **BACKFILL top RRF** đủ FINAL_KEEP=5 → đoạn mạnh (bảng giá) không bao giờ bị reranker bỏ sót.
- **Chunk bám cấu trúc** (`store.ts chunkText`): bảng markdown là khối NGUYÊN (không cắt cụt bảng giá), kèm heading mục.
- Trích nguồn `[tên tài liệu]` + chốt chống bịa · **fail-open từng tầng** · công tắc `RAG_MODE=basic` (về dense top-k, không cần deploy lại) · KHÔNG cache.

**CÒN THIẾU (chỉ đáng làm khi kho tài liệu PHÌNH TO — hiện chưa cần):**
- Agentic / multi-hop retrieval (tự tra nhiều vòng). Hiện 1 vòng/lượt.
- Cross-encoder reranker chuyên dụng (Cohere/Voyage) — hiện dùng LLM-rerank + backfill đỡ.
- Bộ đo eval recall/precision trên tập test cố định.
- Multi-query expansion.
- Ở quy mô ~31 đoạn, phương án đơn giản hơn RAG là NHÉT CẢ tài liệu vào prompt (chính xác tuyệt đối) — cân nhắc nếu kho vẫn nhỏ.

**VẬN HÀNH bắt buộc:**
- Đổi schema RAG hoặc đổi `chunkText`/logic ingest → **PHẢI chạy lại** `npx -y tsx src/mastra/scripts/reindexAll.ts` (tuần tự, idempotent) rồi mới deploy.
- Mọi tài liệu admin/khách upload đi qua `ingestDoc`/`updateDoc` → **tự động** vào chuẩn mới (contextualize + embed + full-text). Không có đường tắt.
- Trước deploy: chạy `smokeRagAudit.ts` phải PASS hết. Xem thêm memory `rag-full-pipeline-upgrade`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **vnlink-ai-agent** (1842 symbols, 2853 relationships, 113 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/vnlink-ai-agent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/vnlink-ai-agent/clusters` | All functional areas |
| `gitnexus://repo/vnlink-ai-agent/processes` | All execution flows |
| `gitnexus://repo/vnlink-ai-agent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

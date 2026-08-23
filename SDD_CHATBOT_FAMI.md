# Tài liệu Thiết kế Hệ thống (SDD) — Chatbot tư vấn Fami Fitness

**Phiên bản:** 2.0 (đã hiện thực — xem "Bản đồ module thực tế" bên dưới)
**Nguồn yêu cầu:** tài liệu "Định vị & Vai trò AI Agent" (6 mục; quy trình 5 bước; dự báo nhu cầu 5 dịch vụ; 50 tình huống thực chiến / 8 nhóm khách).
**Hệ thống nền tảng hiện có:** Mastra + Gemini API (`engine/brain.ts`, `rag/retrieve.ts`, `llm/gemini.ts`, `lib/settings.ts`, `prompts/fami.ts`), lưu trữ Postgres/Supabase.

> ## ⚑ v2.0 — 3 QUYẾT ĐỊNH CHỐT VỚI KHÁCH (điều chỉnh so với v1.1 bên dưới)
>
> Bản v2.0 hiện thực theo 3 quyết định của chủ dự án. Nơi nào phần thân (v1.1) mâu thuẫn với 3 điểm này thì **theo v2.0**:
>
> 1. **Kịch bản GIỮ NGUYÊN VĂN, tách giá ra.** L3 (mục 4.4) đổi từ "chắt `leading_strategy` ≤3 câu" sang **lưu NGUYÊN VĂN 50 kịch bản P.A.E.S.C** của tài liệu (`data/scenarios.json`), chọn theo phân loại và bơm 1–2 kịch bản/lượt làm văn mẫu để bot **diễn lại trung thực**. Con số giá trong kịch bản chỉ là minh hoạ; **giá thật lấy từ L4 (RAG)** và được L6 canh (không phát số khi không có nguồn giá).
> 2. **BỎ toàn bộ guardrail y tế.** Gỡ `MedicalSafetyGuard` (L6), bỏ "review an toàn y tế" khi nạp, bỏ ràng buộc y tế ở L0. Persona vốn là chuyên gia sức khỏe dùng ẩn dụ y khoa — đây là nội dung MONG MUỐN. `KnowledgeExplanation store` (L3′, mục 4.4.1) **bỏ** vì các ẩn dụ đã nằm sẵn trong kịch bản nguyên văn; `KnowledgeCode` chỉ còn là TAG gợi ý.
> 3. **Chỉ nhắn tin, không gọi điện.** Mọi chỗ tài liệu nhắc "gọi điện" (III.1, III.5) đã chuyển thành nhắn tin. L7 outbound cũng chỉ nhắn tin.
>
> ### Bản đồ module thực tế (đã code trên nhánh `feat/sdd-fami-rebuild`)
>
> | Tầng | File | Ghi chú |
> |------|------|---------|
> | L0 Persona | `prompts/fami.ts` | Nguyên văn I/II + 80/20 + P.A.E.S.C + FOMO, không guard y tế, messaging-only |
> | Taxonomy | `engine/taxonomy.ts` | ServiceCode/SegmentCode/ObjectionCode/KnowledgeCode + "Từ khóa bổ sung" (gợi ý cho L5) |
> | L1 FSM | `engine/stages.ts` + `lib/convState.ts` | 5 bước, không lùi, lưu `conversation_state` |
> | L2 Needs | `engine/needs.ts` | 5 bản ghi nguyên văn IV.1 + kế thừa |
> | L3 Scenarios | `engine/scenarios.ts` + `data/scenarios.json` + `scripts/ingestScenarios.ts` | 50 kịch bản nguyên văn, bảng `scenario_playbook`, chọn theo phân loại |
> | L4 Facts/RAG | `rag/retrieve.ts` | nhận `fact_query` từ L5 (bỏ 2 lần rewrite) |
> | L5 Classifier | `engine/classifier.ts` + `llm/gemini.ts::generateJson` | JSON {service,segment,objections,stage_move,fact_query}, fail-open |
> | L6 Compliance | `engine/compliance.ts` | chống-bịa-giá + định dạng + nhắc hành động S4/S5; **KHÔNG** guard y tế |
> | L7 Outbound | `engine/outbound.ts` | reminder/followup, chỉ nhắn tin, mặc định `OUTBOUND_MODE=off` |
> | Tích hợp | `engine/brain.ts` | điều phối L0–L6, cờ `SCENARIO_MODE` (off = luồng RAG cũ) |
> | Smoke | `scripts/smokeScenario.ts` | reply thật qua pipeline, senderId test + tự dọn |

---

## 1. Phạm vi

Tài liệu đặc tả một hệ thống điều phối hội thoại chuyển nội dung playbook bán hàng trong tài liệu nguồn thành các thành phần thực thi được, sao cho tác nhân hội thoại (chatbot) **tuân thủ chiến lược tư vấn** và **phủ toàn bộ 50 tình huống** mà không nhồi nguyên văn tài liệu vào ngữ cảnh model.

Ngoài phạm vi: giao diện quản trị (chỉ đặc tả yêu cầu dữ liệu), tích hợp kênh Facebook (đã có), hạ tầng triển khai (đã có `deploy-valdev.sh`).

## 2. Bối cảnh kỹ thuật & lý do kiến trúc

Luồng hiện tại (`engine/brain.ts::runTurn`) là một pipeline RAG đơn: `loadRecent` → `retrieveForTurn` → ghép `FAMI_SYSTEM + timeBlock + docBlock` → một lần `generateReply`. Không có phân loại lượt, không có trạng thái quy trình. Luồng này phù hợp cho truy hồi dữ kiện (giá, gói), nhưng không đủ cho nội dung playbook vì:

1. **Nội dung là hành vi, không phải dữ kiện.** Kịch bản là khuôn hành vi cần diễn lại theo ngữ cảnh; truy hồi rồi chèn nguyên văn dẫn tới sao chép cứng.
2. **Chọn kịch bản là bài toán phân loại, không phải độ tương đồng vector.** Các tình huống mở đầu gần như đồng nhất về mặt ngôn ngữ ("Gym bao nhiêu?"), phân biệt được nhờ suy luận trên toàn hội thoại (dịch vụ, nhóm khách, kiểu từ chối, giai đoạn), không phải khoảng cách embedding.
3. **Chèn nguyên văn hội thoại gây priming.** Đoạn thoại mẫu chứa số giá/khuyến mại cụ thể sẽ bị model tái sử dụng sai ngữ cảnh.
4. **Tài liệu có phân tầng.** Persona (luôn áp dụng), quy trình (điều phối), bản đồ nhu cầu (tra theo dịch vụ), kịch bản (chọn có điều kiện) là bốn loại tri thức dùng ở thời điểm khác nhau; một kho vector phẳng làm mất phân tầng này.

Do đó hệ thống tách nội dung thành 5 tầng nội dung (L0–L4), giữ RAG cho tầng dữ kiện, thêm tầng phân loại lượt (L5) điều phối việc chọn kịch bản, và tầng ép tuân thủ (L6) chặn phát các câu vi phạm bất biến — để phần "phải đúng tuyệt đối" được cưỡng chế bằng mã thay vì phó thác cho model.

## 3. Kiến trúc tổng thể

```
Tin nhắn + lịch sử
      │
      ▼
[L5] Turn Classifier ── phân loại: {service, segment, objections[], stage_move, fact_query}
      │
      ├──────────────┬───────────────┬────────────────┬─────────────────┐
      ▼              ▼               ▼                ▼                 ▼
[L0] Persona   [L1] Sales-Stage  [L2] Needs-Map   [L3] Scenario     [L4] Facts/RAG
     & Rules        FSM (stateful)     Store            Playbook Store     (retrieveForTurn)
      │              │                 │                │                 │
      └──────────────┴───────────────┴────────────────┴─────────────────┘
                     │  Prompt Assembler
                     ▼
              generateReply (1 call, cascade + key rotation)
                     ▼
[L6] Compliance Gate ── validate(reply) → {pass | violations[]}
                     │        └─ nếu vi phạm: repair-regenerate (≤ N lần) → fallback an toàn
                     ▼
              reply đạt chuẩn + persist(history, stage)

Hai đường vào hệ thống:
  (a) INBOUND (khách nhắn)  → runTurn (sơ đồ trên).
  (b) OUTBOUND (hẹn giờ)    → [L7] Scheduler bắn job đến hạn (nhắc lịch / bám đuổi im lặng)
                              → dựng lượt hệ thống → runTurn (tái dùng L0–L6) → gửi chủ động.
```

Thành phần:

| Mã | Thành phần | Loại | Kích hoạt |
|----|-----------|------|-----------|
| L0 | Persona & Rules | Prompt tĩnh | Mọi lượt |
| L1 | Sales-Stage FSM | Máy trạng thái có lưu | Mọi lượt |
| L2 | Needs-Map Store | Bảng tra theo `service` | Khi biết `service` |
| L3 | Scenario Playbook Store | Bảng tra theo `(service, objections)` | Khi phân loại đủ tin cậy |
| L3′ | KnowledgeExplanation Store | Bảng tra theo `KnowledgeCode` | Khi kịch bản/khách chạm kiến thức mồi |
| L4 | Facts/RAG | Hybrid retrieval hiện có | Khi có `fact_query` |
| L5 | Turn Classifier | 1 call LLM nhẹ, xuất JSON | Mọi lượt thực chất |
| L6 | Compliance Gate | Bộ kiểm xác định + vòng sửa | Mọi lượt, sau khi sinh |
| L7 | Outbound Scheduler | Hàng đợi job hẹn giờ + worker | Ngoài luồng inbound (theo mốc thời gian) |

## 4. Đặc tả thành phần

### 4.1 L0 — Persona & Rules

Nguồn: Mục I, II, IV.2. Nội dung: khung năng lực, quy tắc giao tiếp Tảng băng 80/20 (mặc định ẩn dụ phi chuyên ngành; mở lớp kiến thức chuyển hóa chỉ khi khách hỏi "tại sao/cơ chế"), định nghĩa 5 nhịp P.A.E.S.C, nguyên tắc chốt FOMO không xả hết khuyến mại, ràng buộc an toàn y tế.

Hiện thực: mở rộng `prompts/fami.ts::FAMI_SYSTEM`. Phần lớn nội dung đã có; rà bổ sung các điểm còn thiếu so với tài liệu: (a) "bán kết quả, không bán dịch vụ"; (b) quy tắc trả lời "dạng mở có tính thu hút" khi khách hỏi giá nhưng chưa lộ mục tiêu; (c) tự đặt câu hỏi kích hoạt điểm mù rồi tự trả lời.

L0 là văn bản, không chứa dữ kiện giá. Không thay đổi theo lượt.

### 4.2 L1 — Sales-Stage FSM

Nguồn: Mục III. Năm trạng thái:

| stage | Tên | Mục tiêu lượt | Điều kiện chuyển tiếp |
|-------|-----|---------------|----------------------|
| S1 | Tiếp cận & đồng cảm | Chào, xưng hô, đồng cảm mục tiêu | Đã chào và khách phản hồi |
| S2 | Khai thác nhu cầu | Đặt 1 câu hỏi mở tìm mục tiêu/nỗi đau; chưa chốt | Đã xác định được mục tiêu/nỗi đau |
| S3 | Giới thiệu giải pháp & mời trải nghiệm | Kết nối nhu cầu ↔ gói; nhấn quyền lợi trải nghiệm | Khách quan tâm gói/nêu phản đối |
| S4 | Xử lý từ chối & chốt lịch | Đưa 2 mốc giờ; xin họ tên + SĐT | Có lịch hẹn hoặc SĐT |
| S5 | Chăm sóc & nhắc lịch | Xác nhận lịch; nhắc trước 2–4h; hướng dẫn đến | — |

Trạng thái được **lưu theo `senderId`** (mở rộng bảng history hoặc bảng trạng thái riêng). Classifier chỉ đề xuất `stage_move ∈ {hold, advance}`; hệ thống **không cho lùi trạng thái** trừ khi phát hiện reset hội thoại (khách quay lại sau thời gian dài — cấu hình ngưỡng). Mục tiêu của trạng thái hiện tại được chèn vào prompt dưới dạng chỉ thị một dòng.

### 4.3 L2 — Needs-Map Store

Nguồn: Mục IV.1. Bảng đóng, một bản ghi mỗi dịch vụ gốc.

```ts
interface NeedsMapRecord {
  service: ServiceCode;        // khoá
  surface_needs: string[];
  hidden_needs: string[];
}
```

Ví dụ (`swim_kid`): `surface_needs = ["kỹ năng sinh tồn chống đuối nước", "phát triển thể chất/chiều cao", "giải trí lành mạnh"]`; `hidden_needs = ["bảo hiểm tâm lý — gỡ nỗi sợ vô hình", "sự tự do của cha mẹ — bớt canh 24/7"]`.

Cơ chế: tra trực tiếp theo `service` (không dùng vector; ≤ 8 bản ghi). **L2 là tầng chạy sớm**: ở các lượt đầu khách thường giấu mục tiêu (chưa đủ để bind kịch bản), hệ thống dùng L2 để dẫn dắt theo nhu cầu dự báo — đúng chỉ thị Mục IV.1 ("khi chưa có thông tin, dự báo nhu cầu bề nổi và ẩn").

Các nhóm dịch vụ ở Mục V không có bản đồ nhu cầu riêng (swim_adult, swim_4season, weightloss_male/female, metabolic_male) **kế thừa** `NeedsMapRecord` của dịch vụ gốc gần nhất, cộng `hidden_need` khai báo trong từng kịch bản (L3).

### 4.4 L3 — Scenario Playbook Store

Nguồn: Mục V (50 tình huống). Một bản ghi mỗi tình huống.

```ts
interface ScenarioRecord {
  id: string;                  // "gym-01"
  service: ServiceCode;
  segment: SegmentCode;
  objections: ObjectionCode[]; // 1..n — khoá chọn cùng service
  portrait: string;            // chân dung khách
  surface_need: string;
  hidden_need: string;         // tảng băng chìm
  leading_strategy: string;    // 1–3 câu — insight dẫn dắt, KHÔNG phải đoạn thoại
  knowledge_hooks: KnowledgeCode[]; // khái niệm chuyển hóa để giải thích
  funnel_redirect: ServiceCode[];   // phễu mềm (boi_tri_lieu, giai_co_sau, yoga_tri_lieu)
  source_ref: string;          // heading gốc để truy vết
}
```

Ràng buộc nội dung bản ghi:
- `leading_strategy` là chỉ dẫn hành vi ("cho giá mở → dự báo nỗi sợ to cơ → chuyển hướng bơi/giải cơ"), tối đa 3 câu.
- **Không chứa số giá, tên gói, tên khuyến mại.** Mọi dữ kiện định lượng thuộc L4.
- `paesc` chi tiết **không** lưu ở đây — 5 nhịp P.A.E.S.C là quy tắc chung ở L0; L3 chỉ cung cấp nội dung riêng của tình huống (nhu cầu ẩn, chiến lược, kiến thức mồi).

Cơ chế chọn (mục 6). Đoạn thoại mẫu nguyên văn trong tài liệu chỉ dùng ở bước trích xuất (mục 8) để chắt ra các trường trên; không lưu vào prompt runtime.

### 4.4.1 L3′ — KnowledgeExplanation Store (kho ẩn dụ giải thích)

Nguồn: Mục I, II (kiến thức chuyển hóa) + kho tài liệu 23 cuốn sách đã nạp RAG. Lý do tồn tại: `knowledge_hooks` ở L3 chỉ là **mã** (`khang_insulin`, `ty_the`…); nhưng sức thuyết phục của nhịp **Educate** trong P.A.E.S.C nằm ở **đoạn ẩn dụ cụ thể, phi chuyên ngành** ("kháng insulin = cơ thể bị kẹt *công tắc tích mỡ*"). Nếu chỉ đưa mã cho model, độ sâu và tính nhất quán của phần giáo dục nhận thức không đảm bảo tái lập giữa các lượt. L3′ là nơi neo văn bản đó — đã duyệt, dùng chung cho mọi kịch bản chạm cùng khái niệm.

```ts
interface KnowledgeExplanation {
  code: KnowledgeCode;          // khoá — trùng taxonomy 5.4
  one_liner: string;            // 1 câu ẩn dụ chốt (dùng khi chỉ cần chạm nhẹ)
  metaphor: string;             // 2–4 câu: ẩn dụ + ví dụ hình ảnh dễ nhớ, KHÔNG thuật ngữ nặng
  common_mistake: string;       // "điểm mù/sai lầm nhận thức" để bước Awaken tự đặt câu hỏi rồi tự trả lời
  redirect_hint?: ServiceCode[]; // gợi ý bộ môn phù hợp khi kiến thức này dẫn tới giải pháp Fami
}
```

Ràng buộc nội dung:
- **Không chứa số giá/liều/tên thuốc**; không chẩn đoán bệnh, không khẳng định "chữa khỏi" (tuân ràng buộc y tế ở L0/L6). Đây là ẩn dụ nhận thức, không phải tư vấn y khoa.
- Văn phong đúng Tảng băng 80/20: mặc định dùng `one_liner`; chỉ mở `metaphor`/`common_mistake` khi khách hỏi sâu ("tại sao/cơ chế") hoặc khi kịch bản yêu cầu bước Awaken–Educate.
- Một bản ghi mỗi `KnowledgeCode` (11 bản ghi theo mục 5.4). Bảng đóng, tra trực tiếp theo mã (không vector).

Quan hệ với L4: L3′ giữ **cách diễn giải** (ẩn dụ cố định, ít thay đổi); L4 giữ **dữ kiện** (giá/gói/số liệu sách, tra động). Khi khách hỏi sâu vượt kho ẩn dụ, vẫn để L4/RAG bổ sung dẫn chứng từ 23 cuốn sách — L3′ không thay thế RAG mà là lớp "mồi" ngắn, ổn định, chống trôi giọng.

Nạp vào prompt: xem mục 8 (khối `knowledgeBlock`).

### 4.5 L4 — Facts/RAG

Giữ nguyên `rag/retrieve.ts::retrieveForTurn` (hybrid dense/sparse + RRF + rerank + reserve `source_kind` Fami). Đầu vào là `fact_query` do L5 sinh (thay cho việc `rewriteQuery` tự chạy). Đây là nguồn dữ kiện duy nhất cho giá/gói/khuyến mại/kiến thức sách.

### 4.6 L5 — Turn Classifier

Một call LLM nhẹ (`generateReply` với `models: fastModels()`, `temperature: 0`), xuất JSON:

```ts
interface TurnClassification {
  service: ServiceCode | null;
  segment: SegmentCode | null;
  objections: { code: ObjectionCode; confidence: number }[]; // 0..2, giảm dần
  stage_move: "hold" | "advance";
  fact_query: string | null;   // null nếu lượt không cần tra dữ kiện (chào/tâm sự thuần)
}
```

Ràng buộc:
- **L5 là mối quan tâm độc lập, chạy mọi lượt thực chất** — không gộp vào `rewriteQuery`. Lý do: `rewriteQuery` trả `NONE` (bỏ tra cứu) ở các lượt phi-dữ-kiện, nhưng các lượt đó (khách bộc lộ nỗi đau/từ chối, không hỏi giá) lại là lúc cần phân loại nhất. L5 gộp luôn chức năng viết-lại-query thành trường `fact_query` để không thêm call thứ hai cho RAG.
- Không gian nhãn `service/segment/objection` là tập đóng ở mục 5, **bắt buộc có nhánh thoát** `objection = khac_khong_ro` và `service = null`.
- Xuất phải là JSON hợp lệ; áp parse chặt (`JSON.parse` sau khi bóc rào ```); lỗi parse hoặc call lỗi → **fail-open**: `service=null, objections=[], stage_move=hold, fact_query=<câu thô>`.
- Chưa có helper JSON trong `llm/gemini.ts`; bổ sung hàm bọc parse + fail-open.

### 4.7 L6 — Compliance Gate (ép tuân thủ xác định)

L6 là tầng bảo đảm tuân thủ. Nguyên tắc: **các ràng buộc bắt buộc không phó thác cho thiện chí của model** mà được kiểm bằng mã trên câu trả lời đã sinh; vi phạm thì sửa tự động rồi kiểm lại. Nhờ đó nhóm ràng buộc kiểm-được đạt tuân thủ 100% ở runtime (khác với tối ưu-tới-ngưỡng của phần diễn đạt).

Phân loại ràng buộc:

**(A) Bất biến chặn cứng — kiểm 100%, không được phép lọt:**
1. `NumericFactGuard`: trích mọi token số/giá trong `reply` (giá, số tháng, số buổi, %); mỗi token phải xuất hiện trong khối `facts` (L4) đã chèn lượt đó hoặc trong danh mục hằng số cố định (địa chỉ, diện tích đã chốt). Số lạ ⇒ vi phạm.
2. `MedicalSafetyGuard`: phát hiện phát ngôn cấm — kê thuốc/liều, chẩn đoán bệnh, khẳng định "chữa khỏi/đảo ngược" bệnh, khuyên bỏ/đổi thuốc bác sĩ. Việc phát hiện dùng một call phân loại nhị phân (LLM), không dùng danh sách từ khoá. Có ⇒ vi phạm.
3. `PriceHallucinationGuard`: khi `reply` nêu giá nhưng lượt đó `facts` rỗng (không tra được) ⇒ vi phạm (phải chuyển sang câu mời tới trung tâm/kiểm tra lại).

**(B) Ràng buộc hành động theo trạng thái — kiểm theo `stage`:**
4. `StageActionCheck`: ánh xạ mục tiêu bắt buộc của bước hiện tại (L1) sang điều kiện kiểm được trên `reply`. Ví dụ S4 ⇒ phải chứa lời mời hai mốc thời gian **và** đề nghị xin SĐT/tên; S5 ⇒ phải chứa xác nhận lịch. Thiếu ⇒ vi phạm mềm.
5. `PaescCompletenessCheck`: khi `TurnClassification` xác định khách bộc lộ nỗi đau/từ chối (có `objection` đủ tin cậy) mà `reply` thiếu nhịp (không đồng cảm, hoặc không có câu hỏi kích hoạt điểm mù, hoặc không có CTA) ⇒ vi phạm mềm. Kiểm bằng call phân loại 5 nhịp.
6. `SingleFocusCheck`: lượt logistics (S1/S5, hoặc `objection` rỗng) không được nhồi nhiều đề nghị/nhiều gói cùng lúc ⇒ vi phạm mềm.

**(C) Định dạng:** không markdown/bảng/link, độ dài trong ngưỡng (đã có yêu cầu ở L0) — kiểm bằng mã.

Vòng sửa (repair loop):

```
reply = generate(sys, ...)
for attempt in 1..N_REPAIR:                 # N_REPAIR cấu hình, mặc định 2
    v = validate(reply, {facts, stage, cls})   # A + B + C
    if v.hard_violations: 
        reply = regenerate(sys + corrective(v), ...)   # chỉ thị sửa cụ thể
        continue
    if v.soft_violations and attempt < N_REPAIR:
        reply = regenerate(sys + corrective(v), ...)
        continue
    break
if validate(reply).hard_violations:          # vẫn lọt bất biến sau N lần
    reply = SAFE_FALLBACK(stage, cls)         # câu mẫu an toàn: mời tới trung tâm, không số, không y tế
```

`corrective(v)` là chỉ thị ngắn nêu đúng vi phạm ("Câu trả lời chứa giá 4.500k không có trong tài liệu lượt này — bỏ mọi con số, mời khách tới trung tâm để nhận báo giá"). Bất biến nhóm (A) là điều kiện thoát bắt buộc: nếu sau `N_REPAIR` vẫn vi phạm ⇒ dùng `SAFE_FALLBACK`, tuyệt đối không phát câu vi phạm ra kênh. Ràng buộc mềm (B) được cố gắng sửa nhưng không chặn phát nếu (A) đã sạch.

Chi phí: mỗi guard nhóm (A) phần lớn là kiểm bằng mã (rẻ); `MedicalSafetyGuard`/`PaescCompletenessCheck` dùng call phân loại nhẹ. Trường hợp không vi phạm (đa số) chỉ tốn kiểm mã + tối đa 1 call an toàn y tế; có vi phạm mới phát sinh regenerate. Ngưỡng `N_REPAIR` chặn vòng lặp.

Ranh giới bảo đảm: nhóm (A) + (C) là **bất biến kiểm-được ⇒ tuân thủ 100%** (do gate chặn phát). Nhóm (B) và độ khớp kịch bản/diễn đạt là **tối ưu tới ngưỡng nghiệm thu** (mục 11) — không cơ chế nào ép model diễn đạt hay đúng ý đồ tuyệt đối 100%; phần này nâng bằng thiết kế chọn-kịch-bản + vòng sửa + vòng đo offline.

### 4.8 L7 — Outbound Scheduler (chủ động nhắn trước theo hẹn giờ)

Lý do tồn tại: Mục III của tài liệu yêu cầu ba hành vi mà bot phải **tự khởi phát**, không đợi khách nhắn — luồng inbound (`runTurn`) không đáp ứng được:

| Yêu cầu nguồn | Hành vi outbound | Mốc thời gian |
|---------------|------------------|---------------|
| Mục III.1 | Phản hồi ngay khi khách để lại thông tin | ≤ 5 phút |
| Mục III.5 (S5) | Nhắc lịch trước giờ hẹn + hướng dẫn đến | trước 2–4h |
| Kịch bản `silence_followup` (`swim_kid-05`, `swim_adult-07`, `weightloss_female-06`, + mọi lượt khách im lặng) | Bám đuổi khách "đã xem/đọc nhưng im lặng" | sau 18–36h (cấu hình) |

Thiết kế:

```
Bảng scheduled_job {
  id, senderId, kind: "fast_reply" | "reminder" | "followup",
  fire_at: timestamp, payload (jsonb: {stage, appointment?, reason}),
  status: "pending" | "sent" | "cancelled" | "skipped"
}

Worker (cron/interval, 1 tiến trình, concurrency=1):
  for job in due(now):                       # fire_at ≤ now, status=pending
    if cancel_condition(job): mark "cancelled"; continue   # khách đã trả lời/đã đến/opt-out
    if not outbound_window_ok(job): mark "skipped"; continue  # ngoài chính sách FB 24h (mục 15)
    sys   = assemble(... , outboundDirective(job.kind, job.payload))  # chỉ thị riêng cho lượt chủ động
    reply = runTurnSystem(job.senderId, sys)  # tái dùng L0–L6 + Compliance Gate y hệt inbound
    send(job.senderId, reply); mark "sent"
```

Nguyên tắc:
- **Tái dùng toàn bộ L0–L6.** Lượt outbound đi qua đúng Compliance Gate (không bịa giá, không vi phạm y tế, đúng định dạng) như lượt inbound — không có đường phát nào lách gate.
- **Lên lịch ở đâu:** mỗi lượt inbound, sau khi chốt/`saveState`, tính job kế tiếp — chốt hẹn ở S4 ⇒ đặt `reminder` trước 2–4h; khách để lại info mà chưa được trả trong 5' ⇒ `fast_reply` (thực tế bot trả ngay nên job này chủ yếu là lưới an toàn khi nghẽn); hết lượt mà khách chưa hồi ⇒ đặt `followup`.
- **Huỷ khi hết điều kiện (`cancel_condition`):** khách nhắn lại trước khi job bắn ⇒ huỷ `followup`; khách đã tới/đã huỷ hẹn ⇒ huỷ `reminder`. Tránh nhắn trùng/nhắn vô duyên.
- **Chống làm phiền:** tối đa N lần bám đuổi/khách (cấu hình, mặc định 1–2); tôn trọng giờ VN (không nhắn khuya — dùng lại logic kíp trực/giờ VN đã có); tôn trọng opt-out.
- **Ràng buộc nền tảng (Facebook):** chỉ gửi ngoài cửa sổ 24h khi dùng message tag hợp lệ; nếu chính sách không cho, `followup`/`reminder` phải rơi về **hàng chờ cho nhân viên người** thay vì bot tự gửi. Ranh giới này phải chốt ở Mục 15 trước khi bật.
- **Fail-safe:** worker lỗi/không chạy ⇒ chỉ mất tính chủ động, luồng inbound không ảnh hưởng. Job không cache; đọc trạng thái mới mỗi lần chạy.

Phạm vi v1.1: đặc tả cơ chế. Việc **bật** outbound phụ thuộc chốt chính sách FB + xác nhận khách muốn bot (hay nhân viên) đảm nhận bám đuổi — nếu khách chọn nhân viên, L7 thu hẹp còn "sinh nội dung gợi ý + đẩy vào hàng chờ người", vẫn phủ đúng ý đồ tài liệu.

## 5. Taxonomy phân loại

### 5.1 `ServiceCode`
`swim_kid` · `swim_adult` · `gym` · `swim_4season` · `yoga` · `weightloss_male` · `weightloss_female` · `metabolic_male` · `null` (chưa xác định).

### 5.2 `SegmentCode` (thuộc tính phụ, mô tả nhân khẩu/bối cảnh)
`phu_huynh` · `nguoi_lon_tuoi` · `nu_van_phong` · `me_bim` · `phu_nu_sau_sinh` · `nu_trung_nien` · `nam_trung_nien` · `nam_doanh_nhan` · `skinny_fat` · `ex_athlete` · `khac`.

### 5.3 `ObjectionCode` (khoá chọn kịch bản chính)

| Mã | Định nghĩa |
|----|-----------|
| `price_probe` | Hỏi dò giá/tìm gói rẻ, chưa lộ mục tiêu |
| `price_hide_goal` | Hỏi giá nhưng giấu mục tiêu/nỗi đau thật |
| `price_doubt_value` | Do dự về giá, chưa thấy giá trị toàn diện |
| `price_compare` | So sánh giá với nơi khác / bể ngoài trời |
| `procrastinate_busy` | Viện cớ bận rộn / trì hoãn (để hè) |
| `fear_water` | Nhát nước / sợ sặc / sợ nước sâu / sợ nước lạnh |
| `fear_body_change` | Sợ tập nặng bị to cơ / đau mỏi / sợ mồ hôi |
| `fear_fail_yoyo` | Từng thất bại nhiều lần, sợ hiệu ứng Yoyo / mất tiền |
| `trial_only` | Chỉ muốn tập thử ngắn hạn, ngại thẻ dài hạn |
| `medical_therapy` | Đau khớp/thoát vị/sau sinh/bệnh lý, tìm giải pháp trị liệu |
| `silence_followup` | Đã xem/đọc nhưng im lặng, cần bám đuổi |
| `indecisive_service` | Đắn đo giữa hai dịch vụ (Gym hay Bơi) |
| `deny_need` | Phủ nhận nhu cầu vóc dáng, nêu lý do khác ("giãn gân cốt", "dễ ngủ", "cho khỏe") |
| `low_commitment` | Đăng ký cho có phong trào / thiếu cam kết |
| `belief_wrong_method` | Niềm tin sai ("nhịn ăn là được") |
| `savvy_defensive` | Phòng thủ cao / sành sỏi, giấu thất bại cũ |
| `khac_khong_ro` | Ngoài tập trên — nhánh thoát, fail-open về L0+L2 |

`fear_slow_learn` (sợ học lâu không biết bơi) và `fear_cold_water` (sợ nước lạnh) gộp vào `fear_water`; phân biệt tinh hơn bằng `knowledge_hooks`/nội dung bản ghi.

### 5.4 `KnowledgeCode` (kiến thức mồi để giải thích)
`ty_the` · `khang_insulin` · `fructose` · `cortisol` · `hieu_ung_yoyo` · `axit_lactic` · `testosterone_nu` · `he_vi_sinh` · `mo_noi_tang` · `tofi` · `nan_doi_vi_chat`.

Mỗi mã có **đúng một bản ghi `KnowledgeExplanation`** trong kho L3′ (mục 4.4.1) chứa ẩn dụ/ví dụ/điểm-mù đã duyệt. `knowledge_hooks` của mỗi kịch bản (L3) tham chiếu tập con các mã này; khi lắp prompt, mã được **giải mã thành văn bản** qua L3′ (không đưa mã trần cho model).

## 6. Cơ chế chọn kịch bản (L3 selection)

Đầu vào: `TurnClassification` + `stage`.

```
if service == null:                       // chưa xác định dịch vụ
    scenarios = []                         // chỉ L0 + (L2 nếu suy được service mặc định) + L4
elif objections is empty OR max(confidence) < θ_bind:
    scenarios = []                         // dùng L2 (needs-map) dẫn dắt, chưa bind kịch bản
else:
    cand = query(service == service AND objections ∩ classified_objections ≠ ∅)
    rank cand by (# objection trùng, khớp segment, confidence)
    scenarios = top-K (K = 2)              // gộp hidden_need/strategy của tối đa 2 bản ghi
```

Tham số: `θ_bind` (ngưỡng tin cậy để bind kịch bản, cấu hình; khởi đầu 0.6). Không dùng similarity vector, không dùng keyword-match. Tra bảng bằng khoá phân loại. Nếu `cand` rỗng dù đủ tin cậy (kịch bản chưa số hoá) → fail-open về L2.

**Binding tăng dần:** ở lượt đầu `objections` thường rỗng/độ chắc thấp → chưa bind (dùng L2). Khi hội thoại tiến, độ chắc tăng → bind kịch bản → tinh chỉnh khi nhãn đổi.

## 7. Luồng xử lý một lượt

```
runTurn(senderId, message):
  history = loadRecent(senderId)                       # lib/history
  state   = loadState(senderId)                        # stage hiện tại (mới)
  cls     = classify(history, message)                 # L5, fail-open
  stage   = advanceStage(state.stage, cls.stage_move)  # L1, không lùi
  needs   = needsMap(cls.service)                      # L2 (có kế thừa)
  scen    = selectScenarios(cls, stage)                # L3, mục 6
  know    = explainKnowledge(scen.knowledge_hooks)     # L3′, giải mã KnowledgeCode → văn bản
  facts   = cls.fact_query ? retrieveForTurn({message, history, query: cls.fact_query}) : ""  # L4
  sys     = assemble(FAMI_SYSTEM, timeBlock, stageDirective(stage),
                     needsBlock(needs), scenarioBlock(scen), knowledgeBlock(know), facts)   # mục 8
  reply   = generateReply([sys, ...history, userMsg], {temperature:0.6, maxTokens:700})
  reply   = complianceGate(reply, {facts, stage, cls})   # L6: validate → repair ≤ N → SAFE_FALLBACK
  appendMessage(senderId,"user",message); appendMessage(senderId,"assistant",reply)
  saveState(senderId, {stage})
  scheduleOutbound(senderId, stage, cls)                # L7: đặt/huỷ job reminder|followup (mục 4.8)
  return reply
```

`runTurn` là đường **inbound**. Đường **outbound** (L7) dựng một lượt hệ thống rồi gọi lại chính pipeline này với `outboundDirective` thay cho `userMsg` — mọi tầng L0–L6 và Compliance Gate áp dụng y hệt.

Chi phí gọi model mỗi lượt (đường không vi phạm): **L5 (nhẹ) + trả lời chính + tối đa 1 call an toàn y tế** ở L6; các guard còn lại của L6 là kiểm mã. L5 thay thế vai trò `rewriteQuery` nên không thêm call cho RAG. Đường có vi phạm phát sinh thêm ≤ `N_REPAIR` call regenerate. Rerank của L4 giữ nguyên.

Fail-open theo tầng: L5 lỗi → phân loại rỗng → bỏ L3, chạy L0+L2+L4 (tương đương hành vi hiện tại). L4 lỗi → `facts=""`. L3 rỗng → bỏ khối kịch bản. L6 luôn chạy; nếu chính guard lỗi (vd call y tế lỗi) → coi như vi phạm để an toàn (ưu tiên `SAFE_FALLBACK` thay vì phát câu chưa kiểm được). Không tầng nào lỗi làm dừng lượt.

## 8. Lắp ghép prompt & ngân sách token

Thứ tự khối trong `system`:
1. `FAMI_SYSTEM` (L0) — tĩnh.
2. `timeBlock` — giờ VN + kíp trực (đã có).
3. `stageDirective` — 1 dòng mục tiêu trạng thái hiện tại (L1).
4. `needsBlock` — nhu cầu nổi/ẩn của `service` (L2), ≤ 6 dòng.
5. `scenarioBlock` — với mỗi kịch bản chọn: chân dung + nhu cầu ẩn + chiến lược + kiến thức mồi + phễu (L3), ≤ ~10 dòng/kịch bản, tối đa 2 kịch bản.
6. `knowledgeBlock` — văn bản ẩn dụ (`one_liner`/`metaphor`/`common_mistake`) của các `KnowledgeCode` mà kịch bản chạm, giải mã từ L3′ (mục 4.4.1), ≤ ~3 dòng/khái niệm, tối đa 2 khái niệm/lượt. Đưa dưới dạng "chất liệu để giải thích khi cần", không bắt buộc dùng hết.
7. `facts` — khối tài liệu có trích nguồn (L4).

Ước lượng: L0 ~2k token (đo `FAMI_SYSTEM` hiện tại), L1/L2/L3/L3′ cộng thêm ~0.8–1.5k, L4 ≤ 5 đoạn như hiện tại. Tổng nằm trong ngân sách của luồng hiện hành. Cần đo lại sau khi số hoá.

Quy tắc chống priming trong `scenarioBlock`: chèn dưới dạng chỉ thị ("Bối cảnh & chiến lược cho tình huống này: …"), không dưới dạng đoạn hội thoại ví dụ; giữ nguyên ràng buộc "diễn lại bằng lời, không chép, không lộ khung, không đánh số nhịp" đã có ở L0.

## 9. Đặc tả trích xuất (ingestion)

Script chạy lại được (một lần, có bước review người), không thuộc hot path.

Đầu vào: tài liệu nguồn đã tách theo heading. Ánh xạ:

| Mục nguồn | Đích | Cách trích |
|-----------|------|-----------|
| III | `sales_stage` (5) | Trích trực tiếp mục tiêu + điều kiện chuyển tiếp |
| IV.1 | `needs_map` (5) | Trích trực tiếp danh sách nhu cầu nổi/ẩn |
| V.1.1–1.8 | `scenario_playbook` (50) | Mỗi tình huống → 1 bản ghi qua prompt chắt lọc |
| I, II + kho 23 sách (RAG) | `knowledge_explanation` (11) | Mỗi `KnowledgeCode` → 1 bản ghi ẩn dụ; **review y tế bắt buộc** (không chẩn đoán/không "chữa khỏi") |
| I, II, IV.2 | `FAMI_SYSTEM` | Rà & bổ sung thủ công |

Contract của prompt chắt lọc `scenario_playbook` (một call LLM/tình huống, model mạnh, review người sau):
- Đầu vào: toàn văn khối tình huống (gồm phân tích chân dung + đoạn thoại mẫu).
- Đầu ra JSON theo `ScenarioRecord` (mục 4.4).
- Ràng buộc: `leading_strategy` ≤ 3 câu; **loại bỏ mọi số giá/tên gói/tên khuyến mại**; `objections` gán từ taxonomy 5.3; `knowledge_hooks` gán từ 5.4; `id` = `<service>-NN`.

Đầu ra ingestion là ~71 bản ghi (5 stage + 5 needs + 50 scenario + 11 knowledge_explanation); review từng bản ghi trước khi nạp (riêng knowledge_explanation qua thêm bước duyệt an toàn y tế).

## 10. Bản đồ phủ kịch bản (50/50)

Ký hiệu objection theo mục 5.3. `KH` = knowledge_hooks tiêu biểu.

### 10.1 swim_kid — Bơi cho con (5) · segment `phu_huynh`
| id | Tình huống nguồn | objections | Nhu cầu ẩn (tóm) |
|----|------------------|-----------|------------------|
| swim_kid-01 | KB1 Hỏi dò giá ban đầu | `price_probe` | Con bơi vững thật, không ốm vặt |
| swim_kid-02 | TH2 Do dự giá, chưa thấy giá trị | `price_doubt_value` | An tâm giá trị toàn diện |
| swim_kid-03 | TH3 Viện cớ bận / để hè | `procrastinate_busy` | Sợ rủi ro đuối nước không chờ được |
| swim_kid-04 | KB4 Lo con nhát nước/sợ nước sâu | `fear_water` | Con an toàn, có khu riêng |
| swim_kid-05 | KB5 Bám đuổi khi đã đọc chưa phản hồi | `silence_followup` | Chưa đủ tin, cần lý do quay lại |

### 10.2 swim_adult — Người lớn học bơi (7) · segment `nguoi_lon_tuoi`/`khac`
| id | Tình huống nguồn | objections | Nhu cầu ẩn (tóm) |
|----|------------------|-----------|------------------|
| swim_adult-01 | TH1 Nhát nước, tự ti tuổi tác | `fear_water` | Vượt mặc cảm tuổi tác |
| swim_adult-02 | TH2 Đau xương khớp/thoát vị/thừa cân → bơi trị liệu | `medical_therapy` | Giảm đau, phục hồi an toàn |
| swim_adult-03 | TH3 So sánh giá bể ngoài trời | `price_compare` | Chất lượng/an toàn hơn giá rẻ |
| swim_adult-04 | TH4 Sợ nước lạnh mùa thu đông | `fear_water` | Không ốm, duy trì được |
| swim_adult-05 | TH5 Sợ học lâu không biết bơi/sặc | `fear_water` | Cam kết biết bơi |
| swim_adult-06 | TH6 Bận rộn trì hoãn | `procrastinate_busy` | Ưu tiên hoá sức khỏe |
| swim_adult-07 | TH7 Đã xem nhưng im lặng (24–36h) | `silence_followup` | Đắn đo, cần thúc nhẹ |

### 10.3 gym — Tập Gym (6)
| id | Tình huống nguồn | segment | objections | KH |
|----|------------------|---------|-----------|----|
| gym-01 | TH1 Hỏi giá giấu mục tiêu (sợ to cơ) | `nu_van_phong` | `price_hide_goal`,`fear_body_change` | testosterone_nu, axit_lactic |
| gym-02 | TH2 Từng thất bại/Yoyo, béo phì lâu năm | `nu_trung_nien` | `fear_fail_yoyo` | khang_insulin, ty_the, hieu_ung_yoyo |
| gym-03 | TH3 Muốn giảm cân cấp tốc, đắn đo Gym/Bơi | `khac` | `indecisive_service` | ty_the |
| gym-04 | TH4 Hỏi giá cộc lốc, giấu mục tiêu | `khac` | `price_hide_goal` | — |
| gym-05 | TH5 Mẹ bỉm bận, con nhỏ trì hoãn | `me_bim` | `procrastinate_busy` | cortisol |
| gym-06 | TH6 Sợ thẻ năm phí, chỉ tập thử 1 tháng | `khac` | `trial_only`,`fear_fail_yoyo` | — |

### 10.4 swim_4season — Bơi bốn mùa (6)
| id | Tình huống nguồn | segment | objections | KH |
|----|------------------|---------|-----------|----|
| swim_4season-01 | TH1 Nữ 42 hỏi giá bơi năm, giấu giảm mỡ bụng & đau | `nu_trung_nien` | `price_hide_goal` | mo_noi_tang |
| swim_4season-02 | TH2 Nam 48 hỏi vé lẻ, giấu bụng bia & gan | `nam_trung_nien` | `price_hide_goal` | mo_noi_tang |
| swim_4season-03 | TH3 Nữ 50 do dự giá, sợ đau khớp, từng thất bại | `nu_trung_nien` | `price_doubt_value`,`medical_therapy`,`fear_fail_yoyo` | hieu_ung_yoyo |
| swim_4season-04 | TH4 Nữ 42 hỏi giá vé, giấu kháng insulin | `nu_trung_nien` | `price_hide_goal` | khang_insulin |
| swim_4season-05 | TH5 Nam 48 doanh nhân bụng bia, giấu sợ đột quỵ | `nam_doanh_nhan` | `price_hide_goal` | mo_noi_tang, cortisol |
| swim_4season-06 | TH6 Nữ 50 phòng thủ cao, thất bại nhiều nơi | `nu_trung_nien` | `savvy_defensive`,`fear_fail_yoyo` | hieu_ung_yoyo |

### 10.5 yoga — Yoga (10)
| id | Tình huống nguồn | segment | objections | KH |
|----|------------------|---------|-----------|----|
| yoga-01 | TH1 Đau vai gáy, giấu tự ti mỡ bụng dưới | `nu_van_phong` | `deny_need` | cortisol |
| yoga-02 | TH2 Sau sinh, "cho khỏe", mặc cảm cơ thể | `phu_nu_sau_sinh` | `deny_need` | he_vi_sinh |
| yoga-03 | TH3 U50 "dễ ngủ", thực chất mỡ máu/tiền tiểu đường | `nu_trung_nien` | `deny_need` | khang_insulin |
| yoga-04 | TH4 Skinny Fat, mệt mỏi mạn tính | `skinny_fat` | `deny_need` | ty_the, nan_doi_vi_chat |
| yoga-05 | TH5 Chê giá Yoga năm cao, viện cớ bận | `nu_van_phong` | `price_high` → `price_doubt_value`,`procrastinate_busy` | — |
| yoga-06 | TH6 "Giãn gân cốt", béo ẩn TOFI | `khac` | `deny_need` | tofi |
| yoga-07 | TH7 Sợ mồ hôi/tập nặng, khớp yếu → Yoga+Bơi | `khac` | `fear_body_change` | axit_lactic |
| yoga-08 | TH8 Đăng ký cho có phong trào | `khac` | `low_commitment` | ty_the, nan_doi_vi_chat |
| yoga-09 | TH9 Từng tập Yoga bỏ dở, giấu tăng cơ giảm mỡ | `khac` | `low_commitment`,`price_hide_goal` | — |
| yoga-10 | TH10 Khảo giá vắn tắt, sợ mất tiền | `khac` | `price_probe`,`fear_fail_yoyo` | — |

### 10.6 weightloss_male — Nam giảm cân (5) · segment `nam_trung_nien`
| id | Tình huống nguồn | objections | KH |
|----|------------------|-----------|----|
| weightloss_male-01 | TH1 Bận rộn, hỏi giá chung chung, che lo bụng bia | `price_hide_goal`,`procrastinate_busy` | mo_noi_tang |
| weightloss_male-02 | TH2 Chỉ muốn bơi "cho mát", giấu đau khớp thừa cân | `deny_need`,`medical_therapy` | — |
| weightloss_male-03 | TH3 Sành sỏi hỏi máy móc, giấu thất bại nhiều nơi | `savvy_defensive` | ty_the |
| weightloss_male-04 | TH4 "Xả stress", lờ nguy cơ sinh hóa | `deny_need` | cortisol, khang_insulin |
| weightloss_male-05 | TH5 So sánh giá, hờ hững nhưng cần cam kết | `price_compare` | — |

### 10.7 weightloss_female — Nữ giảm cân (6)
| id | Tình huống nguồn | segment | objections | KH |
|----|------------------|---------|-----------|----|
| weightloss_female-01 | TH1 Mất niềm tin vì Yoyo | `nu_trung_nien` | `fear_fail_yoyo` | hieu_ung_yoyo, ty_the |
| weightloss_female-02 | TH2 Văn phòng đau cổ vai gáy & béo bụng dưới | `nu_van_phong` | `medical_therapy`,`deny_need` | cortisol |
| weightloss_female-03 | TH3 Mẹ bỉm che tự ti bằng "bận chăm con" | `me_bim` | `procrastinate_busy` | — |
| weightloss_female-04 | TH4 Hỏi gói 1 tháng "tập thử" vì sợ Yoyo | `nu_trung_nien` | `trial_only`,`fear_fail_yoyo` | hieu_ung_yoyo |
| weightloss_female-05 | TH5 Hoài nghi, so sánh giá, che thiếu kiên trì | `nu_trung_nien` | `price_compare`,`savvy_defensive` | — |
| weightloss_female-06 | TH6 "Đã xem" và im lặng | `nu_trung_nien` | `silence_followup` | — |

### 10.8 metabolic_male — Nam giảm cân & cân bằng chuyển hóa (5) · segment `nam_trung_nien`/`nam_doanh_nhan`
| id | Tình huống nguồn | objections | KH |
|----|------------------|-----------|----|
| metabolic_male-01 | TH1 Bụng bia & bẫy quan hệ đối tác (nhậu) | `deny_need` | mo_noi_tang, khang_insulin |
| metabolic_male-02 | TH2 Từng chơi thể thao, nay đau khớp & tăng cân | `medical_therapy` | ty_the |
| metabolic_male-03 | TH3 Mất ngủ, ngáy to, suy kiệt mạn tính | `deny_need` | cortisol, mo_noi_tang |
| metabolic_male-04 | TH4 "Nhịn ăn là được", không cần gói dài hạn | `belief_wrong_method` | khang_insulin, ty_the, nan_doi_vi_chat |
| metabolic_male-05 | TH5 Kiểm soát thời gian, sợ mua gói lớn bỏ phí | `trial_only`,`time_strict` → `trial_only` | — |

Tổng: 5 + 7 + 6 + 6 + 10 + 5 + 6 + 5 = **50 bản ghi**. Mục III (5 stage), Mục IV.1 (5 needs), Mục I/II/IV.2 (persona) phủ ngoài bảng trên.

## 11. Đảm bảo tuân thủ & đánh giá

Độ tuân thủ đến từ ba lớp cộng dồn: (i) **ép xác định ở runtime** (L6) cho các bất biến kiểm-được ⇒ 100%; (ii) ràng buộc thiết kế nâng độ khớp; (iii) vòng đo offline tối ưu phần còn lại tới ngưỡng nghiệm thu.

Ràng buộc thiết kế: (a) mỗi lượt chỉ chèn ≤ 2 kịch bản liên quan; (b) chọn bằng phân loại, có nhánh thoát; (c) dữ kiện tách khỏi kịch bản; (d) trạng thái quy trình có lưu, không lùi; (e) L6 chặn phát mọi câu vi phạm bất biến.

Phân định mức bảo đảm:
- **Tuân thủ 100% (bất biến, gate L6 chặn phát):** không bịa giá/số ngoài L4; không vi phạm an toàn y tế; đúng định dạng; ở S4/S5 có hành động bắt buộc của bước (hoặc rơi về `SAFE_FALLBACK`).
- **Tối ưu tới ngưỡng (biến ngẫu nhiên của model):** phân loại đúng service/objection, khớp kịch bản, đủ nhịp P.A.E.S.C, chất lượng diễn đạt.

Bộ đánh giá (mở rộng các script `smoke*` hiện có, ví dụ `smokeRealcase.ts`/`smokePaesc.ts`):
- **Tập kiểm thử:** 50 tình huống nguồn, mỗi tình huống ≥ 1 lượt mở đầu + lượt bộc lộ.
- **Chỉ tiêu đo mỗi lượt:** (1) phân loại đúng `service`/`objection` so nhãn kỳ vọng; (2) kịch bản chọn khớp; (3) đủ nhịp P.A.E.S.C khi khách bộc lộ nỗi đau; (4) không có số giá ngoài L4; (5) không vi phạm ràng buộc y tế.
- **Ngưỡng nghiệm thu:** đặt trước khi build (ví dụ ≥ 90% phân loại đúng service, ≥ 80% khớp objection, 0% bịa giá, 0% vi phạm y tế). Chỉ số (4)(5) là chặn cứng (0 lỗi).
- **Vòng lặp:** đo → sửa nhãn/bản ghi/ngưỡng → đo lại.

Quan hệ với L6: chỉ tiêu (4)(5) (bịa giá, y tế) được **gate L6 chặn phát ở runtime** ⇒ mục tiêu 0 lỗi là bắt buộc và cưỡng chế được, không chỉ đo. Bộ đánh giá offline dùng để bắt sớm và tối ưu (1)–(3); (4)(5) trong eval là kiểm hồi quy cho chính L6 (đảm bảo gate không hở).

## 12. Tích hợp với hệ thống hiện tại

| Module hiện có | Thay đổi |
|----------------|----------|
| `engine/brain.ts::runTurn` | Chèn bước L5 (classify) + `loadState/saveState`; thay lời gọi `retrieveForTurn` bằng biến thể nhận `fact_query`; mở rộng `assemble` với stage/needs/scenario block |
| `rag/retrieve.ts` | `retrieveForTurn` nhận `query` từ ngoài (bỏ tự `rewriteQuery` khi đã có `fact_query`); giữ hybrid/rerank/reserve |
| `llm/gemini.ts` | Thêm helper gọi JSON có parse chặt + fail-open cho L5; dùng `fastModels()` |
| `lib/settings.ts` | Đọc thêm cấu hình `θ_bind`, ngưỡng reset hội thoại; giữ pattern đọc mỗi lượt |
| `prompts/fami.ts` | Rà bổ sung L0 từ Mục I/II/IV.2 |
| `lib/history` | Thêm lưu `stage` theo `senderId` (bảng trạng thái hoặc cột mở rộng) |
| `engine/compliance.ts` *(mới)* | L6: các guard (mã + call phân loại), `validate`, `corrective`, `SAFE_FALLBACK`, vòng repair |
| `engine/knowledge.ts` *(mới)* | L3′: `explainKnowledge(codes)` tra bảng `knowledge_explanation`, dựng `knowledgeBlock` |
| `engine/outbound.ts` *(mới)* + worker | L7: `scheduleOutbound`/`cancel`, worker quét job đến hạn, `runTurnSystem`, guard cửa sổ 24h + giờ VN |

Kho dữ liệu mới (Postgres/Supabase): `sales_stage`, `needs_map`, `scenario_playbook`, `knowledge_explanation`, `conversation_state`, `scheduled_job`. Đọc mỗi lượt (không cache), sửa được qua quản trị.

## 13. Cấu hình & vận hành

- Cờ môi trường: `SCENARIO_MODE=off` (thoát hiểm → chạy đúng luồng RAG hiện tại), `THETA_BIND`, `CLASSIFIER_MODELS` (mặc định `fastModels()`), `N_REPAIR` (số lần sửa của L6, mặc định 2), `COMPLIANCE_GATE=on` (không tắt ở prod; tắt chỉ để thử nghiệm).
- Cờ outbound (L7): `OUTBOUND_MODE=off|bot|human_queue` (mặc định `off` tới khi chốt chính sách FB), `FOLLOWUP_DELAY_H` (mặc định 24), `REMINDER_LEAD_H` (mặc định 3), `FOLLOWUP_MAX` (số lần bám đuổi tối đa/khách, mặc định 1), `OUTBOUND_QUIET_HOURS` (khung giờ VN không nhắn).
- Không cache: mọi bảng đọc mới mỗi lượt; tái dùng connection pool.
- Nguồn dữ kiện: giá/gói/khuyến mại chỉ ở L4; L1–L3 không chứa số.
- Nhãn phân loại là tập đóng có nhánh thoát; tình huống ngoài tập → fail-open, ghi log để mở rộng taxonomy.

## 14. Rủi ro kỹ thuật & xử lý

| Rủi ro | Xử lý |
|--------|-------|
| Phân loại sai kịch bản | Ngưỡng `θ_bind`; nhánh thoát; fail-open L2; đo bằng bộ kiểm thử |
| JSON L5 không hợp lệ (flash-lite) | Parse chặt + fail-open; prompt ép schema; ví dụ few-shot ngắn trong prompt L5 |
| Bind kịch bản quá sớm (tin đầu giấu mục tiêu) | Binding tăng dần; L2 dẫn dắt trước; `θ_bind` |
| Bịa giá | Tách số sang L4; ingestion loại số khỏi L3; **`NumericFactGuard`/`PriceHallucinationGuard` (L6) chặn phát** → `SAFE_FALLBACK` |
| Vi phạm an toàn y tế | `MedicalSafetyGuard` (L6) chặn phát; kiểm hồi quy trong eval |
| Repair loop không hội tụ | `N_REPAIR` hữu hạn → `SAFE_FALLBACK` (không bao giờ phát câu vi phạm bất biến) |
| Guard bắt nhầm (false positive) chặn câu hợp lệ | Ngưỡng thận trọng cho guard mã; guard LLM dùng model đủ mạnh; đo tỉ lệ false-positive trong eval, hiệu chỉnh |
| Trạng thái dao động | Lưu `stage`, chỉ hold/advance; ngưỡng reset hội thoại |
| Phình token | Giới hạn ≤ 2 kịch bản + ≤ 2 khái niệm/lượt, ≤ ~10 dòng/kịch bản; đo tổng sau số hoá |
| Taxonomy thiếu nhãn | Nhánh `khac_khong_ro` + log để bổ sung định kỳ |
| Ẩn dụ kiến thức trượt thành tư vấn y khoa | L3′ duyệt an toàn y tế khi nạp; L6 `MedicalSafetyGuard` chặn phát ở runtime |
| Outbound nhắn trùng/làm phiền | `cancel_condition` huỷ khi khách đã hồi/đã đến; `FOLLOWUP_MAX`; `OUTBOUND_QUIET_HOURS`; tôn trọng opt-out |
| Vi phạm chính sách gửi ngoài 24h của Facebook | `OUTBOUND_MODE=human_queue` (đẩy nhân viên gửi) khi chưa đủ điều kiện message tag; chốt ở Mục 15 trước khi bật `bot` |

## 15. Phụ thuộc đầu vào cần chốt trước khi số hoá

- Bảng giá & gói dịch vụ chính thức (nguồn L4 duy nhất).
- Quy tắc khuyến mại/quà tặng + điều kiện (danh mục quà: giải cơ sâu, đo InBody, vé bơi trải nghiệm…); có dùng lối "xin duyệt suất đặc biệt" tạo khan hiếm hay không.
- Ranh giới nội dung cấm (cam kết số cân, so sánh đối thủ, khẳng định chữa bệnh).
- Thông tin cố định cần thống nhất — mâu thuẫn trong tài liệu nguồn: diện tích trung tâm ghi cả **3.500m²** và **800m²**; địa chỉ **32A Nguyễn Chí Thanh, Vĩnh Yên** cần xác định tỉnh.
- Xưng hô & giọng: "em" / "anh–chị", văn phong nhắn tin tự nhiên.
- **Chi tiết đón tiếp (S5)** để bot hướng dẫn khách đúng như Mục III.5: chỗ gửi xe, trang phục cần mang, tên nhân viên/quầy lễ tân đón, mốc giờ mở cửa.
- **Nguồn ẩn dụ cho `knowledge_explanation` (L3′):** duyệt danh sách 11 khái niệm + văn bản ẩn dụ đã chắt (từ Mục I/II + 23 sách RAG), ký duyệt an toàn y tế trước khi nạp.
- **Chính sách outbound (L7):** khách muốn **bot tự** bám đuổi/nhắc lịch hay chỉ **nhân viên người** làm; điều kiện dùng message tag của Facebook để gửi ngoài cửa sổ 24h; khung giờ được phép nhắn; số lần bám đuổi tối đa.

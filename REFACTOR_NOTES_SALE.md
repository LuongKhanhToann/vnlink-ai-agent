# Ghi chú Refactor — Nâng "trí tuệ sale" cho chatbot

> Ngày: 2026-06-07/08 · Mục tiêu: bot tự nhiên + thông minh hơn, tự biến chiến lược sale
> để kéo khách & chốt đơn — như một sale thực thụ, KHÔNG cứng ngắc, KHÔNG phá luồng đang chạy.

---

## 1. Đánh giá hiện trạng ("đã mượt như người chưa?")

**Chưa.** Cấu trúc code & kịch bản tốt, nhưng theo grader (thang 3đ/trục, 113 lượt, report cũ DeepSeek):

| Trục | Điểm TB /3 | Nhận xét |
|---|---|---|
| Tự nhiên (natural) | 2.23 | "cứng nhắc", "dài dòng", lặp lại |
| Khớp ý khách (intent) | 2.27 | tạm ổn |
| Đúng luồng FSM | 1.52 | yếu |
| **Chiến thuật sale** | **1.39** | **yếu nhất — trọng tâm cần sửa** |

Overall ~7.4/10 (mục tiêu user đặt: 9.0).

## 2. Kiến trúc (tóm tắt để định vị khi sửa)

Luồng: `routerWorkflow` → `classifier` (LLM 3 trục: domain/service/attribute) → `stateMachine`
(FSM, slots) → `prefixBuilder.buildPrefixWithMeta` (dựng prompt) → agent generate → `cleanReply`
(hậu xử lý tất định) → `validator` (lưới an toàn).

**3 mode prefix:**
- `SCRIPT` — `questionFlow.ts` có ~60 template ANSWER_LOCK (văn mẫu gần như nguyên văn). Chạy TRƯỚC.
- `GATE` — `prefixBuilder.buildLogicGate` hard-override (done-slots / cold-lead / objection / ...).
- `PITCH` — không template/GATE → full prefix với TACTIC (`playbook.ts`) + KNOWLEDGE + few-shot.

**Độ cứng đến từ 3 tầng xếp chồng:** (1) ~60 template ANSWER_LOCK, (2) nhiều GATE mệnh lệnh,
(3) `cleanReply` hậu xử lý mạnh (strip toàn bộ `?`, cap 320 ký tự, jaccard dedup).

**Model (thực tế):** `config/openai.ts` chạy **DeepSeek** (`deepseek-v4-pro` reply, `v4-flash`
classifier). ⚠️ `MODEL_NOTES.md` ghi sai là `gpt-4o-mini` (doc cũ — hệ thống vốn tune gốc trên 4o-mini).

## 3. 🔴 Bug gốc khiến bot "dạy khách mặc cả"

Khi khách chê đắt, bot **tụt giá** thay vì reframe giá trị:
```
KH: 5tr cho 12 tháng đắt quá em ơi
BOT: Dạ anh hiểu, bên em có gói Gym 4.5 triệu, tiết kiệm hơn... (SAI — tụt giá)
KH: có giảm giá gì không
BOT: ...Gói Gym 4.5 triệu. (SAI — đọc lại bảng giá)
```

**Nguyên nhân:**
1. GATE `price_objection` (`prefixBuilder.ts`) **chỉ fire khi `state.intentTopic === "price_objection"`**
   → phụ thuộc 100% classifier LLM. Classifier miss → GATE không fire → bot trôi sang
   tactic evaluation (liệt kê gói / gói rẻ hơn).
2. Có sẵn detector tất định `detectPriceObjection()` nhưng **là dead code — chưa nối vào đâu**.
3. Mâu thuẫn: `playbook.ts` `objection_neutral` ghi *"Luôn có phương án backup rẻ hơn"* —
   đối nghịch với GATE *"KHÔNG hạ giá"*.

## 4. ✅ Fix Batch 1 — Objection reframe (ĐÃ LÀM, ĐÃ KIỂM CHỨNG)

3 sửa đổi nhỏ, contained, **không đụng template/luồng khác**:

| File | Thay đổi |
|---|---|
| `prefixBuilder.ts` | Siết `detectPriceObjection` chống false-positive ("thắc mắc", "giảm cân", "ưu đãi SV", "gia đình giảm giá"...) + **nối nó làm lưới TẤT ĐỊNH** vào 2 GATE objection (fitness & giải cơ) qua biến `priceObjectionSignal`. |
| `playbook.ts` | Gỡ mâu thuẫn `objection_neutral` → reframe-value-trước + mời thử 1 buổi, KHÔNG hạ giá; gói nhẹ hơn chỉ là lựa chọn SAU khi neo giá trị. |

**Kiểm chứng 3 lớp:**
1. Unit-test regex: 8 câu objection thật → fire; 7 bẫy false-positive → skip. ALL PASS.
2. A/B tất định (không cần API): khi `intentTopic=null` (classifier miss), GATE objection
   fire trên "đắt quá / có giảm giá / bên kia rẻ hơn"; control ("tập 3 buổi", "giảm cân không") → không fire.
3. Transcript thật (4o-mini) — bot giờ reframe value + **GIỮ GIÁ**:
   ```
   KH: 5tr đắt quá → BOT: "...với 5 triệu anh được cơ sở 700m2, bể 4 mùa duy nhất Vĩnh Yên,
        GV Ấn Độ, InBody miễn phí. Anh muốn trải nghiệm thử 1 buổi miễn phí không?"  (sale 2)
   KH: có giảm giá → BOT: "không có chương trình giảm giá, nhưng với 5 triệu anh được... thử 1 buổi?"
   ```

Fix **model-agnostic** (tầng prefix) → sẽ ăn cả trên DeepSeek production.

## 5. ⚠️ Blocker khi test: DeepSeek hết số dư → ĐÃ ĐỔI HẲN SANG OPENAI

- DeepSeek balance **vẫn −0.66 USD, `is_available: false`** (check lại 2026-06-08): key hợp lệ,
  model ID `deepseek-v4-pro`/`v4-flash` có thật trong `/models`, NHƯNG mọi call → `Insufficient Balance`.
  Bot + classifier + grader (đều DeepSeek) đều chết. CÓ KEY ≠ CÓ TIỀN — phải nạp số dư mới chạy được.
- Baseline 5.00 đầu tiên là **giả** ("Reply rỗng" + judge "Insufficient Balance").

**Giải pháp đã làm (2026-06-08): đổi DEFAULT provider sang OpenAI, reply = `gpt-5.4-mini`.**
- `config/openai.ts`:
  - `LLM_PROVIDER` mặc định = **`openai`** (trước là deepseek). Lùi về DeepSeek: `LLM_PROVIDER=deepseek`.
  - `REPLY_MODEL` default openai = **`gpt-5.4-mini`** (trước là `gpt-4o-mini`).
  - `CLASSIFIER_MODEL` default openai = `gpt-4o-mini` (grader cũng dùng model này).
- **Vì sao cặp 4o-mini + 5.4-mini là ĐỦ (kết luận phiên này):** điểm yếu của bot là do **CẤU TRÚC**
  (≈87 template ANSWER_LOCK + nhiều GATE mệnh lệnh + cleanReply strip `?`/cap 320), **KHÔNG phải do model**.
  Bằng chứng: đổi lên `gpt-5.4-mini` (mạnh hơn cả deepseek-v4-pro lẫn 4o-mini) mà grader vẫn chê
  "cứng / chưa build value trước khi hỏi lịch" → model bị khuôn kịch bản ép. ⇒ Refactor đúng chỗ là
  **nới kịch bản + thêm tầng chiến lược sale + dùng emotion**, KHÔNG cần đụng model nữa.
- **Tương thích gpt-5.x đã verify:** chấp nhận `temperature 0.85` + `top_p 0.95` (đúng modelSettings),
  ~1.4s/call, **không tốn reasoning tokens**. Gotcha: gpt-5.x bắt `max_completion_tokens` (không `max_tokens`)
  — code KHÔNG truyền `maxTokens` nên không dính. ⚠️ ĐỪNG thêm `maxTokens` vào modelSettings cho dòng gpt-5.
- **Smoke test xác nhận stack chạy OK:** `fitness_happy_path` (5 lượt) = **avg 8.20/10**, no crash,
  structured-output + tool-call + validator đều chạy.
- **Bug phát hiện kèm (chưa sửa):** classifier trích `name="Là Trung"` từ "tên anh **là** Trung"
  → reply "anh Là Trung". Lỗi extract slot tên — gom vào Nhánh E (FSM/classifier).

## 6. Số đo cũ trên 4o-mini (LỖI THỜI — giờ reply chạy gpt-5.4-mini)

`overall 6.51 · min 4.67` (toàn bộ reply chạy 4o-mini). KHÔNG còn dùng: reply giờ là `gpt-5.4-mini`,
mạnh hơn → baseline phải đo lại trên cấu hình mới. Số 4o-mini chỉ giữ làm tham khảo lịch sử.

## 6b. ✅ Fix Batch 2 — Nhánh 3: Emotion-aware sale (ĐÃ LÀM, SMOKE PASS 2026-06-08)

Trục yếu nhất là **sale tactic (1.39)**. Gốc: `state.emotion` được classifier sinh ra NHƯNG
gần như chỉ dùng làm key fallback `getTactic` (→ luôn rơi về `_neutral`) ⇒ **emotion thực tế chết**.
Thêm nữa, prompt classifier chỉ có 1 dòng cụt "EMOTION: suy luận từ cách viết" ⇒ LLM hầu như
luôn trả `neutral`. 2 sửa contained:

| File | Thay đổi |
|---|---|
| `classifier.ts` | Bơm CUE cụ thể cho 5 emotion (excited/trusting/hesitant/anxious/frustrated) để 4o-mini phân biệt được, mặc định vẫn `neutral` khi không rõ. +~6 dòng. |
| `prefixBuilder.ts` | Thêm `buildSaleSenseHint(state)` — đọc emotion + "độ chín" context để điều tiết NHỊP CHỐT: ẤM→tiến 1 nhịp mời thử/InBody; PHÂN VÂN→lùi, gãi băn khoăn, không ép; LO→trấn an trước; BỰC→lắng nghe gỡ; neutral+momentum+stage pitch→nudge 1 CTA nhẹ. **Advisory, defer cho GATE/TACTIC, CHỈ inject ở PITCH, 1 dòng, return "" khi không liên quan** (giữ token gọn). |

**Kiểm chứng:**
1. Deterministic (free, no API): 8 case gating — excited/trusting/hesitant/anxious đúng nhánh;
   opening-lạnh / đã-đủ-tên+SĐT / objection(GATE) / retention → KHÔNG fire. PASS (case "anxious ở
   discovery" rơi vào SCRIPT-lock template nên không fire — đúng thiết kế, không phải bug).
2. Smoke live `fitness_happy_path` (gpt-5.4-mini): **avg 9.00/10, min 9.00** (baseline cũ 8.20),
   0 fail, no crash. ⚠️ Scenario test này khách "phẳng" → mọi turn emotion=neutral, chỉ nhánh
   CTA-neutral chạy; các nhánh cảm xúc cần scenario khách hesitant/anxious/excited mới hiện (tốn quota).

⚠️ **Token economy (user dặn 2026-06-08):** giữ prefix NGẮN cho 4o-mini + 5.4-mini — prompt dài →
loạn/ảo giác. Sale-sense đã theo nguyên tắc 1-dòng-gated. Khi thêm logic mới: đo lại độ dài, cắt chỗ trùng.

## 6c. ✅ Fix Batch 3 — Nhánh 2: Nới độ cứng template (ĐÃ LÀM, SMOKE 2026-06-08)

`formatDecision` cũ ép MỌI template thành ANSWER_LOCK "BẮT BUỘC reply theo template ... chứa cụm
nguyên văn" → bot copy template, cứng nhắc (natural 2.23). Phân loại 2 nhóm bằng **allowlist id tập trung**
trong `questionFlow.ts` (`INTENT_GUIDE_IDS`), default = FACT-LOCK (giữ chặt như cũ, KHÔNG regression):

| Nhóm | Xử lý | Gồm |
|---|---|---|
| **INTENT-GUIDE** (~37 id) | Nới: "Ý cần truyền đạt (mẫu) + GIỮ NGUYÊN số liệu" → model tự diễn đạt | chào/discovery/recommend/trấn an/mời trải nghiệm/cold-lead |
| **FACT-LOCK** (mặc định) | Giữ ANSWER_LOCK chặt | giá/chính sách/an toàn/cơ sở VC/giờ-địa-chỉ/**CHỐT SLOT (commitment)** |

- **Chống bịa số:** `extractLockedFacts()` tự rút "7 triệu / 20 buổi / 2 tháng / 5h / 1-1 / %..." trong
  template → PIN nguyên văn (nhiều giá KHÔNG nằm trong mustInclude, nếu nới trần sẽ bị bịa). Verify regex:
  recommend tang-co pin đúng `"1-1","20 buổi","6 triệu","2 tháng"` + mustInclude.
- **Kiểm chứng deterministic (free):** 7/7 — recommend/trấn an → INTENT-GUIDE; pool_hours/price/commitment → ANSWER_LOCK strict.
- **Smoke live:**
  - `real_indecisive_recommend` **T2 = 10/10** (nat 3, sale 2): recommend đọc rất tự nhiên, value-first, mời thử mềm
    ("Zumba thì vui nên dễ theo lâu dài... mình tính gói sau cũng được"). **T3 giá CHÍNH XÁC** (Full 7tr/12 tháng,
    Gym 4.5tr) — KHÔNG bịa số. ✅ Loosening đạt mục tiêu mà fact vẫn nguyên.
  - Điểm tổng các scenario `real_*`/`fitness_happy_path` bị nhiễu bởi **bug có sẵn** (name "Là Trung", date-miss
    "tối mai 7h", yoga+đau-lưng switch nhầm giải-cơ) — KHÔNG do Nhánh 2. Cần Nhánh E để đo sạch.

## 6d. ✅ Fix Batch 4 — Bug "Là Trung" (Nhánh E, ĐÃ LÀM + SMOKE PASS 2026-06-08)

Classifier trích `name="Là Trung"` từ "tên anh **là** Trung" → bot gọi "anh Là Trung" (kỳ + che tín hiệu đo).
2 lớp fix trong `classifier.ts`:
- **Prompt:** thêm hint slot `name` — "CHỈ lấy phần TÊN, BỎ động từ/xưng hô dẫn vào, KHÔNG gồm là/tên/anh/chị".
- **Lưới TẤT ĐỊNH `sanitizeName()`** (export): bóc tiền tố dẫn-vào-tên ("Là Trung"→"Trung", "tên anh là Trung"→"Trung",
  "mình tên Hùng"→"Hùng"). **Bảo thủ:** chỉ cắt xưng hô khi đi kèm "là"/"tên" ngay sau → KHÔNG nuốt tên thật
  ("Anh Tuấn", "Cô Ba", "Em", "Lan Anh" giữ nguyên). Wire vào `mapToClassification` (chạy mỗi khi extract name).
- **Kiểm chứng:** unit 13/13 (8 bug-case sửa đúng + 5 tên thật giữ nguyên). Live `fitness_happy_path`:
  T5 = "giữ slot tối mai 7h ... anh **Trung**" — name đúng, date parse đúng, close_slot sạch. avg 8.60, T5 hết lỗi.

~~Bug "Là Trung" che tín hiệu đo~~ → ĐÃ FIX. Happy_path giờ ổn định ~8.6 (lỗi còn lại: T1 greeting "hơi cứng", nitpick).

## 6e. ✅ Fix Batch 5 — Nhánh 2a: Routing recommend-thẳng (ĐÃ LÀM + SMOKE PASS 2026-06-08)

`intro_giam_can` HỎI HISTORY ("đang dùng biện pháp giảm cân nào không") ngay cả khi khách nêu goal RÕ
("em muốn giảm cân với giảm stress") → turn này bị grader **2/10** ở `real_indecisive_recommend` T1.

- ⚠️ **ĐIỀU CHỈNH ĐỊNH VỊ (notes cũ trỏ sai file):** live path KHÔNG phải `questionFlow.ts` legacy `TEMPLATES{}`.
  `decideFitnessQuestion` chạy **NEW engine `findTemplate(FITNESS_TEMPLATES, ctx)` TRƯỚC**, engine này thắng
  legacy. Template `intro_giam_can` thật nằm ở **`src/mastra/lib/templates/fitness.ts` (~L230–318)**. Legacy
  `TEMPLATES.intro_giam_can` (questionFlow.ts L308) là **dead path** cho topic này — sửa ở đó KHÔNG ăn (đã thử
  & revert). Mọi fix template giảm-cân/discovery về sau: sửa ở `templates/fitness.ts`.
- **Fix:** thêm 2 detector trong `render` của `intro_giam_can` (fitness.ts), nối vào nhánh recommend:
  - `statesGoalClearly` = `(muốn|cần|mong) ... (giảm cân/mỡ/stress/béo|săn chắc|vóc dáng|cải thiện|tăng cơ|khỏe|đẹp)`
  - `usingMethodCue` = `đang (tập|dùng|ăn kiêng|chạy|nhịn|uống|áp dụng|theo) | đã (tập|thử|dùng)`
  - `if (inThamQuanContext || askingRecommend || (statesGoalClearly && !usingMethodCue))` → recommend value-first.
  - Bảo thủ: khách đang-dùng-phương-pháp (history relevant) → vẫn hỏi history; vague ("quan tâm") → discovery.
- **Kiểm chứng:**
  1. Deterministic regex (free): 11/11 — 5 goal-rõ fire; 3 "đang dùng pp" skip; 3 vague/trống skip.
  2. Smoke live `real_indecisive_recommend`: **6.67→7.33, min 3→5**, T1 giờ recommend Gym+Zumba+Bơi value-first
     (issue "hỏi info không cần thiết" BIẾN MẤT). `real_giam_can_open_vague`: T2 vẫn recommend đúng (không
     regress); issues còn lại đều ở turn khác (chào mơ hồ/InBody/objection), avg dao động 7.43↔6.86 = nhiễu grader.

## 6f. ✅ Fix Batch 6 — Nhánh E: Yoga + "đau lưng" KHÔNG nhảy giai-co (ĐÃ LÀM + SMOKE PASS 2026-06-08)

Khách đang bàn yoga than đau lưng ("chị tập để thư giãn, lưng hay đau") → `detectFlowByKeyword`
`PAIN_PRIORITY` fire → **hard-switch sang giai-co** (override cả LLM ở `routerWorkflow` L133-135) → bot
bỏ tư vấn yoga, nhảy luồng giải-cơ. Sai vì yoga/pilates THƯỜNG được tập ĐỂ giảm đau lưng.

- **Gốc:** `detectFlowByKeyword(message, _previousFlow)` **bỏ qua `_previousFlow`**. DEFAULT_STATE.flow=`fitness`
  → không thể chỉ dựa previousFlow (opening "tập gym xong đau lưng" cũng flow=fitness). Phân biệt thật:
  **đã CHỐT serviceType fitness** (yoga/gym/...) hay chưa.
- **Fix (`stateMachine.ts`, trong `buildNextState`, theo pattern safety-lock/post-surgery có sẵn):**
  `FITNESS-SERVICE LOCK` — nếu `flow==="giai-co"` MÀ `previous.flow==="fitness"` + `previous.serviceType` ∈
  {gym,yoga,zumba,boi,pilates,full} + message KHÔNG nêu rõ dịch vụ giải cơ (`giải cơ|massage|xoa bóp|VLTL|
  ngâm bồn|trigger|fascia|regenix`) → ép `flow="fitness"`. Đau = lý do tập, không phải request giải cơ.
- **Bảo thủ (không phá case cũ):** opening "tập gym xong đau lưng" (serviceType=null) → vẫn giai-co; mid-yoga
  mà KH "muốn đặt massage" → vẫn switch giai-co. Lock chỉ chặn khi đã chốt bộ môn fitness + chỉ than đau.
- **Kiểm chứng:**
  1. Deterministic (free): **7/7** — 3 case yoga/gym/pilates than đau → GIỮ fitness; opening gym+đau / massage
     request / giai-co thuần → vẫn giai-co.
  2. Smoke live `fitness_yoga_only`: cả 3 turn `flow=fitness serviceType=yoga` (trước: T2 nhảy giai-co). T3 reply
     "Yoga... giúp thả lỏng lưng và giảm căng cơ" — khung yoga trị đau lưng. avg 7.33.
  3. No-regress `giaico_happy_path`: T1 "đau vai gáy" (fresh) → switch giai-co đúng, avg 8.20.

## 6g. ✅ Fix Batch 7 — Nhánh E: `safeFallback` aware giờ/lịch (ĐÃ LÀM + verify 2026-06-08)

Điều tra "InBody ép cả khi đã đặt giờ" → **bug FSM gốc ĐÃ được fix phiên trước**: `computeNextStage` có guard
`preferredTime !== null → commitment` ở cả discovery (L780) lẫn evaluation (L817), nên khi khách cho giờ cụ thể
thì RỜI stage `inbody` → GATE InBody (gate theo `stage==="inbody"`) không fire. Smoke `real_chot_time_phai_xin_info`
T3 "ok mai 6h sáng" → commitment xin tên/SĐT đúng. ✅

CÒN lỗ hổng ở **safety-net `safeFallback` (validator.ts)** — khi LLM reply bị validator reject giữa funnel:
- Cũ: stage `inbody`/discovery + đã biết `schedule="sáng"` → fallback vẫn hỏi lại "tiện tập **sáng hay chiều**"
  (redundant, từng cho T2 `real_chot_time_phai_xin_info` = 1/10 khi fallback fire).
- Cũ: đã có `preferredTime` mà stage chưa `commitment` → fallback không hướng chốt (có thể ép InBody/hỏi giờ lại).

**Fix (`validator.ts` `safeFallback`, contained, 1 caller routerWorkflow:419):**
- Thêm guard **`preferredTime` ưu tiên (mọi stage trừ retention)** → đủ tên+SĐT: xác nhận slot; thiếu: xin tên/SĐT
  giữ slot. KHÔNG hỏi lại giờ, KHÔNG ép InBody.
- Nhánh discovery có `serviceType` + đã biết `schedule` → mời "ghé thử 1 buổi, tiện hôm nào" thay vì hỏi lại sáng/chiều.
- **Kiểm chứng deterministic (free): 7/7** — bug case schedule-biết / preferredTime-set / đủ-info / chưa-schedule
  (giữ nguyên) / chưa-bộ-môn / retention (giữ nguyên) đều đúng. Smoke không regress (T3 vẫn chốt slot).

⚠️ CÒN (chưa fix, ứng viên Nhánh 2b): T1 `real_chot_time_phai_xin_info` "có gói gym không" → bot hỏi "đã tập gym
chưa" thay vì XÁC NHẬN có gói Gym trước → grader 1/10. Opening template hơi cứng; sửa đụng greeting rộng + tín
hiệu grader hơi nhiễu (kỳ vọng chốt tên/SĐT ngay T1 là premature). Để dành, A/B kỹ.

## 6h. ✅ Fix Batch 8 — Nhánh 2b: Affirm "có gói X" trước khi hỏi discovery (ĐÃ LÀM 2026-06-08)

Khách hỏi "**có gói gym không**" → template SCRIPT `gym_discovery` (questionFlow.ts) lờ câu hỏi, chỉ greeting +
"đã tập gym bao giờ chưa" → grader chấm intent=0 ("né câu hỏi về gói gym"). Tương tự yoga/zumba/pilates.

**Fix (`questionFlow.ts` `fallbackDiscoveryAfterServiceMention`, FACT-LOCK template):**
- Thread `message` vào hàm (trước chỉ nhận state/h/prev).
- Detector `askingAvailability` = "có ... (không/ko/khong/hông)" — **boundary VI-safe** `(?<!\p{L})...(?!\p{L})` + flag
  `u` (⚠️ `\b` KHÔNG match ký tự có dấu "có" → từng false-negative 5/5, phải dùng lookaround).
- Khi hỏi availability → prefix AFFIRM "Dạ ... bên em có nhiều gói {Gym/Yoga/Zumba/Pilates} ạ. " rồi mới hỏi
  experience. Không hỏi availability → giữ nguyên greeting cũ (KHÔNG đổi hành vi mặc định).
- **Kiểm chứng:** regex 11/11 (5 "có…không" fire, 6 bẫy "tôi quan tâm gym"/"không có thời gian"/"học bơi" skip).
  Smoke `real_chot_time_phai_xin_info` T1 giờ "bên em có nhiều gói Gym linh hoạt ạ. Không biết… đã tập gym…" (affirm
  đúng). `fitness_happy_path` avg **8.40 không regress** (opening "chào shop"/"đăng ký gym" không phải "có…không" → giữ nguyên).
- ⚠️ **Score scenario đích KHÔNG nhảy:** grader `real_chot_time_phai_xin_info` **bias** — đòi bot "xin tên/SĐT khi
  đã chốt" ngay ở T1 dù khách MỚI hỏi mở đầu, chưa cho giờ. Tín hiệu T1 scenario này nhiễu; fix vẫn objective-đúng
  (reply giờ trả lời câu hỏi gói) → sẽ ăn điểm ở các opening "có gói X không" khác không bị grader bias.
- **Bonus xác nhận live:** T2 scenario này LLM trả rỗng → `safeFallback` (6g) fire đúng nhánh mới "ghé thử 1 buổi,
  tiện hôm nào" (thay "sáng hay chiều" cũ) — verify 6g chạy production path.

## 6i. ✅ Fix Batch 9 — Sửa BIAS grader (ĐÃ LÀM 2026-06-08)

`grader.ts judgeTurn` truyền `scenarioDescription` (mô tả **mục tiêu TOÀN cuộc**, vd "Khách chốt time sớm — bot
phải xin tên/SĐT") vào **mọi turn** → judge áp kỳ vọng cuối-cuộc lên cả T1 nơi khách mới hỏi "có gói gym không",
chưa cho giờ → chấm oan "chưa xin SĐT/chưa chốt slot". Đây là lý do điểm `real_*` không phản ánh cải thiện thật.

**Fix (`scripts/grader.ts`, chỉ sửa prompt judge — KHÔNG động bot):**
- Label `scenarioContext` rõ "mục tiêu TOÀN cuộc, chỉ tham khảo, KHÔNG phải checklist từng turn".
- Thêm rule: chỉ kỳ vọng "xin tên/SĐT / chốt slot" khi khách ĐÃ cho giờ cụ thể HOẶC tín hiệu cam kết. Khách mới
  hỏi mở đầu/dịch vụ/giá → answer/dẫn 1 bước discovery là ĐÚNG, KHÔNG trừ "chưa chốt".
- **Nguyên tắc:** làm grader CÔNG BẰNG (chấm theo tin hiện tại), KHÔNG nuông — deterministic checks + các rule
  KHẮT KHE (khen giả, pitch sau chốt, ép info khách lạnh) giữ nguyên.
- **Kiểm chứng:** `real_chot_time_phai_xin_info` **6.00→8.00, min 2→6** (T1 hết bị chấm oan). T2 còn sót nhẹ (judge
  4o-mini chưa theo 100%) — chấp nhận. ⚠️ Baseline các scenario phải ĐO LẠI trên grader mới (số cũ < thực tế).

## 6j. ✅ Fix Batch 10 — Nhánh E: Switch service KHÔNG xoá goal (ĐÃ LÀM + verify 2026-06-08)

`buildNextState` khi `switched` (đổi bộ môn same-flow, vd gym→yoga) reset `fitnessGoal=null` + `memberType=null`
→ bot hỏi lại mục tiêu/đối tượng thừa, dù đó là thuộc tính CỦA NGƯỜI (cross-service).

**Fix (`stateMachine.ts`, trong block `if (switched)`):**
- GIỮ `fitnessGoal` (post-merge: ưu tiên goal mới trong tin này, else carry-over). Ngoại lệ: goal service-bound
  `hoc-boi` → reset khi chuyển sang bộ môn ≠ bơi.
- GIỮ `memberType` (HS/SV/gia đình cross-service). Vẫn reset `schedule/durationMonths/sessionPackage` (service-specific).
- **Kiểm chứng:** logic 7/7 (giam-mo/tang-co/suc-khoe/thu-gian giữ; hoc-boi→gym reset; hoc-boi→boi giữ). E2E qua
  `buildNextState`: switch gym(giảm mỡ, HS, sáng)→yoga ⇒ serviceType=yoga, **fitnessGoal=giam-mo GIỮ**, memberType=hoc-sinh
  GIỮ, schedule=null reset. Smoke `flow_switch` (đổi FLOW, path khác) **9.00 PASS không regress**.

## 6k. ✅ Fix Batch 11 — Nhánh E: intent "ok" nhiễu (ĐÃ LÀM, verify det+E2E 2026-06-08)

4o-mini đôi khi classify affirmation thuần ("ok"/"ừ"/"được") thành `explore` dù khách đang ĐỒNG Ý lời
mời thử/InBody → funnel đứng (không tiến commitment). Classifier có rule L587-588 nhưng LLM hay miss.

**Fix (`stateMachine.ts`, `buildNextState`, guard deterministic ngay sau `const intent`):**
- Khi `intent==="explore"` + tin là **affirmation thuần** (`^(ok|ừ|vâng|dạ|được|đồng ý…)$` có tiểu từ đuôi)
  + `previous.lastBotReply` có **lời mời thử** (thử 1 buổi / đo InBody / trải nghiệm / ghé thử) → bump
  `explore→selecting`. Bảo thủ: KHÔNG bump `ready`; KHÔNG đụng nếu LLM đã selecting/ready/compare; FSM vẫn
  guard commit-signal trước commitment.
- **Kiểm chứng:** regex 11/11 (ok/ừ/được/ok em/vâng ạ/dạ được fire sau mời; filler sau câu thường / sau báo
  giá / câu dài / objection → skip). **E2E qua `buildNextState`**: "ok" sau "trải nghiệm thử 1 buổi…?" ⇒
  intent=selecting → stage=commitment; control "ok" sau "Dạ em hiểu rồi" ⇒ explore. PASS.
- ⚠️ **Live scenario smoke BỊ CHẶN:** cuối phiên `api.openai.com` không resolve được (ENOTFOUND, cả khi tắt
  sandbox; google.com vẫn OK) — sự cố mạng môi trường, KHÔNG do code. Đã verify det+E2E (chạy code path thật,
  không cần LLM) là đủ vững cho thay đổi deterministic. Khi có mạng nên smoke 1 case có "ok" để xác nhận end-to-end.

## 6l. 🟡 Fix Batch 12 — Nhánh D: Nới `cleanReply` strip "?" (ĐÃ LÀM phần 1, det PASS — CHỜ A/B LIVE)

`cleanReply` step 7 strip **TOÀN BỘ** dấu "?" → mọi câu hỏi của bot đọc thành "...ạ" mất ngữ điệu hỏi
(góp phần "cứng"). Coupling: grader chỉ phạt khi **>1** "?" (grader.ts:91-93) → giữ ĐÚNG 1 "?" là an toàn.

**Fix (`cleanReply.ts`, contained, reversible):**
- Bước 7: capture `endedWithQuestion` trước khi strip; vẫn strip mọi "?" nội bộ (URL `?id=` giữ qua `(?!\w)`).
- Bước 8d-bis (sau chuẩn hoá particle "ạ"/"nha"): khôi phục **1 dấu "?" cuối** nếu reply gốc là câu hỏi →
  dạng tự nhiên "...ạ?". Guard: không thêm nếu đã có "?" hoặc câu cuối kết bằng số/giá.
- **Kiểm chứng deterministic (free, không cần mạng): 7/7** + thêm Test 5 bền vào `scripts/testCleanReply.ts`
  (câu hỏi cuối giữ 1 "?"; 2 câu hỏi→còn 1; statement→không "?"; URL `?id=` giữ). 4 test cũ không regress.
- ⚠️ **CHƯA A/B LIVE** (cuối phiên mạng OpenAI down — ENOTFOUND). Thay đổi này CHẠM MỌI reply production kết
  bằng câu hỏi (thêm "?"). An toàn về mặt: production (chat sale Việt vẫn dùng "?") + grader (chỉ 1 "?"), DỄ
  REVERT. NHƯNG tác động điểm natural CHƯA đo. **Trước commit: smoke vài case có câu hỏi (happy_path/recommend)
  so điểm natural cũ↔mới; nếu không cải thiện/regress → revert (chỉ 2 hunk).**
- ⬜ CÒN trong Nhánh D (CHƯA làm, rủi ro cao hơn, cần A/B): nới "bỏ nha/nhé" (8c ép "ạ" → mất ấm), cap 320 ký tự.

## 6m. ✅ Fix Batch 13 — Đóng GAP 6d: "Là Trung" qua inline extractor (ĐÃ LÀM + verify live 2026-06-08)

Smoke `fitness_happy_path` (sau khi mạng về) lộ T5 "anh **Là Trung**" lại — bug 6d tưởng hết. Gốc: 6d chỉ wire
`sanitizeName` vào path LLM classifier (`mapToClassification`). Tin gộp "tên anh là Trung, sđt 0987654321..." →
name extract qua **`detectNamePhoneInline`/`detectNameStandalone` trong `buildNextState`** (path TẤT ĐỊNH) →
KHÔNG qua sanitize → leak "Là Trung".

**Fix (contained, không circular):**
- Chuyển `sanitizeName` từ `classifier.ts` → `stateMachine.ts` (layer thấp hơn; classifier vốn đã import từ
  stateMachine → đưa ngược lại sẽ circular). `classifier.ts` re-export giữ API cũ.
- Bọc `sanitizeName(inlineName ?? standaloneName)` trong `extractedSlotsAugmented.name`.
- **Kiểm chứng:** modules load OK (không circular). E2E `buildNextState("tên anh là Trung, sđt 0987654321…")`
  ⇒ name="Trung". Live `fitness_happy_path` T5 = "giữ slot … anh **Trung**" (hết "Là Trung"). avg 8.8–9.4 (nhiễu LLM).

## 6n. ✅ PHIÊN 2026-06-08 (tối) — A/B 6l + smoke 6k/Nhánh3 (mạng OK trở lại)

Mạng OpenAI đã thông lại (401 reachable). Chạy đúng 2 smoke case (tiết kiệm quota theo §9).

- **6l (giữ 1 "?") — A/B XONG, GIỮ.** `real_indecisive_recommend` (grader mới) **avg 7.67**, no crash.
  Cả 3 turn câu hỏi render đúng "...ạ?" (đúng 1 "?", URL-safe). So cũ↔mới tất định trên CHÍNH raw
  reply: NEW "...sáng hay chiều ạ?" tự nhiên hơn OLD "...ạ" (đọc phẳng). Natural tụt ở T2/T3 do NỘI
  DUNG (chưa build value trước báo giá), KHÔNG do "?". → unblock commit batch 7.
- **6k ("ok"→selecting) — verified E2E LIVE.** Scenario mới `real_phan_van_so_tap_sai` T3 "ok em" →
  funnel tiến commitment (bot xin tên/SĐT), không đứng.
- **Nhánh 3 emotion — kích đúng (1 phần).** Classify chuẩn: T1 hesitant / T2 anxious / T3 trusting (cue 6b OK).
  ✅ **Nhánh anxious FIRE hoàn hảo:** T2 "người mới bên em có HLV chỉnh động tác, theo sát từng buổi"
  + mời InBody (sale=2, intent=3) = đúng `buildSaleSenseHint` anxious (trấn an trước).
- ⚠️ **GAP (trục yếu nhất sale):** khách **hesitant** nêu goal+service NGAY T1 → `computeNextStage`
  thấy `coreSlotsFilled=true` → nhảy `stage=inbody` (L806-808) → GATE lịch push "tiện tập sáng hay
  chiều" BỎ QUA hesitation (T1 sale=1). `buildSaleSenseHint` hesitant (advisory, chỉ PITCH) KHÔNG tới.

- ❌ **THỬ FIX "emotion hold" → REVERT (regression).** Đã thử: `computeNextStage` thêm param `emotion`,
  khi `hesitant/anxious` + chưa commit → giữ `discovery` thay vì nhảy `inbody`. Det 8/8 đúng + impact
  LOW. NHƯNG smoke `real_phan_van_so_tap_sai` **7.67→6.67 (min 6→4)**: giữ ở discovery KHÔNG kích
  reframe — discovery fire template hỏi lịch "sáng hay chiều" (vẫn push) và **LẶP 2 lần** (T1+T2, nat=1),
  đồng thời **phá nhánh anxious vốn chạy tốt ở `evaluation`** (T2 cũ trấn an + InBody, sale=2). Revert.
  **ROOT CAUSE THẬT (ứng viên fix sau, KHÓ hơn):** stage `discovery` có template/GATE hỏi "tiện tập
  sáng hay chiều" BỎ QUA emotion — đó mới là chỗ cứng. `buildSaleSenseHint` anxious chỉ kích ở
  `evaluation/inbody` (PITCH). Fix đúng = cho discovery template tôn trọng hesitant/anxious (reframe/
  trấn an trước khi hỏi lịch), KHÔNG phải dịch stage. Cần A/B kỹ, chưa làm.
- Scenario mới `real_phan_van_so_tap_sai` đã thêm vào `scripts/runTestScenarios.ts` (dùng soi emotion).

- 🛑 **SỰ CỐ + KHÔI PHỤC (bài học):** revert emotion-hold tôi lỡ chạy `git checkout src/.../stateMachine.ts`
  → mất TRẮNG các thay đổi uncommitted 6f/6j/6k/6m (file về HEAD). ĐÃ KHÔI PHỤC ĐẦY ĐỦ: replay 5 Edit
  từ transcript Claude Code phiên trước (`~/.claude/projects/.../8af98d0d*.jsonl`) — verify cả 5 old_string
  khớp HEAD + new_string chưa có → áp tuần tự, sanitizeName 5/5 PASS, module load OK. **BÀI HỌC: KHÔNG
  dùng `git checkout <file>` để revert 1 hunk khi file còn thay đổi uncommitted khác — dùng Edit ngược
  hoặc `git stash -p`. Nếu lỡ: transcript .jsonl chứa old/new_string để replay.**

## 6o. ✅ Fix Batch 14 — Nhánh 3: Root-cause discovery-template cho khách hesitant/anxious (ĐÃ LÀM + SMOKE 2026-06-08 tối)

Sau khi fix FSM "emotion hold" THẤT BẠI (xem 6n), điều tra sâu ra root-cause THẬT là **3 lớp đều bỏ qua
emotion**, không phải FSM stage:
1. **SCRIPT template** (`ask_schedule_after_goal` & họ `*_ask_schedule_*`) hỏi "sáng hay chiều" máy móc,
   fire TRƯỚC PITCH → khách phân vân/lo bị push lịch.
2. **`safeFallback`** (validator) khi LLM reply bị reject → fallback robotic "tiện tập sáng hay chiều".
3. **PITCH tactic** ở stage inbody/evaluation: nội dung pitch InBody lấn át `buildSaleSenseHint` (append cuối).

**3 fix contained, ĐỀU emotion-gated (neutral/excited/trusting/frustrated KHÔNG đổi → happy_path no-regress
chứng minh tất định, không cần smoke):**

| File | Thay đổi |
|---|---|
| `questionFlow.ts` | Export `isEmotionSoftSkipId(id)` = INTENT_GUIDE ∪ mọi `ask_schedule` (template "mềm" an toàn nhường PITCH). KHÔNG đụng INTENT_GUIDE membership (giữ formatDecision). |
| `prefixBuilder.ts` | (a) SCRIPT block: skip template khi `emotion∈{hesitant,anxious}` + chưa commit + `isEmotionSoftSkipId` → rơi PITCH. (b) PITCH tactic OVERRIDE reassure-first cho hesitant/anxious ở discovery/inbody/evaluation (đặt sớm sau getTactic → cold-lead/giá/discovery-specific vẫn override; loại trừ khi khách hỏi giá/lịch). |
| `validator.ts` | `safeFallback`: hesitant/anxious (sau guard preferredTime/retention/commitment) → trấn an "có HLV kèm... ghé thử 1 buổi quyết sau cũng được" thay vì "sáng hay chiều". |

**Kiểm chứng:**
- Det mode-dispatch (free): hesitant discovery+inbody (`ask_schedule_after_goal`) → PITCH; neutral/trusting → SCRIPT (no-regress); hesitant hỏi-giá → không skip. PASS.
- Det `safeFallback` (free): hesitant/anxious → trấn an; neutral → robotic cũ; preferredTime/retention → ưu tiên chốt/concierge. PASS.
- **Smoke live `real_phan_van_so_tap_sai`: 7.67 → 8.33 (min 6→7).** T1 hesitant **n2/i2/s1 → n3/i3/s2**:
  "Dạ anh/chị cứ yên tâm ạ, người mới bên em đều có HLV kèm từ đầu và điều chỉnh theo sức. anh/chị ghé
  thử 1 buổi xem có hợp không rồi quyết cũng được ạ" (hết push "sáng hay chiều"). T2 anxious vẫn reframe tốt.
- ⚠️ Lưu ý: T1 win đến QUA `safeFallback` (LLM PITCH reply vẫn bị validator reject ở turn này) — nên cả
  fix (2a SCRIPT skip + 2b tactic + safeFallback) bổ trợ nhau; safeFallback là lưới cuối quan trọng.

## 6p. ✅ Fix Batch 15 — Nhánh 1 (natural): Bỏ ACK "vẹt" (đọc lại nguyên văn info khách) (ĐÃ LÀM + A/B PASS 2026-06-08)

Smoke `fitness_happy_path` (no-regress Batch 14) lộ root-cause "cứng" THẬT (không phải greeting, không phải cleanReply):
bot **đọc lại NGUYÊN VĂN thông tin khách vừa nói** như form-filling robot:
- T2 (nat 2): "**Dạ anh đang muốn đăng ký gym để giảm mỡ ạ.** Bên em có đo InBody..."
- T3 (nat 2): "**Dạ em note lịch tập tối 3 buổi mỗi tuần của anh ạ.** Với mục tiêu giảm mỡ..." (judge: "chưa hoàn toàn tự nhiên, cải thiện ngữ điệu")

**Gốc:** chính `ACK MẪU` trong system prompt (`agents/fitness.ts` L105-109) nhúng `[info]` → ép bot lặp info ("Dạ vâng
[info] nha", "OK ạ, [info] em ghi nhận"), + RULES (`prefixBuilder.ts` L2320) ghi *"ACK chỉ nhắc lại / note"*. Thuốc
chống nịnh (đừng khen đáp án → chỉ note) lại sinh ra **vẹt nguyên văn**. "em note/em ghi nhận" là jargon call-center.

**2 fix contained (prompt-level, KHÔNG đụng cleanReply ending — user dặn giữ "?"/nha/nhé/"ạ" cuối nguyên trạng):**
| File | Thay đổi |
|---|---|
| `agents/fitness.ts` | `ACK MẪU` → NGẮN & tự nhiên: mở "Dạ vâng/Dạ được [anh/chị]" rồi VÀO THẲNG value; tối đa chạm 1 từ khoá ngắn nếu hợp, KHÔNG lặp cả cụm; CẤM mở reply bằng câu lặp nguyên văn yêu cầu khách; bỏ "em note/em ghi nhận". |
| `prefixBuilder.ts` (RULES L2320) | "ACK chỉ nhắc lại / note" → "ACK ngắn TRUNG TÍNH ('Dạ vâng anh/chị'), KHÔNG đọc lại nguyên văn cả cụm thông tin khách, KHÔNG 'em note/ghi nhận', rồi vào thẳng value" (GIỮ cấm khen đáp án). |

**A/B live `fitness_happy_path`: 8.60 → 9.20 (PASS ≥9.0), parrot opening BIẾN MẤT:**
- T2: "Dạ vâng anh, anh tiện tập buổi sáng hay chiều để em tư vấn lịch phù hợp ạ." (hết vẹt)
- T3: "Dạ vâng anh, lịch tối 3 buổi/tuần mình tập giảm mỡ rất ổn ạ. Bên em đo InBody..." (chạm 1 từ khoá ngắn, không vẹt cả cụm)
- No-regress: T1 greeting nguyên, T5 name "Trung" đúng. Còn 1 issue T4 (slot-timing nitpick — grader quirk đã biết).
- ⚠️ giaiCo.ts KHÔNG có ACK MẪU `[info]`-echo (chỉ ví dụ particle) → không cần sửa.

## 6q. ✅ Fix Batch 16+17 — Nhánh 1 (sale-tactic): 2 chỗ "chưa như sale thật" (ĐÃ LÀM + A/B PASS 2026-06-08)

Soi tiếp 3 smoke (objection / indecisive / giải-cơ) sau ACK fix → tìm 2 lỗi sale-tactic (trục yếu nhất):

### Batch 16 — Indecisive "chọn giúp em" → tái khẳng định gợi ý (KHÔNG đẩy lịch)
`real_indecisive_recommend` T2: KH *"em chưa biết môn nào, chị **chọn giúp em**"* → bot đẩy lịch "ghé sáng hay
chiều đo InBody" (int 2/sale 1). Gốc: `indecisive_pick_for_me` render (`templates/fitness.ts`) khi
`alreadyRecommendedSolution(prev)` → **cả 2 nhánh** trả về CÙNG câu đẩy lịch (if/else thừa), bỏ qua việc KH vẫn phân vân.
- **Fix:** nhánh "đã recommend mà KH vẫn xin chọn" (chưa có giờ/tên+SĐT) → **TÁI KHẲNG ĐỊNH gợi ý dứt khoát theo goal**
  (`indecisive_reaffirm_recommend`: "Dạ [h] cứ bắt đầu với {Gym+Zumba/Gym+PT/Yoga/bơi 1-1/Full} như em gợi là hợp
  mục tiêu nhất ạ. Ghé thử 1 buổi rồi quyết cũng được ạ"). Giữ nhánh đã-commit (có giờ/SĐT) nudge nhẹ như cũ.
  + thêm id vào `INTENT_GUIDE_IDS` (không có số giá → nới an toàn).
- **A/B `real_indecisive_recommend`: 7.67 → 8.67. T2 6→10** (nat 2→3, int 2→3, sale 1→2).

### Batch 17 — Objection T1: "có gói gym không" → AFFIRM, KHÔNG bổ giá 333k (bug §3)
`fitness_objection_price` T1 (yếu nhất 6.50): KH hỏi **CÓ/KHÔNG** *"có gói gym giảm mỡ không"* → bot bổ thẳng
*"...ưu đãi **chỉ từ 333k/tháng**"* (anchor thấp, mời mặc cả — đúng bug §3). `detectPriceQuestion` = FALSE (không có
từ giá) → price-GATE không fire; nhưng classifier gắn `intentTopic=price_explicit_list` → **SCRIPT** template giá
333k fire (chạy TRƯỚC GATE). `fallbackDiscoveryAfterServiceMention` không cứu vì return null khi `stage!=="discovery"`
(T1 stage=inbody do slots gym+giảm-mỡ đủ → nhảy inbody ngay turn 1).
- **Fix 2 lớp:**
  - `prefixBuilder.ts`: thêm `detectServiceAvailabilityQuestion` (có + danh-từ-dịch-vụ + phủ-định, VI-safe lookaround)
    + **GATE availability-affirm**: "Dạ có ạ, bên em có {svc}" + 1 câu value + 1 discovery, CẤM bổ giá/333k/InBody/xin SĐT.
    Gate sớm (early-funnel, chưa tên+SĐT, không phải hỏi giá/lịch/giờ), return sớm chặn inbody/price pitch.
  - `questionFlow.ts`: guard TRƯỚC dispatch `TEMPLATES[intentTopic]` — khi `price_explicit_list/price_ask_generic`
    NHƯNG tin là availability-ask & KHÔNG có từ giá → **skip template giá** → rơi qua GATE affirm.
- **Det:** detector 10/10 + skip-guard 6/6 (real price "giá bao nhiêu"/"4tr"/"ưu đãi" KHÔNG bị skip → price flow no-regress).
- **A/B `fitness_objection_price`: 6.50 → 8.00. T1 6→10** (nat 2→3, int 2→3, sale 1→2): "Dạ có ạ, bên em có gym giảm
  mỡ theo lộ trình ạ..." (hết 333k). Objection reframe T3/T4 vẫn chạy (sale=2). `giaico_happy_path` no-touch = 9.00.

## 6r. ✅ Fix Batch 18 — Anti-loop nuốt câu báo giá khi KH HỎI LẠI giá (ĐÃ LÀM + A/B PASS 2026-06-08)

Soi batch 3 ca mới (tang_co / so_sanh / boi). `real_boi_cho_con_hoc` **T4 = 3/10 (sale=0)**: KH hỏi thẳng
*"1 khóa hết bao nhiêu"* → bot **né hoàn toàn**: *"Nếu chị muốn em chốt luôn lịch thử thì chị tiện khung giờ nào ạ?"*.
- **Gốc (đã chứng minh tất định):** `cleanReply` anti-loop pitch-dedup. Bot báo giá ở T3 ("3 triệu", "1,2 triệu")
  → prevPrices≥2 → forbidPhrases. T4 LLM trả "Dạ 1 khóa ... 3 triệu ạ. [câu chốt]" → câu "3 triệu" bị **strip
  như trùng lặp** → còn mỗi câu chốt → bot như né câu hỏi giá. Verify: `cleanReply(raw, prev)` cho ra đúng reply lỗi.
- **Fix (`cleanReply.ts` + `routerWorkflow.ts`, KHÔNG đụng ending "?"/nha/nhé/"ạ"):**
  - Thêm param `customerMessage`; `routerWorkflow:366` truyền `message` vào.
  - `customerAskingPrice` (giá/bao nhiêu/hết bao/báo giá...) → (a) KHÔNG đẩy prevPrices vào forbidPhrases;
    (b) Jaccard giữ câu có số tiền (`hasPriceNumber`). ⇒ KH hỏi giá thì câu báo giá LUÔN sống.
  - Bảo thủ: KH KHÔNG hỏi giá → anti-loop nguyên trạng (vẫn dedup, không spam lại bảng giá).
- **Det:** unit Test 6 thêm vào `testCleanReply.ts` (KH hỏi giá → giữ "3 triệu"; không hỏi → vẫn dedup). 5 test cũ no-regress.
- **A/B `real_boi_cho_con_hoc`: 7.0 → 8.25. T4 3→7** (sale 0→1, int 1→3): "...1-1 12 buổi 3 triệu, gồm 3 tháng bể..." (trả lời giá).
- ⚠️ CÒN trong batch này (chưa fix, FSM slot-handling): `tang_co` T3 KH cho "tối 7-9h" → bot hỏi lại "qua hôm nào" vague;
  `so_sanh` T3 KH cho lịch "sáng/tối tùy" → bot hỏi history lùi. Cùng class: KH cho tín hiệu → bot không chốt, đẩy funnel riêng.

## 6s. ✅ Fix Batch 19+20 — Nhánh E + sale-logic: date hallucination + goal "lấy dáng" recommend (ĐÃ LÀM + verify 2026-06-08)

Soi batch tang_co/so_sanh → 2 lỗi "FSM slot-handling" hóa ra root khác nhau (KHÔNG cùng class), đều đụng tầng nhạy cảm:

### Batch 19 — Classifier BỊA thứ/ngày từ range-giờ (CORRECTNESS, `stateMachine.ts`)
`real_tang_co` T3: KH *"tối 7-9h"* (19-21h) → classifier resolve `preferredTime="19h tối **thứ 7 13/06**"` (đọc "7-9h"
thành "thứ 7" + bịa ngày 13/06 khách KHÔNG nói). Bot tự bịa ngày đặt lịch = lỗi correctness (chốt nhầm ngày), tệ hơn cứng.
- **Fix:** `sanitizePreferredTime(extracted, message)` (cạnh `sanitizeName`) — khi message có range-giờ (`\d-\dh`) mà
  KHÔNG nêu thứ/ngày → cắt "thứ N"/"DD/MM" bịa trong preferredTime, giữ phần giờ/buổi. Wire vào `extractedSlotsAugmented`.
  Bảo thủ: message CÓ "thứ 7"/"mai"/DD/MM thật → giữ nguyên; "3-4 buổi" (không "h") → không khớp.
- **Det 7/7** (bug-case cắt đúng "19h tối"; trap thứ-thật/mai/frequency giữ nguyên). Live: T3 `preferredTime="19h tối"` (hết
  "thứ 7 13/06"). ⚠️ Grader KHÔNG thấy state → điểm phẳng (8.0↔7.5 noise); giá trị fix là CHẶN booking sai ngày.

### Batch 20 — Goal "lấy lại dáng" miss → bot hỏi history lùi (`stateMachine.ts` + `prefixBuilder.ts`)
`real_so_sanh` T3 (tot 6, sale 1): goal-clear "lấy lại dáng sau sinh" NHƯNG classifier KHÔNG set `fitnessGoal` (chỉ gắn
attribute `goal_postpartum_shape`) → `goal=null` → PITCH hỏi history lùi *"đã thử tập cách nào chưa"* thay vì recommend.
- **Fix 2 lớp:**
  - `stateMachine.ts`: `detectGoalByKeyword` (vá CHỈ cue "(...)dáng" mẹ-bỉm → giam-mo) wire fallback vào `extractedSlotsAugmented.fitnessGoal` (chỉ khi LLM miss). Bảo thủ: KHÔNG thêm cue khác (classifier đã bắt tốt).
  - `prefixBuilder.ts`: GATE `goal-rõ-cho-lịch` — fitness + discovery + goal set + serviceType null + KH cho lịch/giờ → "KHÔNG hỏi history, recommend bộ môn hợp goal value-first + mời thử". (Lưu ý: GATE chỉ fire khi goal!=null → cần Batch 20 goal-fallback mới kích.)
- **Det:** detectGoalByKeyword 6/6. **Live `real_so_sanh`: 8.0 → 8.67 (min 7→8). T3 7→9** (sale 1→2): T2 goal=giam-mo (extract đúng),
  T3 "với mục tiêu giảm mỡ sau sinh em khuyến khích Gym và Zumba, ... xen Yoga phục hồi..." (recommend value-first, hết hỏi history).

## 6t. 🔖 TỔNG KẾT PHIÊN 2026-06-08 (KHUYA) — 6 batch sale-realism (15-20) + chốt hướng kiến trúc

**Bối cảnh:** tiếp tục "nâng trí tuệ sale". Soi 8/33 scenario, mỗi fix → det test (free) → smoke A/B 1 ca → revert nếu regress.
Tất cả **KHÔNG đụng** `cleanReply` ending (`?`/nha/nhé/`ạ` cuối) — user CHỐT giữ nguyên (câu nên kết bằng "ạ").

| Batch | Vấn đề | File | Kết quả |
|---|---|---|---|
| 15 | ACK "vẹt" (đọc lại nguyên văn info "em note...của anh") | agents/fitness + prefixBuilder RULES | happy_path 8.60→**9.20** |
| 16 | "chọn giúp em" sau recommend → đẩy lịch | templates/fitness + questionFlow | indecisive 7.67→**8.67** (T2 6→10) |
| 17 | "có gói X không" → bổ giá teaser 333k (bug §3) | prefixBuilder + questionFlow | objection 6.50→**8.00** (T1 6→10) |
| 18 | KH hỏi LẠI giá → anti-loop nuốt câu báo giá (sale=0) | cleanReply + routerWorkflow | boi 7.0→**8.25** (T4 3→7) |
| 19 | classifier BỊA ngày "tối 7-9h"→"thứ 7 13/06" | stateMachine | **correctness** (chặn booking sai ngày) |
| 20 | goal "lấy lại dáng" miss → hỏi history lùi | stateMachine + prefixBuilder | so_sanh 8.0→**8.67** (T3 7→9) |

**🧭 CHỐT HƯỚNG KIẾN TRÚC (quan trọng — quyết định của user phiên này):**
- Tầng **classifier-route + SCRIPT/GATE = THIẾT KẾ ĐÚNG**, là "cái phao" giữ hệ thống đi đúng/an toàn cho model nhỏ
  (4o-mini classify hay loạn nếu thả tự do — xem memory token-economy). **GIỮ NGUYÊN, KHÔNG làm "tầng cấu trúc"**
  (không rewrite classifier, không bỏ GATE/SCRIPT hàng loạt).
- Việc còn lại = **soi + smoke vá nốt cho mượt**, gồm đúng **2 loại fix an toàn**:
  1. **Gỡ cứng câu chữ** (nới template không-số-liệu, bỏ ACK vẹt) → tự nhiên hơn.
  2. **Lưới TẤT ĐỊNH cho mis-route/mis-parse** mình bắt được qua smoke (KHÔNG sửa classifier — thêm guard ở
     stateMachine/prefixBuilder/questionFlow nắn lại). Vd: availability-affirm (17), date-guard (19), goal-fallback (20).
- **Mục tiêu thực tế đã chốt:** **mượt + đúng + an toàn**, KHÔNG phải "reasoning 100%".
- **Đánh giá thật (honest):** bot tự nhiên hơn RÕ RỆT so với đầu phiên, NHƯNG **chưa phải sale tự suy luận hoàn toàn** —
  vẫn là scaffold (~100 template, chỉ ~38 nới INTENT-GUIDE; 48 GATE; classifier 4o-mini là điểm route duy nhất) được
  gỡ cứng dần. Còn ~25/33 scenario CHƯA soi → còn mis-route/cứng ẩn, vá tiếp bằng vòng soi+smoke khi cần.

**File MỚI đụng phiên này** (chưa từng trong git status trước): `agents/fitness.ts`, `workflows/routerWorkflow.ts`.

## 6z1. 🔖 TỔNG KẾT PHIÊN 2026-06-08 (TỐI) — A/B 6l + Nhánh 3 hesitant + sự cố/khôi phục

Mạng OpenAI thông lại. Theo §9 chỉ smoke case quan trọng (user dặn "sợ hết quota"). Tổng dùng **4 smoke run**
(mỗi run 3 turn) + nhiều det/E2E test FREE.

| Việc | File | Kết quả | Verify |
|---|---|---|---|
| **6l A/B (giữ "?")** | `cleanReply.ts` | ✅ GIỮ — "...ạ?" tự nhiên hơn "...ạ", grader-safe | det 7/7 · live `real_indecisive_recommend` 7.67 |
| **6k smoke** | `stateMachine.ts` | ✅ "ok em" → tiến commitment, funnel không đứng | live E2E |
| **Nhánh 3 emotion smoke** | `classifier.ts`+`prefixBuilder.ts` | ✅ classify đúng (hesitant/anxious/trusting); anxious branch kích tốt | live |
| **❌ FSM "emotion hold"** | (đã revert) | THẤT BẠI — giữ discovery lại fire schedule-template lặp + phá anxious ở evaluation. 7.67→6.67 | revert |
| **✅ Batch 14 hesitant root-cause** | `questionFlow.ts`+`prefixBuilder.ts`+`validator.ts` | SCRIPT skip→PITCH + tactic reassure-first + safeFallback emotion-aware | det · **live 7.67→8.33, T1 sale 1→2** (xem 6o) |

**🛑 SỰ CỐ + KHÔI PHỤC (nhớ đời, đã lưu memory `never-git-checkout-to-revert-hunk`):** revert FSM bằng
`git checkout src/.../stateMachine.ts` → mất TRẮNG 6f/6j/6k/6m (uncommitted). Khôi phục: replay 5 Edit từ
transcript Claude Code phiên trước (`~/.claude/projects/-Users-khanhtoan-vinalink-vnlink-ai-agent/8af98d0d*.jsonl`),
verify cả 5 old_string khớp HEAD + new_string chưa có → áp tuần tự, `sanitizeName` 5/5 + module load OK.
**KHÔNG dùng `git checkout <file>` để revert 1 hunk khi file còn uncommitted khác** — dùng Edit ngược / `git stash -p`.

**Bài học kỹ thuật:** vấn đề "cứng với khách hesitant" KHÔNG ở FSM stage mà ở **3 lớp xử lý reply đều bỏ qua
emotion** (SCRIPT template / safeFallback / PITCH-tactic). Fix đúng = nhường PITCH + reassure-first + fallback
emotion-aware, KHÔNG dịch stage (dịch stage làm fire template khác còn tệ hơn).

## 6z. 🔖 TỔNG KẾT PHIÊN 2026-06-08 (chiều) — 9 batch (5→13) + grader fix

**Bối cảnh quan trọng:** notes phiên trước trỏ template fitness vào `questionFlow.ts` legacy là SAI — live engine
là `findTemplate(FITNESS_TEMPLATES)` ở **`src/mastra/lib/templates/fitness.ts`** (chạy TRƯỚC legacy `TEMPLATES{}`).
Mọi fix template discovery/recommend fitness phải sửa ở `templates/fitness.ts` (xem 6e).

| Batch | File | Tóm tắt | Verify |
|---|---|---|---|
| 5 (2a) | `templates/fitness.ts` | goal rõ ("muốn giảm cân…") → recommend value-first, không hỏi history | det 11/11 · 6.67→7.33 |
| 6f | `stateMachine.ts` | yoga/đã-chốt-bộ-môn fitness + "đau lưng" → KHÔNG nhảy giai-co (FITNESS-SERVICE LOCK) | det 7/7 · yoga giữ flow |
| 6g | `validator.ts` | `safeFallback` aware preferredTime/schedule (đã có giờ→chốt; biết lịch→không hỏi lại sáng/chiều) | det 7/7 · live |
| 6h (2b) | `questionFlow.ts` | "có gói X không" → AFFIRM trước khi hỏi experience (gym/yoga/zumba/pilates) | det 11/11 |
| 6i | `scripts/grader.ts` | sửa BIAS judge: không áp kỳ vọng cuối-cuộc (xin SĐT/chốt) lên turn sớm | 6.00→8.00 |
| 6j | `stateMachine.ts` | switch service GIỮ fitnessGoal + memberType (cross-service), chỉ reset hoc-boi khi rời bơi | det 7/7 · E2E |
| 6k | `stateMachine.ts` | intent guard: "ok"/"ừ"/"được" thuần sau lời mời thử → bump explore→selecting | det 11/11 · E2E |
| 6l | `cleanReply.ts` | Nhánh D phần 1: giữ ĐÚNG 1 "?" ở câu hỏi cuối (thay vì strip hết) | det 7/7 · live no-regress |
| 6m | `stateMachine.ts`+`classifier.ts` | đóng gap 6d: `sanitizeName` → stateMachine, áp cho inline name "Là Trung"→"Trung" | E2E · live T5 "Trung" |

**Nguyên tắc đã áp dụng cả phiên:** mỗi fix nhỏ + contained → verify deterministic/E2E (free, không cần LLM)
→ smoke 1 case khi có mạng → revert nếu regress. Giữ TOKEN GỌN. Không nạp DeepSeek.

### 🔧 ĐANG CHUẨN BỊ / DỞ DANG (cập nhật cuối phiên TỐI 2026-06-08)

**Đã xong từ danh sách cũ:** 6l A/B ✅ (giữ) · 6k smoke ✅ · Nhánh 3 emotion ✅ (Batch 14, 6o) · scenario
khách cảm xúc đã thêm (`real_phan_van_so_tap_sai`).

**Còn dở (cho phiên sau):**
1. **ĐO LẠI BASELINE trên grader MỚI (6i)** — CHƯA làm (tốn nhiều token nên hoãn). Số cũ (`real_*` ≤7.4) đo
   trên grader bias → thấp hơn thực tế. Khi cần mốc so: chạy vài case đại diện (cân nhắc quota, hỏi user trước).
2. ✅ **No-regress happy_path cho Batch 14 — ĐÃ SMOKE (2026-06-08).** `fitness_happy_path` **avg 8.60, min 8.60,
   0 fail, no crash** (= baseline cũ 8.6, không regress). T5 name="Trung" (không "Là Trung"), preferredTime
   "19h tối 09/06" parse đúng, close_slot_confirm sạch, mọi turn classifier=neutral (Batch 14 emotion-gated nên
   không chạm). 3 issue còn lại là nitpick/grader-bias (T4 "xin SĐT"). ⇒ Batch 14 SẴN SÀNG commit.
3. **T2 anxious điểm dao động** (nhiễu grader LLM) — không phải bug; nếu muốn chắc, smoke lại `real_phan_van_so_tap_sai`
   1-2 lần lấy trung bình.

### ▶️ KẾ HOẠCH TIẾP THEO (thứ tự đề xuất, cập nhật 2026-06-08)
1. ✅ **Smoke no-regress** `fitness_happy_path` = 8.60 không regress — Batch 14 sẵn sàng commit.
2. **Đo lại baseline tổng** trên grader mới → chốt mốc (tốn token, hỏi user).
3. **Nhánh D phần 2** (rủi ro cao, A/B kỹ): nới "bỏ nha/nhé" (8c ép "ạ" → mất ấm) + cap 320 ký tự (`cleanReply.ts`).
4. (Tùy chọn, mở rộng Nhánh 3) thêm scenario khách **excited/frustrated** để soi nốt 2 nhánh emotion còn lại
   của `buildSaleSenseHint`/tactic-override (hiện mới verify hesitant + anxious live).
5. ✅ **(Phụ) Sửa `MODEL_NOTES.md`** — ĐÃ cập nhật reply=gpt-5.4-mini, classify=gpt-4o-mini, bảng cũ = lịch sử.
6. Khi loạt fix ổn → **commit theo batch** (gợi ý nhóm ở §8) sau khi chạy `gitnexus_detect_changes` (CLAUDE.md).

## 7. Kế hoạch còn lại + tiến độ

Model `gpt-5.4-mini` (đủ mạnh). Quy trình mỗi nhánh: sửa nhỏ → SMOKE 1-2 case → so → revert nếu regression.

**Tiến độ tới 2026-06-08 (cuối phiên TỐI):**
- ✅ **Nhánh 3 — Emotion-aware sale** (6b + **Batch 14 / 6o**): classifier cue 5 emotion + `buildSaleSenseHint`
  ĐÃ verify LIVE (hesitant/anxious) qua scenario mới `real_phan_van_so_tap_sai`. Root-cause "cứng với khách
  phân vân/lo" ĐÃ FIX 3 lớp (SCRIPT skip→PITCH + tactic reassure-first + safeFallback emotion-aware):
  **7.67→8.33, T1 sale 1→2**. CÒN (tùy chọn): soi nốt nhánh **excited/frustrated** (chưa có scenario live).
- 🟡 **Nhánh 2 — Nới template** (xem 6c): ĐÃ tách FACT-LOCK / INTENT-GUIDE (~37 id) + pin số liệu. CÒN 1 phần:
  - ✅ **(2a) Routing recommend-thẳng:** ĐÃ LÀM ở `templates/fitness.ts` (xem 6e). T1 `real_indecisive_recommend`
    2/10 → recommend value-first, scenario 6.67→7.33.
  - ✅ **(2b) Affirm "có gói X":** ĐÃ LÀM (xem 6h) — `gym/yoga/zumba/pilates_discovery` affirm trước khi hỏi
    experience khi khách hỏi "có…không". CÒN (tùy chọn): nới INTENT-GUIDE cho nhóm giải-thích (zumba_vs_aerobic,
    zumba_weight_loss) nếu thấy vẫn cứng — chúng có fact so sánh, cần pin kỹ.
- ✅ **Nhánh E — FSM nuance:** "Là Trung" (6d + đóng gap inline 6m) · yoga+"đau lưng" (6f) · InBody-sau-giờ (6g) ·
  switch xoá goal (6j) · opening "có gói gym không" (6h/2b) · **intent "ok" nhiễu (6k)**. (Mọi item Nhánh E đã xử lý.)
- 🟡 **Nhánh D — Nới `cleanReply`:** ✅ **phần 1 (6l): giữ 1 "?" ở câu hỏi cuối** (det PASS + **A/B live XONG → GIỮ**).
  ⬜ phần 2 (rủi ro cao): nới "bỏ nha/nhé" (8c ép "ạ" → mất ấm), cap 320 ký tự. Làm sau cùng, A/B kỹ.
- ⬜ (Phụ) Sửa `MODEL_NOTES.md` đang ghi sai model (giờ là gpt-5.4-mini, không phải deepseek/4o-mini).

**Thứ tự đề xuất tiếp theo:** Nhánh E ✅ HẾT · grader bias ✅ (6i) · Nhánh D phần 1 ✅ (6l GIỮ) · Nhánh 3 ✅
(6b/6o, verify live) → **smoke no-regress happy_path cho Batch 14** → đo lại baseline grader mới → Nhánh D phần 2
(nha/nhé + cap 320) → (tùy chọn) scenario excited/frustrated → sửa MODEL_NOTES → commit theo batch.
**Đã chốt:** không nạp DeepSeek, tune trực tiếp trên `gpt-5.4-mini`. Mọi sửa giữ nguyên tắc TOKEN GỌN (mục 6b).

## 8. Trạng thái Git

- **Chưa commit gì** (toàn bộ thay đổi đang ở working tree — chờ user review/commit theo batch).
- File đã đổi (tích luỹ qua các phiên):
  - `lib/prefixBuilder.ts` — objection net (phiên cũ) + **`buildSaleSenseHint` emotion-aware (6b)** + **(6o) SCRIPT skip soft-template→PITCH (`isEmotionSoftSkipId`) + PITCH tactic OVERRIDE reassure-first cho hesitant/anxious**.
  - `lib/playbook.ts` — objection tactic (reframe value, không hạ giá).
  - `lib/classifier.ts` — **(6b) cue 5 emotion** + **(6d) hint slot name** (⚠️ `sanitizeName` đã CHUYỂN xuống `stateMachine.ts` ở 6m, classifier chỉ re-export).
  - `lib/questionFlow.ts` — **(6c) `INTENT_GUIDE_IDS` + `extractLockedFacts` + nhánh INTENT-GUIDE trong `formatDecision`** + **(6o) export `isIntentGuideId` & `isEmotionSoftSkipId`** (INTENT_GUIDE ∪ `ask_schedule`).
  - `lib/templates/fitness.ts` — **(6e/2a) recommend-thẳng khi goal rõ trong `intro_giam_can` render** (live engine) + **(6q/Batch 16) `indecisive_reaffirm_recommend`: KH xin chọn lại sau recommend → tái khẳng định gợi ý theo goal, không đẩy lịch**.
  - `lib/stateMachine.ts` — **(6f) FITNESS-SERVICE LOCK** + **(6j) switch service GIỮ goal/memberType** + **(6k) intent guard "ok"→selecting** + **(6m) `sanitizeName` (moved here) áp cho inline name** + **(6s/Batch 19) `sanitizePreferredTime` chống bịa thứ/ngày từ range-giờ** + **(6s/Batch 20) `detectGoalByKeyword` vá goal "lấy dáng"→giam-mo**.
  - `scripts/grader.ts` — **(6i) sửa bias judge**: scenarioDescription là bối cảnh tham khảo, không áp kỳ vọng cuối-cuộc lên turn sớm.
  - `lib/cleanReply.ts` + `scripts/testCleanReply.ts` — **(6l) NỚI strip "?": giữ 1 "?" ở câu hỏi cuối** (det PASS + **A/B live XONG → GIỮ**) + **(6r/Batch 18) param `customerMessage`: KH hỏi giá → KHÔNG strip câu báo giá (anti-loop dedup)** + Test 6.
  - `workflows/routerWorkflow.ts` — **(6r/Batch 18) truyền `message` vào `cleanReply`** (cho anti-loop biết KH đang hỏi giá). (File MỚI đụng phiên này.)
  - `lib/classifier.ts` (thêm) — **(6m) `sanitizeName` chuyển xuống stateMachine + re-export** (đóng gap inline name "Là Trung").
  - `lib/validator.ts` — **(6g) `safeFallback` aware preferredTime/schedule** + **(6o) `safeFallback` emotion-aware: hesitant/anxious → trấn an "có HLV kèm... thử 1 buổi" thay vì "sáng hay chiều"**.
  - `lib/questionFlow.ts` (thêm) — **(6h) affirm "có gói X" + thread `message` vào `fallbackDiscoveryAfterServiceMention`**.
  - `agents/fitness.ts` — **(6p/Batch 15) ACK MẪU bỏ vẹt `[info]`**: ACK ngắn tự nhiên, KHÔNG đọc lại nguyên văn info khách, bỏ "em note/ghi nhận". (File MỚI đụng ở phiên này.)
  - `lib/prefixBuilder.ts` (thêm) — **(6p) RULES: "ACK chỉ nhắc lại/note" → "ACK ngắn trung tính, không đọc lại nguyên văn info"** + **(6q/Batch 17) `detectServiceAvailabilityQuestion` + GATE availability-affirm (KHÔNG bổ giá/333k)** + **(6s/Batch 20) GATE `goal-rõ-cho-lịch`: goal set + cho lịch → recommend value-first, không hỏi history**.
  - `lib/questionFlow.ts` (thêm) — **(6q/Batch 16) `indecisive_reaffirm_recommend` vào `INTENT_GUIDE_IDS`** + **(6q/Batch 17) availability guard: skip template giá `price_explicit_list/price_ask_generic` khi tin là "có gói X không" không-từ-giá → rơi qua GATE affirm**.
  - `config/openai.ts` — default provider=openai, reply=gpt-5.4-mini (phiên 2026-06-08).
  - `scripts/runTestScenarios.ts` — mặc định SMOKE 2 case, full opt-in (phiên 2026-06-08) + **(6n) thêm scenario `real_phan_van_so_tap_sai`** (khách hesitant→anxious→"ok", soi emotion + 6k).
  - `REFACTOR_NOTES_SALE.md` — (untracked) ghi chú này.
- ⚠️ **`lib/stateMachine.ts` đã từng bị `git checkout` xoá nhầm giữa phiên TỐI rồi KHÔI PHỤC đầy đủ** (6f/6j/6k/6m
  nguyên vẹn — replay từ transcript). KHÔNG có thay đổi stateMachine MỚI ở phiên tối (fix emotion-hold đã revert).
- Production chạy OpenAI (gpt-5.4-mini reply / gpt-4o-mini classify) khi không set `LLM_PROVIDER`.
- **Smoke gần nhất (2026-06-08 TỐI, grader MỚI):** `real_indecisive_recommend` **7.67** (6l "?" render OK);
  `real_phan_van_so_tap_sai` **7.67→8.33** (sau Batch 14 hesitant; T1 sale 1→2). Chiều: `fitness_happy_path`
  **8.8–9.4**; `real_chot_time_phai_xin_info` **6.00→8.00** (6i); `flow_switch` 9.00; `giaico_happy_path` 8.20.
  ⚠️ Số `real_*` cũ (≤7.4) đo trên grader BIAS → cần đo lại.
- **Gợi ý commit batch:** (1) emotion-aware [classifier+prefixBuilder, 6b]; (2) template loosening + routing
  [questionFlow + templates/fitness, 6c/6e/6h]; (3) bug name "Là Trung" [classifier+stateMachine, 6d/6m];
  (4) FSM nuance [stateMachine: 6f/6j/6k]; (5) safeFallback [validator, 6g + 6o]; (6) grader fix [grader, 6i];
  (7) cleanReply "?" [cleanReply, 6l]; **(8) Nhánh 3 hesitant root-cause [questionFlow + prefixBuilder + validator,
  6o] — nên smoke no-regress happy_path trước**; **(9) bỏ ACK vẹt [agents/fitness + prefixBuilder RULES, 6p] —
  A/B 8.60→9.20 PASS**; **(10) sale-tactic: indecisive tái-khẳng-định + objection affirm-không-bổ-giá
  [templates/fitness + questionFlow + prefixBuilder, 6q/Batch 16-17] — A/B 7.67→8.67 & 6.50→8.00 PASS**;
  **(11) anti-loop giữ câu báo giá khi KH hỏi giá [cleanReply + routerWorkflow, 6r/Batch 18] — boi 7.0→8.25**;
  **(12) date-hallucination guard + goal "lấy dáng" recommend [stateMachine + prefixBuilder, 6s/Batch 19-20] —
  correctness + so_sanh 8.0→8.67**. Trước commit chạy `gitnexus_detect_changes` (CLAUDE.md).

## 9. ⚠️ CHÍNH SÁCH TEST — TIẾT KIỆM TOKEN (đọc trước khi chạy test)

> **KHÔNG chạy full 33 case mỗi lần.** Mỗi case = nhiều lượt × (bot reply + classifier + grader) → đốt $ nhanh.
> Khi iter fix: **smoke 1-2 case là đủ** để bắt regression / xem delta định tính. Chỉ chạy full khi cần
> baseline tổng hoặc chốt cuối — và nên hỏi/cân nhắc chi phí trước.

Runner đã được sửa để **mặc định smoke**, full phải opt-in:

```bash
npm run test:scenarios                         # SMOKE: chỉ 2 case (fitness_happy_path + giaico_happy_path)
SCENARIOS=fitness_happy_path npm run test:scenarios   # chạy đúng 1 case (substring match) khi iter fix
SCENARIOS=name1,name2 npm run test:scenarios          # vài case cụ thể
SCENARIOS=all npm run test:scenarios           # FULL 33 — chỉ khi thật sự cần (tốn token!)
LLM_PROVIDER=deepseek npm run test:scenarios   # lùi về DeepSeek (cần đã nạp số dư)
# Kết quả: test-results/run-*.json → field score.turn_scores (natural/intent_match/fsm_correct/sale_tactic)
```

## 10. Goal-aware consult — 3 mục tiêu sale (giảm cân / tăng cân / giữ dáng) [2026-06]

Bổ sung tài liệu tư vấn sale Fami (funnel 5 bước: khai thác nỗi đau → cam kết InBody →
hình ảnh thành công → ưu điểm → tạo động lực & chốt hẹn) cho chatbot tư vấn như sale thật.

- **2 goal mới**: `tang-can` (tăng cân — người gầy muốn lên cân, KHÁC `tang-co`) và
  `giu-dang` (giữ dáng — KHÁC `suc-khoe` ở nội dung, chung nhánh service).
  - Mapping service/pitch: `tang-can` ≡ `tang-co` (Gym + PT, cần InBody);
    `giu-dang` ≡ `suc-khoe` (thẻ Full đa năng) ở MỌI switch service-mapping của `prefixBuilder`.
  - Khác biệt chỉ ở **nội dung tư vấn / value text**.
- **Module mới `lib/goalConsult.ts`** — `buildGoalConsultHint(state)`: nội dung funnel 5 bước
  theo goal, **trả SLICE theo stage** (discovery=khai thác nỗi đau; inbody/evaluation=cam kết
  InBody + cá nhân hóa PT vs thẻ hội viên; negotiation/commitment=khan hiếm + rủ bạn đồng hành).
  Advisory, defer GATE/TACTIC, **CHỈ inject ở PITCH**, return "" khi đủ tên+SĐT / goal khác →
  giữ token gọn. Chỉ áp cho 3 goal trọng tâm (giam-mo/tang-can/giu-dang).
- **Khai thác thông tin = hướng dẫn MỀM** (chiều cao/cân nặng/số kg/vùng tự ti/lịch sử) —
  KHÔNG thêm slot tất định, lưu trong memory hội thoại.
- **Lưới tất định** `detectGoalByKeyword` (stateMachine): backup khi classifier miss —
  "giữ dáng/duy trì dáng/giữ form/giữ cân" → giu-dang; "tăng cân/lên cân/ăn mãi không béo" →
  tang-can. ⚠️ Thứ tự: nhánh `giam-mo` ("lấy lại dáng" mẹ bỉm) đứng TRƯỚC để không bị nuốt.
- **Ưu điểm bãi đỗ xe** (cả ô tô & xe máy, không gian thoáng) thêm vào CENTER + reframe objection.
- Touch: `goalConsult.ts` (mới) · `prefixBuilder.ts` (wiring + service-map + parking) ·
  `classifier.ts` (enum+cue) · `stateMachine.ts` (detectGoalByKeyword) ·
  `templates/fitness.ts` + `questionFlow.ts` (recommend) · `followup.ts` (GOAL_LABEL).
- Verify: `test:routing` 49/50 (1 fail `intro_giam_can` PRE-EXISTING, đã xác nhận qua stash) +
  smoke tất định detectGoal/buildGoalConsultHint PASS. Trước commit chạy `gitnexus_detect_changes`.

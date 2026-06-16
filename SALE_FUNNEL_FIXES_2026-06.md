# Ghi chú — Deploy + Siết Funnel Sale (06/2026)

> Tổng hợp những thứ QUAN TRỌNG của đợt làm việc 15–16/06/2026: đưa bot lên production
> (Railway + Facebook Messenger) và siết luồng tư vấn sale (funnel TL Fami) cho khít kịch bản.
> Đọc kèm: `REFACTOR_NOTES_SALE.md` (refactor trí tuệ sale 07–08/06), `CLAUDE.md`, `MODEL_NOTES.md`.

---

## 1. Production deploy (tra cứu nhanh)

| Mục | Giá trị |
|---|---|
| **Host** | Railway — service `vnlink-ai-agent`, domain `https://vnlink-ai-agent-production-7f2a.up.railway.app` |
| **Repo deploy** | GitHub `LuongKhanhToann/vnlink-ai-agent`, nhánh `main` (push main → auto redeploy ~2–3 phút) |
| **Git push** | Phải dùng account `LuongKhanhToann` (`gh auth switch --user LuongKhanhToann` + `gh auth setup-git`) |
| **FB app** | "fitness AI" id `881028305048280` — đang **Development mode** (chỉ admin/tester chat; public phải App Review quyền `pages_messaging`) |
| **FB page thật** | graph id `1125189254015764` "Fitness yoga" (KHÁC `61590800311987` = profile id) |
| **Webhook** | `POST /{app-id}/subscriptions` (object=page, callback `/webhook`, verify_token) + `POST /{page-id}/subscribed_apps`. Route: `src/mastra/routes/facebook.ts` |
| **Token** | `FB_PAGE_ACCESS_TOKEN` long-lived (expires_at=0), rút qua `/me/accounts` từ long-lived user token |

### Gotcha deploy (đã mất nhiều thời gian)
- **PORT**: Mastra hard-code `server.port` → Railway 502. Fix = `port: Number(process.env.PORT) || 4112`
  trong `src/mastra/index.ts` **VÀ** set Variable `PORT=4112` trên Railway (khớp target port domain).
- 404 = domain chưa gắn deployment · 502 = container chạy nhưng sai port / crash boot (thiếu env PG_* cũng 502).
- `BASE_URL` phải có `https://` + đúng domain (dùng để gửi ảnh/QR).
- **OpenAI quota**: nếu key OpenAI hết hạn mức → mọi `agent.generate` fail ("exceeded your current quota")
  → **bot prod im hoàn toàn**. Triệu chứng smoke: tất cả turn trả `(failed)`. Nạp quota/đổi key là xong.

---

## 2. Kiến trúc funnel (định vị khi sửa)

```
routerWorkflow → classifier (LLM 3 trục: domain/service/attribute)
  → stateMachine (FSM: stage transition + slots, store-first)
  → prefixBuilder.buildPrefixWithMeta (dựng prompt theo stage)
  → fitnessAgent.generate → cleanReply (hậu xử lý tất định) → validator (lưới an toàn)
  → routes/facebook.ts (gửi Messenger)
```

**Stage FSM (funnel TL Fami)** — `opening → discovery → inbody → evaluation → negotiation → commitment`
(+ objection/recovery/retention). Nguyên tắc: **KHAI THÁC NỖI ĐAU đủ sâu TRƯỚC khi pitch InBody/gói**.

**2 path dựng prefix cho FITNESS (quan trọng — biết để sửa đúng chỗ):**
- **Lean prefix (mode=PITCH)** = path CHÍNH cho fitness. Thứ tự dòng: meta → **`buildFitnessLeadTactic`
  (TACTIC đầu, §9.2)** → known → `buildFitnessStageFocus` (= "[VIỆC CẦN LÀM]") → `buildFitnessAnswerFirst`.
  **KHÔNG chạy** `buildLogicGate`/`buildFewShot`.
  → Đổi hành vi fitness (chốt, ưu đãi nhóm, hỏi ngày…): sửa `buildFitnessStageFocus`; muốn FORCE 1 khúc
  hay drift (inbody/objection): sửa `buildFitnessLeadTactic` (ở ĐẦU, mini-model tuân tốt hơn).
- **Legacy path** (`buildLogicGate` + `buildFewShot` few-shot) — dùng cho giai-co và 1 số nhánh.

---

## 3. Các fix đợt này (commit theo thứ tự)

| Commit | Nội dung |
|---|---|
| `c83ab3a` | Listen `process.env.PORT` cho Railway + gom fix sale/funnel/follow-up |
| `a22086a` | Hoàn thiện funnel tăng/giảm cân: ảnh before-after + khan hiếm + cá nhân hóa PT-vs-thẻ |
| `d8b0292` | Hỏi thẳng, bỏ rào "để em hỏi thêm…" nghe sáo |
| `835b10a` | Bỏ so sánh stage thừa (TS2367) |
| `20b731a` | **Bỏ hỏi "sáng hay chiều" sớm** với khách body-goal trong discovery (gate few-shot lịch) |
| `634f499` | **Nới opener** (bỏ lặp "Dạ vâng anh") + fallback body-goal không chốt lịch sớm |
| `e426437` | **Báo đúng bảng giá HS/SV thật**, doanh nghiệp → xin SĐT |
| `f36e2ad` | **Siết 3 chỗ**: đào sâu thêm 1 lớp (turn≥5), ưu đãi nhóm, chốt NGÀY trước |
| `f8a6841` | **Siết LUỒNG 2 (giảm cân, đã biết tập)**: gốc rễ classifier `.catch()` (parse-fail 7→0) + lead-tactic đầu prefix (InBody/objection) + cắt preferredTime bịa. Xem **§9** |

### Chi tiết 3 fix cuối (f36e2ad)
1. **Đào nỗi đau sâu hơn**: `stateMachine.painExploredDeep` ngưỡng chống-kẹt `turnCount >= 4 → >= 5`
   → turn 4 không còn nhảy InBody/before-after sớm; có thêm 1 lớp khai thác (cao-nặng → vùng tự ti → thói quen).
2. **Ưu đãi nhóm**: thêm directive vào evaluation/negotiation focus — khi khách TỰ nhắc rủ bạn/đi cùng
   người thân → BÁM NGAY xác nhận có ƯU ĐÃI NHÓM (LLM đọc cue, KHÔNG regex, KHÔNG bịa %).
3. **Chốt NGÀY trước**: `buildFitnessStageFocus` (commitment) tách 3 nhánh:
   - chưa chốt được ngày (vague "cuối tuần" / chỉ buổi) → gợi 2 NGÀY cụ thể, CHƯA xin SĐT, KHÔNG hỏi "buổi";
   - đã có NGÀY cụ thể ("thứ 7") → xin tên+SĐT;
   - đủ tên+SĐT+ngày → xác nhận giữ slot rồi DỪNG.

---

## 4. GOTCHA TEST CỰC KỲ QUAN TRỌNG (đọc trước khi smoke)

### 4.1 Harness PHẢI bind storage, nếu không state KHÔNG persist
- Import `routerWorkflow` trực tiếp rồi `createRun()` → `mastra.getStorage()` trả **null** → state
  (stage/slots) KHÔNG lưu/load → **mỗi turn về DEFAULT_STATE** → stage nhảy loạn opening↔discovery,
  "chốt hụt", "bounce". **ĐÂY LÀ ARTIFACT HARNESS, KHÔNG phải bug production** (prod dùng PG, persist OK).
- **Fix harness**: `import "./src/mastra/index";` (side-effect dựng Mastra + bind storage) TRƯỚC khi
  import/dùng `routerWorkflow`. Dấu hiệu OK: log `[process] next: stage=...` tiến dần, KHÔNG thấy
  `[stateStore] getStorage() returned null`.
- Conversation history (working memory) persist riêng → reply vẫn "mạch lạc" dù state hỏng → DỄ TƯỞNG NHẦM là OK.

### 4.2 Mẫu smoke chuẩn
```ts
import "./src/mastra/index"; // BẮT BUỘC — bind storage
import { routerWorkflow } from "./src/mastra/workflows/routerWorkflow";
const run = await routerWorkflow.createRun();          // KHÔNG phải createRunAsync
const result: any = await run.start({ inputData: { message, threadId, resourceId } });
const reply = result?.steps?.["call-fitness"]?.output?.reply
           ?? result?.steps?.["fallback"]?.output?.reply;
```
Chạy: `STORAGE_BACKEND=libsql npx tsx _smoke.ts` (libsql `:memory:` — chung trong 1 process). Dùng threadId mới mỗi lần.

### 4.3 Verify TẤT ĐỊNH không cần LLM (khi hết quota / muốn nhanh)
Gọi thẳng `buildPrefixWithMeta(state, message, prevBotReply)` với `state` tự dựng từ `DEFAULT_STATE`
→ in `.prefix` → kiểm tra các hint `[VIỆC CẦN LÀM ...]` ra đúng nhánh. Đây là phần code mình kiểm soát;
LLM chỉ bám theo hint đó.

---

## 5. Sự thật về GIÁ (đừng tưởng model bịa)

- **HS/SV CÓ bảng giá THẬT** trong code (`prefixBuilder.buildFitnessPricing`, kích hoạt khi
  `memberType="hoc-sinh"`): **Full HS/SV: 1 tháng 700k · 3 tháng 2tr · 6 tháng 3tr · 12 tháng 4tr**.
  → "SV 700k" KHÔNG phải bịa. **Quyết định user (16/06): báo THẲNG đúng bảng này**, KHÔNG né "xin SĐT".
- **Doanh nghiệp/công ty**: KHÔNG có bảng cố định → nói "có ưu đãi riêng" + xin SĐT cho sale.
- Giá chuẩn khác: Full 7tr/12 tháng · Gym 4.5tr/12 tháng (3 buổi/tuần) · PT 20 buổi 6tr ·
  Học bơi 1-1 12 buổi 3tr · lớp nhóm 1.2tr · Combo Full từ 333k. **CẤM bịa số ngoài bảng PRICING.**

---

## 6. Ngày/chốt — phân biệt 2 helper (BẪY dễ dính)

- `hasConcreteDate(s)` = chỉ true khi có **DD/MM** ("thứ 7 (21/6)"). "thứ 7" trần → **false**.
- `isPreferredTimeSpecific(s)` = true khi có **thứ-trong-tuần** ("thứ 7", "chủ nhật") **hoặc** DD/MM.
  "cuối tuần"/"tuần sau"/"sáng" → false.
- **Khi quyết định "khách đã chốt được NGÀY chưa" → dùng `isPreferredTimeSpecific`.** Nếu lỡ dùng
  `hasConcreteDate`, khách nói "thứ 7" vẫn bị coi là chưa chốt → bot **loop hỏi ngày mãi**.

---

## 7. HARD RULES (lặp lại nhiều lần — TUÂN THỦ)

- **KHÔNG regex/keyword cho quyết định business** (phân loại ý, route). Dạy model bằng prompt rõ +
  ví dụ, hoặc reuse output classifier (`intentTopic`/`intentSignal`/slots). Regex chỉ cho parse kỹ thuật thuần.
- **KHÔNG cache** bất kỳ kiểu nào. Đọc state mới mỗi request. (Working memory / lịch sử hội thoại là
  feature, KHÔNG phải cache — giữ.)
- **KHÔNG liệt kê câu ví dụ** trong prompt để "mồi" (priming) → nói RULE chung. Lặp 1 cụm opener cố định
  ("Dạ vâng anh") mọi tin = nghe như máy → đổi nhịp mở mỗi tin.
- **cleanReply ending**: câu kết "ạ", BỎ HẾT dấu "?".

---

## 8. Trạng thái cuối (16/06/2026)

Smoke LLM nguyên luồng 22 lượt (tăng cân, khách chưa biết tập) — **mượt, khít kịch bản**:
- Đào nỗi đau đủ sâu (turn 2–4 discovery) → InBody → before-after fire đúng lúc nghi ngờ (turn 9)
  → giá đúng (kể cả HS/SV) → ưu đãi nhóm khi rủ bạn → chốt NGÀY (cuối tuần → thứ 7/CN) → giữ slot → DỪNG.
- Opener đa dạng, không lặp "Dạ vâng anh". Xưng hô nhất quán.

**Sạn nhỏ còn lại (không gãy luồng):** thỉnh thoảng pitch InBody sớm 1 lượt; câu nghi-ngờ đôi khi bị
validator reject → fallback (đã giảm); wording lặt vặt ("20h chiều"). Có thể tinh chỉnh tiếp nếu cần.

---

## 9. Đợt siết LUỒNG 2 — giảm cân · khách ĐÃ biết tập (16/06, commit `f8a6841`)

> Test 1 mạch 21 lượt kịch bản "🅱️ LUỒNG 2": giảm cân + SAU SINH + đã tập gym/chạy bộ 2 năm (yo-yo)
> → InBody → thẻ hội viên (KHÔNG ép PT) → before-after → đa môn (zumba+bơi) → giá → reframe value
> → ưu đãi nhóm → chốt NGÀY → xin SĐT → giữ slot → after-close.
> **Test script tái dùng:** `src/mastra/scripts/testLuong2GiamCan.ts`
> Chạy: `STORAGE_BACKEND=libsql npx tsx src/mastra/scripts/testLuong2GiamCan.ts`

### 9.1 ⭐ GỐC RỄ — classifier rớt nguyên classification (BUG NẶNG, ẩn lâu)

**Triệu chứng:** directive RỚT ngẫu nhiên ~50% — vd "đắt thế e" lúc `domain=objection` (reframe value đúng),
lúc `domain=null` (cả signal trống, emotion=neutral) → bot tụt giá "gói nhẹ hơn". KHÔNG phải teaching gap,
KHÔNG phải temperature, KHÔNG phải prompt.

**Root cause:** `classify()` dùng Mastra structuredOutput + Zod schema STRICT enum. gpt-4o-mini thỉnh thoảng
trả 1 field lệch enum (`honorific="em"`, `intent` lạ, emotion lạ) → Zod **throw** `MastraError: Structured
output validation failed` → catch → `getDefaultClassification` (domain=null) → **MẤT TOÀN BỘ classification**.
Đếm được **4–7 lần / 21 lượt**.
- **Phát hiện:** `grep -c "structuredOutput trả về null\|classifier] LLM error" <log>`.
- **Bẫy:** isolated probe gọi `classify("đắt thế e")` ra `objection` 11/11 → tưởng đã fix; nhưng trong
  luồng thật vẫn rớt vì field KHÁC (honorific/intent) lệch enum, không liên quan message.

**Fix (`classifier.ts` `classifierSchema`):** bọc `.catch(default)` MỌI enum — `emotion→"neutral"`,
`intent→"explore"`, `honorific/flow/intentSignal/secondaryIntents/service→null`. Field lệch coerce về
default, **GIỮ** phần còn lại (domain/slots) thay vì vứt hết. Sau fix: **0 parse-fail/run**, objection ổn định.
→ Đây là "harden parse step" (hợp HARD RULE no-regex), KHÔNG phải keyword guard.
**Quy tắc debug mới:** "directive lúc có lúc không" / "domain=null vô lý" → **nghi NGAY Zod enum throw, KHÔNG nghi prompt.**

### 9.2 Lead-tactic đặt ĐẦU prefix (`prefixBuilder.buildFitnessLeadTactic`)

Theo MODEL_NOTES "TACTIC đầu > GATE giữa": mini-model tuân directive ở ĐẦU prefix tốt hơn ở giữa. Hoist 1
dòng sắc ở đầu cho 2 khúc hay drift (insert ngay sau dòng meta trong `buildFitnessLeanPrefix`):
- **inbody** → "PITCH InBody + khách ĐÃ biết tập → thẻ hội viên + tự dựa InBody chọn máy (KHÔNG ép PT);
  chưa biết → HLV lên giáo án. ⛔ KHÔNG hỏi 'sáng hay chiều'/đặt lịch." (trước đây bot nhảy "sáng hay
  chiều" ở turn 7 vì directive này nằm GIỮA prefix, ⛔ bị chôn cuối block).
- **objection** → "reframe GIÁ TRỊ (700m2 + bể 4 mùa + GV Ấn Độ + bãi xe) + mời thử. ⛔ KHÔNG 'gói nhẹ hơn/rẻ hơn', không tụt giá."
- **Guard quan trọng:** lead-tactic inbody TẮT khi `ki.name && ki.phone` hoặc `domain=commitment/scheduling`
  — lúc đó việc cần làm là hỏi giờ/giữ slot, đừng đè "xin khung giờ" bằng pitch InBody.

### 9.3 Cắt preferredTime BỊA (`stateMachine.sanitizePreferredTime` — tổng quát hóa)

Classifier bịa `preferredTime` từ tin KHÔNG có thời gian (vd "ok qua thử" / "thử 1 buổi xem" →
"17h chiều thứ 4 17/06") → bot xác nhận **SAI NGÀY** (chốt thứ 4 trong khi khách nói "sáng chủ nhật").
- Guard cũ chỉ chặn khi message có **range-giờ** ("7-9h") → bỏ sót case "không có cue gì".
- **Mới:** nếu message KHÔNG có BẤT KỲ cue thời gian nào (không thứ/ngày/DD-MM + không giờ `\d+h` + không
  buổi sáng/trưa/chiều/tối/đêm — "1 buổi" KHÔNG tính) → cắt sạch preferredTime (return null).
- **An toàn:** `mergeSlots` vẫn giữ preferredTime CŨ trong state → chỉ chặn giá trị MỚI bịa, KHÔNG xoá lịch
  thật. Test: "8h sáng mai"/"chiều 17h"/"buổi tối" vẫn giữ slot đúng (regression pass).

### 9.4 Phụ trợ
- `classifier.ts` **temperature 0.1 → 0**: objection terse ("đắt thế e") ổn định; tác dụng phụ bịa ngày đã
  chặn ở §9.3 nên temp 0 an toàn.
- `classifier.ts` thêm example objection terse ("đắt thế", "đắt v", "mắc v"...) + FOLLOW-UP CONTEXT rule:
  "tin trước bot vừa BÁO GIÁ → KH phản ứng ngắn tiêu cực → objection/price_too_high".

### 9.5 Kết quả run cuối (v9) — sạch, ổn định
- parse-fail **7→0** · turn 7 InBody + đã-biết-tập (không "sáng hay chiều") ✅ · turn 13 objection →
  reframe đủ 4 value point, không tụt giá ✅ · closing không bịa ngày → chốt đúng "sáng chủ nhật 21/06" ✅.
- `npm run build` OK · regression closing (8h sáng mai/chiều 17h/buổi tối) giữ slot đúng ✅.
- **Sạn nhỏ:** câu xác nhận tên+SĐT đôi khi hơi cụt (state vẫn đủ, turn sau chốt lại đúng); xưng "anh/chị"
  1–2 lượt đầu trước khi khóa "chị" (nhiễu mini-model, tự sửa).

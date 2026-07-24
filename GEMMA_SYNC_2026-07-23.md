# Đồng bộ bản gemma4:12b theo bản gpt-5.4 — 2026-07-23

Phạm vi: nâng bản **gemma4:12b self-host** (`ENGINE=gemma`) lên đúng LOGIC + VĂN PHONG của bản
5.4 đang live (`engine/prompts.ts`, `engine/brain.ts`, `lib/cleanReply.ts`, `lib/replyGuards.ts`).
**Chưa deploy** — mới nâng cấp + test.

Nguyên tắc xuyên suốt: gemma4:12b KHÔNG khoẻ như gpt-5.4 → mọi hành vi **phải-đúng-100%**
(ngày hẹn, bộ ảnh, nhịp phễu, có số tiền khi khách hỏi giá) ép bằng **code**, không phó mặc model;
phần tra cứu dài (bảng giá) chỉ bơm **đúng lượt cần**, không để thường trú làm loãng prompt.

## Thay đổi kiến trúc

| Trước | Sau |
|---|---|
| 1 prompt GỘP cả Fami + Hoa Sen | **Tách theo nhánh** như 5.4 có 2 agent riêng (`buildSystemPrompt(dateBlock, flow)`) |
| Model tự ghi dòng `MEDIA: <key>` | **Classifier quyết bộ ảnh** (cổng deterministic như turnRouter của 5.4), code fetch + dedup |
| Không có hậu xử lý câu chữ | Dùng CHUNG `cleanReply` + `replyGuards` với bản 5.4 |
| Pipeline chép tay ở 3 file (prod / run.ts / serve.ts) → trôi lệch | 1 nguồn duy nhất `engine/gemma/pipeline.ts`; harness `vnlink-gemma4/*.ts` chỉ còn shim re-export |
| Slot khách khai chỉ là cờ boolean | Slot GHI DẦN (bộ môn, mục tiêu, thể trạng, vùng đau, đối tượng…) → khối `[ĐÃ BIẾT]` mỗi lượt, tương đương `recordLead` + header động của 5.4 |
| num_ctx 8192, prompt gộp 5.4k token | num_ctx 16384; prompt/nhánh: fitness 6.1k · giải cơ 4.1k token |

## Nội dung bê từ 5.4 sang

VOICE đầy đủ (chống nịnh, 1 tin = 1 bước, câu hỏi đủ chủ ngữ, giá viết chữ đầy đủ, lời chào tin đầu
luôn "anh/chị") · phễu fitness (mở đầu ấm không khoe cơ sở, discovery theo môn, InBody, anchor giá,
trial-close 1 lần) · phễu giải cơ (discovery → evaluation, cấm giảng cơ chế ở tin đầu) · CHỐT LỊCH 2
bước · SAU CHỐT chăm khách quen · chống bịa · an toàn (bầu/sau sinh/bệnh nền/chấn thương cấp) ·
bảng giá Excel 07/2026 đầy đủ (bản gemma cũ thiếu giáo viên, Fami ECO, PT HS/SV, Pilates 30 buổi).

## Lỗi bắt được qua test và cách vá

| # | Lỗi (thấy trong transcript) | Vá |
|---|---|---|
| 1 | "c muốn đi bơi" không nhận ra là CHỊ → gọi "anh/chị" cả cuộc | dạy classifier viết tắt a/c/e |
| 2 | Hỏi giá → xổ cả 4 mốc 1/3/6/12 tháng | context ép 1 gói + 1 mốc, hé gói ngắn hơn |
| 3 | Ảnh bắn sớm 1 nhịp (khách mới tự ti/kể thất bại cũ) → lúc khách thật sự nghi ngờ thì hết ảnh | thêm ví dụ PHÂN BIỆT vào luật chọn media |
| 4 | "1m72 54kg → thiếu 10-13kg" (tính tới giữa khoảng) | dạy tính tới MÉP GẦN NHẤT + ví dụ số |
| 5 | Bot ghi "thứ Hai 28/07 hay thứ Ba 29/07" (28/07 mới là thứ Ba) → khách chọn xong lệch lịch | **code tính sẵn 2 ngày** theo khung khách nói, model chỉ chép |
| 6 | Khách nói "ừ qua thử" (không nêu ngày) → classifier bịa ngày, bot xác nhận lịch | chốt ngày phải khớp CẢ `ngay_hen` (nguyên văn) lẫn `ngay_hen_chuan` |
| 7 | Khách vừa than đau → bot giảng cơ chế + so massage ngay tin đầu | cổng discovery suy từ TRẠNG THÁI (`painTurns<=1`), + regenerate khi tin thiếu câu hỏi |
| 8 | classifier nhặt "dạo này" thành thời gian đau → tưởng đủ slot, bỏ qua nhịp hỏi | siết định nghĩa `thoi_gian_dau` (phải là mốc đo được) |
| 9 | Câu mẫu "phần này em vừa chia sẻ ở trên rồi" (HARD-LOOP của cleanReply) NÉ câu hỏi giá | dính câu mẫu → bỏ lớp anti-loop, giữ nội dung thật |
| 10 | Cắt câu lặp xong còn **tin rỗng** → khách nhận tin trắng | giữ bản nháp nếu cắt xong <15 ký tự + lưới cuối chống reply rỗng |
| 11 | Khách hỏi 3 ý (có bể / giá / ở đâu) → model trả 3 ý nhưng **cap 320 ký tự cắt mất câu giá** | dạy tin ≤3 câu + đặt số tiền ở 1-2 câu đầu; thêm guard regenerate khi lượt hỏi-giá mà tin không có số tiền |
| 12 | "có gói nào rẻ hơn không" bị guard chê-đắt chặn → bot né số | tách khỏi `khach_che_dat`, bắt buộc nêu gói cụ thể + số tiền |
| 13 | Khách hỏi thông tin liên tiếp → tin nào cũng đính "mình quan tâm bộ môn nào" | thêm cờ `khach_hoi_thong_tin` + luật trả gọn rồi dừng |
| 14 | Chống lặp câu hỏi chết vì prompt cấm dấu "?" (không trích được câu hỏi) | cho model viết "?", `cleanReply` xoá trước khi khách thấy (đúng như 5.4) |
| 15 | Rớt mạng qua tunnel làm mất 41 lượt trong 1 vòng test | retry 1 lần khi lỗi mạng (không retry khi bị huỷ chủ động) |

## Test đã chạy

- **16 kịch bản luồng dài** (`vnlink-gemma4/run.ts`, dùng chung `scenarios.ts` với bản 5.4) —
  chạy nhiều vòng (`out-v4`, `out-v5`), mỗi vòng ~250 lượt, đọc tay từng câu.
- **Vòng kiểm tra lại** sau mỗi batch vá (`out-v6`, `out-v7`, `out-final`) trên nhóm kịch bản
  nhắm đúng chỗ vừa sửa.
- Nghiệm thu đúng: chào mở đầu, sticky flow + đổi flow gym↔giải cơ không lẫn giá/địa chỉ,
  answer-first, giá đúng bảng (gym 12 tháng 4.5 triệu ≠ FULL 7 triệu), HS/SV báo đúng bảng FULL,
  ảnh gửi đúng bộ + không gửi lại, chốt lịch 2 bước với ngày/thứ khớp lịch thật, sau chốt không xin
  lại thông tin, an toàn (cấp tính/bầu/bệnh nền) không mời liều, chống bịa (xông hơi/boxing/trả góp).

---

# Đợt 2 — đổi backend + refactor nhánh gemma (cùng ngày 23/07)

## Backend LLM mới

Endpoint cũ (`100.112.147.122:11439`) chết hẳn. Backend giờ là **proxy có xác thực**:
`https://rhass-desktop.tail189c58.ts.net/gemma/api/chatplus`, **bắt buộc** header
`Authorization: Bearer <GEMMA_API_KEY>` (thiếu là 401). Key + URL nằm trong `.env` của
`vnlink-ai-agent`; code đọc env **lúc gọi** chứ không lúc load module (import bị hoist nên harness
nạp `.env` sau `pipeline.ts` → đọc sớm là ra rỗng). Harness ngoài cây `node_modules` nên có
`vnlink-gemma4/env.ts` tự parse `.env`, không cần `dotenv`.

## Bố cục mới của `engine/gemma/` (tách từ pipeline.ts 445 dòng)

| File | Việc |
|---|---|
| `llm.ts` | endpoint/model/key (đọc lazy), timeout, **retry lỗi tạm thời**, 2 kiểu gọi: văn bản / JSON schema |
| `dates.ts` | mọi phép tính thứ-ngày (bảng ngày, nhãn ngày, 2 ngày cho khách chọn) |
| `text.ts` | soi hình thức bản nháp: nhặt câu hỏi, chuẩn hoá, đo trùng, **đếm mốc tiền** |
| `pricing.ts` | **bảng giá có cấu trúc** + `buildPriceDirective()` cắt đúng vài dòng cần bơm |
| `mediaGate.ts` | cổng ảnh deterministic (chặn tin đầu, 1 bộ/concept/cuộc) |
| `draftRules.ts` | **bảng luật soát bản nháp** (5 luật, luật đầu bắt được thì sinh lại 1 lần) |
| `pipeline.ts` | chỉ còn nhịp 1 lượt, ~230 dòng, re-export cho 3 nơi gọi |
| `classifier.ts` · `state.ts` · `prompt.ts` | như cũ, bỏ phần bảng giá dài sang `pricing.ts` |

3 file shim chết trong `vnlink-gemma4/` (`classifier.ts`, `prompt.ts`, `state.ts`) đã xoá — không
ai import. Thêm `vnlink-gemma4/check.ts`: **75 kiểm tra thuần code, chạy <1s, không gọi model**
(ngày tháng, bảng giá bơm đúng gói, 5 luật soát nháp, FSM, cổng ảnh, khối bối cảnh).

## Lỗi đợt 2 và cách vá

| # | Lỗi (thấy trong transcript) | Vá |
|---|---|---|
| 16 | Hỏi giá lại **xổ 3-4 mốc** (HOIGIA lượt 1, 3) | bảng giá không còn bơm nguyên khối kiểu "500k · 1.5 · 2.5 · 4.5"; code tra đúng gói rồi bơm **mỗi mốc một dòng** + `LUẬT 1 MỐC` đứng ngay trên bảng |
| 17 | "sao đắt thế" bị coi là hỏi giá → **ép sinh lại** để nhét số vào tin reframe | classifier: chê giá mà không xin mức khác → `khach_hoi_gia=false`; luật thiếu-số bỏ qua lượt `cheDat` |
| 18 | Vẫn xổ nhiều mốc sau khi sinh lại | thêm luật `xo-nhieu-moc-gia` (đếm mốc tiền, HS/SV được 4, còn lại 2) |
| 19 | **Bịa giá** "gói bơi 12 tháng 1 triệu" (NHOICAU) — classifier đoán nhóm giá là "vé bơi lẻ" nên bảng thẻ tập bị giấu | bảng thẻ tập **luôn** được bơm, bảng nhóm chuyên biệt chỉ nối thêm; dạy classifier "gói tháng" ≠ vé lẻ |
| 20 | **Bịa giá** "1 buổi giải cơ 400 nghìn" (DEDAT) — hỏi liệu trình nên chỉ bơm bảng liệu trình | bảng BUỔI LẺ luôn có mặt ở nhánh giải cơ |
| 21 | Slot rác `vùng đau=chưa rõ` trôi vào khối [ĐÃ BIẾT] và lead | dặn classifier để `""`, + lọc placeholder ở bước parse (`isPlaceholder`) |
| 22 | Xin "gói rẻ hơn" mà bot lặp lại đúng số vừa báo | luật: con số phải là mốc **KHÁC, chưa từng báo** |
| 23 | Mất trắng 2 lượt vì `fetch failed` / proxy trả 502 | retry 3 nhịp (2s · 6s · 15s) cho cả lỗi mạng lẫn HTTP 502/503/504 |
| 24 | Chạy test 2-3 luồng song song làm GPU nghẽn (1 call 8 token mất 13s, proxy 502) | `CONCURRENCY` mặc định = **1**, đúng với prod (mỗi khách 1 lượt) |
| 25 | Khách nói "cuối tuần" mà bot chào "Chủ nhật 26/07 **hoặc thứ Hai 27/07**" — luật chống-lặp đẩy 12B tránh ngày đã nêu lượt trước | dòng 2-ngày chuyển LÊN ĐẦU khối bối cảnh + ghi rõ luật chống lặp KHÔNG áp dụng cho 2 ngày này |
| 26 | Chấn thương cấp: bot **gửi ảnh ca giải cơ** và nói "KTV sẽ điều chỉnh kỹ thuật cho vùng đang viêm" (nghe như làm được ngay), rồi hỏi ngày | cổng ảnh chặn khi `anToan=cap-tinh`; chỉ dẫn an toàn RIÊNG cho ca cấp tính (nghỉ 3-5 ngày, chườm đá, đi khám); cấm mọi nhịp hỏi ngày |
| 27 | "c muốn đăng ký tập gym giảm cân" bị đọc là hỏi giá → bot xổ giá ngay tin đầu, sai nhịp phễu | dạy classifier: nêu nhu cầu/đăng ký ≠ hỏi giá |
| 28 | Lead ghi Sheets ra `preferredTime = "chủ nhật Chủ nhật 26/07"` | siết `gio_hen` (chỉ giờ/buổi trong ngày) + bỏ vế trùng khi ghép ở `gemmaBrain.ts` |
| 29 | Bảng HS/SV 4 mốc làm tin dài 447 ký tự → `cleanReply` cắt đuôi, **nuốt sạch giá**: khách hỏi giá nhận lại tin không có số nào | HS/SV cũng theo luật 1 mốc như mọi gói (báo 1 mốc + tên đúng thẻ, không né) — tin ngắn thì không bao giờ bị cắt mất giá |

**Quyết định có đổi hành vi:** trước đây HS/SV được đọc cả 4 mốc "cho khách thấy trọn ưu đãi".
Giờ báo 1 mốc như mọi gói. Lý do ở dòng 29 — đọc cả bảng là cách chắc chắn mất giá, còn 1 mốc thì
luôn tới tay khách và vẫn KHÔNG né (vẫn gọi đúng tên thẻ FULL HS/SV, vẫn có số).

## Test đợt 2

- `check.ts`: **82 kiểm tra thuần code** — xanh.
- Kịch bản luồng dài (`out-r2` … `out-r7`), đọc tay từng câu: HOIGIA · NHOICAU · DEDAT · GIAICO ·
  TANGCAN · POOL · GYM · YOGA · GIAMCAN · DOIFLOW · CAPTINH · ANTOAN · FACTGIAICO · CHOTLAI —
  **~250 lượt**, tốc độ **18-22s/lượt** chạy tuần tự.
- **Smoke qua ĐÚNG đường prod** (`smokeGemma.ts`, `STORAGE_BACKEND=libsql`): 4 kịch bản đều đạt —
  giá đúng bảng, ngày Chủ nhật 26/07 khớp lịch thật, tên "Mai" không bị đọc thành "ngày mai",
  lead map đủ `{tên, sđt, ngày 26/07}` → `intent=ready`, `stage=commitment` (Sheets ghi được),
  ảnh before-after bung URL Cloudinary thật, ca chấn thương cấp trả đúng lời khuyên an toàn.

## ⚠ Việc còn treo

- **Chưa deploy** — mới nâng cấp + test.
- Cân nhắc `OLLAMA_NUM_PARALLEL=1` trên box GPU (bot prod xử lý tuần tự từng khách).
- Còn vài chỗ 12B nói thừa/nhẹ tay, chưa vá vì không sai fact: đôi lúc gắn thêm 1 câu hỏi bán hàng
  vào cuối tin trả lời thông tin; câu mở thỉnh thoảng cụt ("Dạ việc kết hợp giữa tập luyện và giải
  cơ, vì khi…"); vài chi tiết ngoài grounding nhưng vô hại (có sẵn thảm yoga, nên mang nước).

## Còn lại, chưa vá (chấp nhận cho 12B)

- Ảnh thỉnh thoảng vẫn sớm 1 nhịp ở ca xám ("cứ giảm xong lại lên") — guard chặn gửi trùng nên
  không hại, chỉ mất đúng-thời-điểm.
- Câu hỏi ngoài grounding (suất ăn eat-clean) đôi lúc bot khẳng định "không có" thay vì xin SĐT
  xác nhận (classifier không bật cờ ngoài-phạm-vi).
- Tốc độ trên backend mới: **~20-24s/lượt** chạy tuần tự (2 call LLM: classifier ~12s + sinh
  reply ~8s; gemma4:12b chạy ~37 token/s trên GPU đó). Lượt phải sinh lại tốn thêm ~10s.

## Chạy lại test

```bash
cd /Users/khanhtoan/vinalink/vnlink-gemma4
npx -y tsx check.ts               # 75 kiểm tra thuần code, <1s, không tốn GPU — chạy TRƯỚC
npx -y tsx run.ts                 # liệt kê 16 id kịch bản
OUT_DIR=out-x npx -y tsx run.ts GIAICO GYM      # chạy vài luồng (mặc định tuần tự)
# smoke qua ĐÚNG đường prod (state + Sheets + ảnh Cloudinary thật) — endpoint/key lấy từ .env:
cd /Users/khanhtoan/vinalink/vnlink-ai-agent
STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeGemma.ts
# chat tay:
cd /Users/khanhtoan/vinalink/vnlink-ai-agent && npx -y tsx ../vnlink-gemma4/serve.ts
```

---

# Đợt 3 — bộ kịch bản LẠ + 12 lỗi vá theo

## Vì sao có đợt này
`scenarios.ts` đo bot có BÁN được không. Nó không chạm tới thứ khách Facebook thật gửi hằng
ngày: tin rác 1 ký tự, khách hỗn, khách dò prompt, khách hiểu nhầm giải cơ sang dịch vụ người
lớn, khách hỏi chữa bệnh, khách hỏi cho trẻ con, khách đổi ý liên tục, khách trộn 2 cơ sở.
→ thêm `vnlink-gemma4/oddcases.ts` (9 luồng, 38 lượt). `run.ts` nhận thêm `odd` và `moi`.

Tổng đã chạy và ĐỌC TAY: **488 lượt** (177 luồng bán + 38 luồng lạ + 273 lượt chạy lại xác minh).

## Lỗi tìm được và cách vá (#30–#41)

| # | Lỗi (ca bắt được) | Vá |
|---|---|---|
| 30 | **Bịa chi nhánh Hà Nội** — `TRON#3` ghép "Fami … tại Hà Nội", `#4` tự mâu thuẫn trong 1 tin | khối `RANH_GIOI` mới trong prompt (cả 2 nhánh): chỉ có cơ sở Vĩnh Phúc, CẤM ghép tên trung tâm với địa danh khách nêu |
| 31 | **Gộp 2 cơ sở thành một** — `DOIFLOW#8`, `TRON#2` | `RANH_GIOI`: Fami và Hoa Sen là 2 địa chỉ khác nhau, phải nói rõ từng bên |
| 32 | **SĐT thiếu số vẫn nhận** — `LUNGTUNG#3-4` nhận "098", "0912345" | `state.ts` đếm chữ số (9-12 mới nhận) + cờ `sdtThieuSo`; **và tin đó do CODE viết thẳng** (pipeline 3b) vì dặn bằng prompt không giữ được qua 3 vòng thử |
| 33 | **Luật soát bản nháp soi nhầm chuỗi** — `VANDAI#1` nháp 433 ký tự đủ giá, `cleanReply` cắt còn 193 mất sạch số, luật không thấy | `polish` chạy BÊN TRONG vòng soát; `DraftContext` tách `draft` (còn "?") và `final` (khách nhận). 24/177 lượt bị cắt, 15 lượt mất >150 ký tự |
| 34 | **Trẻ đi tập một mình** — `TREEM#4` đáp "bé hoàn toàn có thể đến tập một mình được" | `RANH_GIOI`: dưới 16 tuổi phải có người lớn bàn giao cho HLV; cấm tự chế mốc tuổi |
| 35 | **Không đặt ranh giới tin gợi dục** — `NHAYCAM#1-2` liệt kê bộ môn rồi "có HLV nữ kèm cặp cho anh" | `RANH_GIOI`: từ chối dứt khoát ngay câu đầu, cấm mô tả KTV theo ngoại hình |
| 36 | **Không bàn giao người thật** — `HON#4` "em vẫn đang trực tiếp nhắn tin" | trường classifier mới `khach_doi_nguoi_that` → chỉ thị theo LƯỢT đầu khối + câu mẫu (prompt-only thất bại 2 vòng) |
| 37 | **Bịa đồ cho mượn** — `GYM#18` "trung tâm có sẵn giày", `YOGA#16` "trang bị đầy đủ thảm tập" | mục CHỐNG BỊA nêu đích danh giày/thảm/khăn: trung tâm KHÔNG bán đồ tập nên không được hứa cho mượn |
| 38 | **Phí ô tô lúc có lúc không** (~50%) — `GYM#11` "bãi rộng, gửi ô tô thoải mái" | dòng gửi xe bắt buộc nói ĐỦ 2 VẾ |
| 39 | **Lặp gần nguyên văn lọt lưới** — `CAPTINH#3` chép lại `#2`, đo đúng ~0.75 | ngưỡng `isRepeatedReply` 0.75 → **0.66** (có test canh không bắt oan) |
| 40 | **Bỏ quên câu hỏi ngày** — `GIAICO#12`, `GIAMCAN#17` khách nói "qua thử" mà tin không hỏi ngày | luật mới `muon-den-thieu-cau-hoi`, tự nhường khi vướng an toàn |
| 41 | **Mất vế "hỏi ý bác sĩ"** — `YTE#4` tim mạch. **Nguyên nhân thật: prompt tự mâu thuẫn** — dòng "đã trấn an rồi thì lượt sau KHÔNG lặp lại" khiến bệnh MỚI bị coi là đã dặn | sửa dòng đó (tình trạng mới phải có cảnh báo riêng) + đưa khối an toàn lên ĐẦU + cho câu mẫu nguyên văn để chép |

Phụ: bảng ngày đánh dấu cả `← NGÀY MAI` (`LUNGTUNG#1` viết "ngày mai là thứ Năm 23/07" trong khi
23/07 là hôm nay) · HS/SV hỏi giá riêng 1 môn phải giải thích vì sao chỉ có thẻ FULL (`YOGA#10`) ·
classifier: HS/SV chỉ 14-22 tuổi TỰ đi tập (con nhỏ không tính), bạn bè ≠ gia đình, môn không có
thật thì không ghi vào slot, bệnh đã chẩn đoán (thoát vị/tim mạch/tiểu đường) đều là `benh-nen`.

## Bài học kiến trúc (quan trọng cho lần sau)
1. **Vị trí trong khối bối cảnh quyết định việc 12B có nghe hay không.** Luật nào hay bị bỏ thì
   đưa lên ĐẦU khối. Đã đúng với cặp ngày (đợt 2), an toàn và SĐT (đợt 3).
2. **Dặn trong system prompt (16k ký tự) gần như không ăn với 12B.** Muốn chắc thì phải thành
   chỉ thị THEO LƯỢT — cần cờ thì thêm trường classifier, đừng nhét thêm vào prompt nền.
3. **Chỗ nào chỉ có đúng MỘT câu trả lời đúng thì code viết, đừng giao cho model** (cặp ngày,
   tin báo SĐT thiếu số). Ý định khách vẫn do classifier quyết — code chỉ ráp câu.
4. **Luật soát phải soi chuỗi KHÁCH NHẬN, không phải bản nháp.** Hậu xử lý đứng sau có thể xoá
   đúng thứ luật vừa ép model viết ra.
5. Trước khi kết luận "model bướng", **đọc lại prompt xem mình có đang ra 2 lệnh ngược nhau không**
   (ca #41 mất 3 vòng thử mới nhận ra).

## Tốc độ (đo trên 488 lượt)
Trung vị **13,1s/lượt** khi GPU rảnh (p90 15,1s) · **18,0s** khi box có tải khác (p90 20,7s).
Chia ra: **classifier ~64% thời gian** (8,4s), sinh câu 4,8s. >20s: 13% · >25s: 1,2% · >30s: 1 lượt.
Lượt phải sinh lại +4-6s. Lượt do code viết: `gen 0.0s`.
→ Muốn nhanh thì **rút classifier** (bớt trường JSON / hạ `num_predict`), không phải rút prompt trả lời.

## Trạng thái
`check.ts` **116 test xanh**. Nhánh 5.4 KHÔNG bị đụng (`brain.ts`, `prompts.ts`, `cleanReply.ts`,
`replyGuards.ts` vẫn nguyên mốc 22/07). **CHƯA DEPLOY.**

## Hai điểm ĐÃ CHỐT (quyết định có chủ ý — đừng "sửa" nhầm ở đợt sau)
Chủ dự án xác nhận 24/07 rằng cả hai câu trả lời hiện tại là ĐÚNG ý muốn:
1. **Trẻ 13 tuổi tập gym** — bot xác nhận "được", giữ nguyên. (Grounding không ghi mốc tuổi gym;
   đây là chủ trương của trung tâm, không phải bot bịa.)
2. **Bot tự xưng là tư vấn viên/nhân viên của trung tâm** khi khách hỏi thẳng "là người hay bot" —
   giữ nguyên. Bản 5.4 đang live cũng vậy. Đây là quyết định sản phẩm, KHÔNG phải bug.
   (Phần bàn giao vẫn hoạt động: khách đòi gặp người thật → bot xin SĐT để gọi lại.)

Kèm theo, có sửa 1 chi tiết KHÔNG thuộc phạm vi 2 quyết định trên: khách nêu tuổi DƯỚI 14 không
còn bị gán nhóm `hoc-sinh-sinh-vien` (thẻ đó là 14-22 tuổi) — gán nhầm thì bot báo mức giá mà
người hỏi chưa đủ tuổi mua, lễ tân phải từ chối.

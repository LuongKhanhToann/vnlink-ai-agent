# Model & Tuning Constants

> File này lưu thông số quan trọng để tuning prompt/code. ĐỌC TRƯỚC khi sửa prompt hoặc thêm GATE.

## Model

> ⚠️ CẬP NHẬT 2026-06-08: đã đổi DEFAULT provider sang OpenAI (DeepSeek hết số dư). Xem `config/openai.ts`.

- **Reply (đang dùng)**: `gpt-5.4-mini` (OpenAI) — `REPLY_MODEL` default openai.
  - Chấp nhận `temperature 0.85` + `top_p 0.95`, ~1.4s/call, KHÔNG tốn reasoning tokens.
  - ⚠️ Gotcha gpt-5.x: bắt `max_completion_tokens` (không `max_tokens`). Code KHÔNG truyền `maxTokens` → không dính.
    **ĐỪNG thêm `maxTokens` vào modelSettings cho dòng gpt-5.**
- **Classifier / grader**: `gpt-4o-mini` (OpenAI) — `CLASSIFIER_MODEL` default openai.
- **Lùi về DeepSeek**: set `LLM_PROVIDER=deepseek` (cần đã nạp số dư — hiện balance âm, `is_available:false`).
- **Bảng "Models đã thử" bên dưới = lịch sử trên 4o-mini reply** (lỗi thời, giữ tham khảo). Số đo hiện tại đo trên `gpt-5.4-mini`.
- **Context window**: 128K tokens (input)
- **Output cap**: 16K tokens
- **TTL prompt cache**: 5 phút

### Models đã thử nghiệm (đừng thử lại)

| Model | Iter | Avg | Pass | Cost | Verdict |
|---|---|---|---|---|---|
| gpt-4o-mini (current) | 32 | **8.44** | **11/21** | 20đ/turn | ✅ best ratio |
| gpt-4.1-mini | 33 | 8.06 | 5/21 | ~50đ/turn | ❌ tệ hơn + 2.5x đắt |
| gpt-4o-mini | 39 | 7.84 (8.29 cũ / 7.05 mới) | 8/33 | 20đ/turn | ⚠️ scenarios mới rớt nặng — bugs real |
| gpt-4o-mini | 40 | 7.93 (8.30 cũ / 7.27 mới) | 9/33 | 20đ/turn | ✅ min +1.53 (4.33→5.86), key bug fix stateMachine + tactic |

### Models có thể thử trong tương lai (chưa test)

- **gpt-4o** (full): est avg 9.0+, cost ~335đ/turn (16x). Nên hybrid cho objection/closing.
- **Claude Haiku 4.5**: est avg ~8.8, cost ~50đ/turn. Cần đổi Anthropic SDK.

## Cost estimate (production)

- 20đ/turn × 3-5 turn/conv = ~65đ/conversation
- 100 conv/ngày → 200k đồng/tháng

## Soft limits cho quality (gpt-4o-mini)

| Component | Limit khuyến nghị | Hậu quả nếu vượt |
|---|---|---|
| Prefix per turn | < 1500 tokens | Bot drift, không follow rule cuối |
| System prompt agent | < 1000 tokens | Tốn share attention |
| Memory thread `lastMessages` | 20 (~1500-2000 tokens) | Bot mimic pattern cũ |
| Reply length | 200-280 ký tự VN (~100-130 tokens) | Judge phạt > 400 ký tự |
| **Tổng input/turn** | **< 4000 tokens** | Quality drop sharp |

## Cấm dùng

- ❌ `modelSettings.maxOutputTokens` < 280 — bot bị cut JSON wrapper → empty reply
- ❌ Forbid keyword list trong ANTI_LOOP — bot confused, không nhắc được khi cần
- ❌ Add GATE chồng chéo — gpt-4o-mini không thể prioritize → drift
- ❌ Hứa "em gửi hình" trong text mà không gọi tool

## Quy tắc thêm fix

1. **TACTIC ở đầu prefix > GATE ở giữa**: ưu tiên override TACTIC khi cần force behavior
2. **Mỗi iter 1 fix targeted**, không bulk
3. **Test sau mỗi fix**, nếu regression → revert ngay
4. **Deterministic check trước, prompt sau** (regex, length cap)
5. **Anti-loop**: snippet ngắn 80 chars + 1 dòng warn, KHÔNG forbid keyword
6. **EXAMPLE pricing chỉ inject ở evaluation** (không inbody/discovery)
7. **Reply pitch**: tối đa 1 gói anchor, KHÔNG list 3 dòng

## Iter best score (lịch sử)

| Iter | Avg | Min | Pass ≥9.0 | Notes |
|---|---|---|---|---|
| **17** | **8.47** | **6.67** | **9/21** | **BEST baseline** — F1-F6 |
| 16 | 8.44 | 6.25 | 9/21 | F1-F4 |
| 14 | 8.22 | 6.00 | 9/21 | TACTIC overrides |
| 18 | 8.25 | 6.33 | 8/21 | F7-F9 (bloat) |
| 19 | 8.08 | 6.25 | 7/21 | F10 (forbid words quá strict) |
| 6 | 8.24 | 5.00 | 7/21 | acute injury fix |
| 1 | 6.35 | 4.00 | 0/21 | baseline |
| 39 | 7.84 | **4.33** | 8/33 | +12 real-case scenarios (Messenger screenshot) + pricing sync PDF. 12 scenarios mới avg 7.05 — confirm bugs lặp service Q, không xin tên/SĐT khi chốt time |
| **40** | **7.93** | **5.86** | **9/33** | F12: stateMachine bypass serviceType khi preferredTime filled (key fix chot_time). F13: tactic discovery (c1/c2) recommend dứt khoát khi compare/indecisive/price-question. F14: detectPriceQuestion regex thêm "chi phí/báo giá". Min +1.53 |

## Stop condition (theo user)

- `min ≥ 8.0/10` trên cả 21 scenarios → DỪNG, deploy.

## Active fixes hiện tại (iter 17 baseline + iter 40 real-case)

- F1: Override TACTIC discovery khi `chỉ tập X`
- F2: Yoga tactic cấm InBody hoàn toàn
- F3: Scenario `fitness_ask_media` description rõ "T2 mới xin ảnh"
- F4: Evaluation EXAMPLE pitch 1 gói anchor (không 3)
- F5: Override TACTIC discovery cho PT need
- F6: GATE inbody-skip cấm InBody hoàn toàn cho yoga/bơi/zumba/pilates
- F11: GATE đổi giờ — buộc bot dùng giờ mới (giữ từ iter 19)
- F12: `fitnessReadyForEvaluation` bypass `serviceType` khi `preferredTime !== null` → discovery thẳng commitment (fix stuck loop hỏi service)
- F13: TACTIC discovery (c1) show pricing dứt khoát khi `detectPriceQuestion`; (c2) recommend dứt khoát khi `detectComparison || detectIndecisive`
- F14: `detectPriceQuestion` regex thêm "chi phí|báo giá|học phí|phí tập"

## Architecture summary

```
prefix (≤ 1500 tokens)
├── [HON] [STAGE] [INTENT] [FLOW]      — 1 dòng meta
├── [TACTIC]                           — playbook + override theo state
├── [RULES]                            — gộp blacklist, length cap
├── [PREV]                             — anti-loop snippet (NO forbid keyword)
├── [KNOWN]                            — slots đã có
├── [SLOTS_MISSING]                    — slot cần hỏi
├── [KNOWLEDGE]                        — pricing/objections (skip nếu prev đã pitch)
├── [MEDIA]                            — hint mềm tự quyết
├── [GATE...]                          — multiple GATEs (ưu tiên những gì user chủ động)
└── [EXAMPLE]                          — chỉ ở stages có template
```

## Token measurement (sample iter 17)

| State | chars | tokens (~/3.5) |
|---|---|---|
| opening | 878 | 251 |
| discovery | 1481 | 423 |
| inbody | 1918 | 548 |
| evaluation | 3807 | 1088 |

Avg: ~580 tokens/turn (Phase A trim done).

## Khi cần debug

1. Đo prefix length: `npx tsx measure-prefix.mjs` (script trong README)
2. Run scenarios: `npm run test:scenarios`
3. Check JSON: `test-results/run-*.json` → field `score.turn_scores`

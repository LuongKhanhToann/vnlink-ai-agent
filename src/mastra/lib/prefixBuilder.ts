/**
 * prefixBuilder.ts
 *
 * Build prefix inject vào agent message.
 * Tất cả giá trị đến từ deterministic state.
 *
 * NGUYÊN TẮC:
 *   - Fitness discovery: giữ ở discovery cho đến khi có fitnessGoal (hoặc intent >= compare)
 *   - Evaluation: few-shot luôn build value TRƯỚC khi show giá
 *   - Xưng hô: lấy từ state.honorific, đã được detectHonorific cập nhật đúng turn
 */

import {
  ConversationState,
  resolveHonorific,
  KnownInfo,
  Intent,
  Flow,
  Stage,
} from "./stateMachine";
import { getTactic } from "./playbook";

// ─────────────────────────────────────────────
// DIGRESSION CLASSIFIER
// ─────────────────────────────────────────────

function canAnswerWithoutCoreSlot(intent: Intent, flow: Flow, stage: Stage): boolean {
  if (intent === "compare") return true;
  if (stage === "opening") return true;
  return false;
}

// ─────────────────────────────────────────────
// LOGIC GATES
// ─────────────────────────────────────────────

export function buildLogicGate(state: ConversationState): string {
  const { stage, intent, flow, knownInfo } = state;
  const hints: string[] = [];

  // ── FITNESS: chưa biết dịch vụ ──
  if (flow === "fitness" && stage === "discovery" && knownInfo.serviceType === null) {
    if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết serviceType — ANSWER FIRST: trả lời câu hỏi khách trước, " +
        "lồng hỏi 'anh/chị quan tâm dịch vụ nào / mục tiêu gì' vào CUỐI response]"
      );
    } else {
      hints.push(
        "[GATE: chưa biết serviceType — COLLECT FIRST: hỏi dịch vụ quan tâm trước]"
      );
    }
  }

  // ── FITNESS: biết dịch vụ nhưng chưa biết mục tiêu ──
  // Gate mới: giữ khách ở discovery thêm 1 câu hỏi về mục tiêu
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal === null &&
    intent === "explore"
  ) {
    hints.push(
      `[GATE: biết dịch_vụ=${knownInfo.serviceType} nhưng chưa biết mục tiêu (fitnessGoal). ` +
      "KHÔNG báo giá. Hỏi mục tiêu tập: 'để giảm mỡ, tăng cơ, thư giãn hay mục tiêu khác ạ' " +
      "Trước khi hỏi, nhấn 1 điểm nổi bật của dịch vụ đó để giữ interest.]"
    );
  }

  // ── FITNESS: evaluation — nhắc build value trước ──
  if (flow === "fitness" && stage === "evaluation") {
    const goalCtx = knownInfo.fitnessGoal ? `mục_tiêu=${knownInfo.fitnessGoal}` : "chưa có mục tiêu";
    const svcCtx  = knownInfo.serviceType ? `dịch_vụ=${knownInfo.serviceType}` : "";
    hints.push(
      `[GATE: evaluation — ${svcCtx} ${goalCtx}. ` +
      "BẮT BUỘC: nhấn điểm khác biệt của dịch vụ phù hợp mục tiêu TRƯỚC, " +
      "SAU ĐÓ mới gợi tối đa 3 gói có narrative. KHÔNG liệt kê giá thẳng.]"
    );
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (flow === "giai-co" && stage === "discovery" && knownInfo.painArea === null) {
    if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết painArea — ANSWER FIRST: trả lời câu hỏi khách trước, " +
        "lồng hỏi về vùng đang đau/mỏi vào CUỐI response một cách tự nhiên]"
      );
    } else {
      hints.push(
        "[GATE: chưa biết painArea — COLLECT FIRST: hỏi anh/chị đang đau/mỏi vùng nào trước]"
      );
    }
  }

  // ── GIẢI CƠ: đã biết vùng đau, đang evaluation ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null
  ) {
    const durationCtx = knownInfo.painDuration
      ? `đau ${knownInfo.painDuration}`
      : "chưa biết thời gian đau";
    hints.push(
      `[GATE: evaluation — vùng_đau=${knownInfo.painArea}, ${durationCtx}. ` +
      "BẮT BUỘC: dùng hình ảnh hóa phù hợp vùng đó TRƯỚC, " +
      "giải thích tại sao massage không đủ, SAU ĐÓ mới gợi gói. " +
      "Nếu đau lâu (> 1 tuần) → ưu tiên gợi gói 10 buổi.]"
    );
  }

  // ── COMMITMENT: chốt đơn ──
  if (stage === "commitment") {
    const { name, phone } = knownInfo;
    const qrShown = (state as any).qrShown ?? false;

    if (!name || !phone) {
      hints.push(
        "[GATE: BƯỚC 1 — chưa có tên/SĐT. " +
        "Hỏi GỘP: 'Cho em xin tên và SĐT để xác nhận nha' " +
        "KHÔNG gửi QR trước khi có tên/SĐT.]"
      );
    } else if (!qrShown) {
      hints.push(
        "[GATE: BƯỚC 2 — đã có tên/SĐT, chưa gửi QR. " +
        "Gọi tool get-qr để lấy mã QR thanh toán. " +
        "Tóm tắt đơn + gửi QR + soft close.]"
      );
    } else {
      hints.push(
        "[GATE: BƯỚC 3 — đã gửi QR. Xác nhận và hướng dẫn bước tiếp theo.]"
      );
    }
  }

  return hints.join("\n");
}

// ─────────────────────────────────────────────
// FEW-SHOT EXAMPLES
// ─────────────────────────────────────────────

function buildFewShot(state: ConversationState, h: string): string | null {
  const { stage, intent, flow, knownInfo } = state;

  // ── FITNESS: hỏi dịch vụ/giá chung khi chưa biết loại ──
  if (flow === "fitness" && intent === "compare" && knownInfo.serviceType === null) {
    return `[EXAMPLE — ANSWER FIRST + BUILD INTEREST]
Khách: "bên mình có gói gì / giá bao nhiêu"
Em: "Fami có 4 dịch vụ chính ${h}, điểm đặc biệt là dùng chung 1 thẻ:
     Bơi — bể 4 mùa duy nhất Vĩnh Yên, nước nóng quanh năm
     Gym — 700m2 trong nhà + sân ngoài, chứa 100 người cùng lúc
     Yoga & Zumba — GV người Ấn Độ chuyên nghiệp, 4 ca/ngày
     Pilates — 13 máy chuẩn quốc tế (mới mở 12/2024)
     Thẻ Full cả 4 dịch vụ từ 1.2tr/tháng ${h}.
     ${h} đang muốn tập để đạt mục tiêu gì để em gợi gói chuẩn nha"`;
  }

  // ── FITNESS: biết dịch vụ + mục tiêu, đang discovery → xác nhận + hỏi schedule ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal !== null &&
    knownInfo.schedule === null
  ) {
    const svc  = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal;
    return `[EXAMPLE — TIN ĐẦU: XÁC NHẬN NGẮN + HỎI SCHEDULE, KHÔNG GIỚI THIỆU, KHÔNG GIÁ]
Khách: "mình muốn tập ${svc} ${goal}"
Em (ĐÚNG): "${h} tập mấy buổi một tuần?"
Em (ĐÚNG): "${h} hay tập sáng hay chiều tối hơn?"
Em (SAI — khen giả): "Dạ, tập Gym để giảm mỡ là hợp lý rồi đó anh/chị..."
Em (SAI — khen giả): "Tuyệt vời! Buổi sáng là thời điểm lý tưởng..."
Em (SAI — giới thiệu): "Gym bên em rộng lắm... có cả trong nhà và ngoài trời..."
Em (SAI — list gói): "Có mấy gói phù hợp: Gói 12 tháng 7tr..."
⚠️ Chỉ: 1 câu tự nhiên dẫn vào câu hỏi context. Không khen. Không giới thiệu. Không báo giá.`;
  }

  // ── FITNESS: biết dịch vụ, chưa có mục tiêu, đang discovery → hỏi mục tiêu ──
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType !== null &&
    knownInfo.fitnessGoal === null
  ) {
    const svc = knownInfo.serviceType;
    const highlights: Record<string, string> = {
      boi:     `Bể bơi bên em là bể 4 mùa duy nhất tại Vĩnh Yên ${h} — nước nóng quanh năm, lọc ozone, có đội cứu hộ.`,
      yoga:    `Yoga bên em có GV người Ấn Độ chuyên nghiệp ${h} — 4 ca/ngày nên rất linh hoạt lịch tập.`,
      zumba:   `Zumba bên em do GV người Ấn Độ dạy ${h} — 4 ca/ngày, lớp vui và năng động lắm.`,
      gym:     `Phòng gym bên em rộng 700m2 trong nhà + 300m2 sân ngoài có mái che ${h} — chứa 100 người mà không chật.`,
      pilates: `Pilates bên em có 13 máy chuẩn quốc tế ${h} — GV chứng chỉ quốc tế, mới khai trương 12/2024.`,
      full:    `Thẻ Full cho ${h} dùng cả 4 dịch vụ: Gym, Bơi, Yoga và Zumba — từ 1.2tr/tháng.`,
    };
    const highlight = highlights[svc] ?? `Dịch vụ ${svc} bên em rất được hội viên yêu thích ${h}.`;
    return `[EXAMPLE — BUILD INTEREST + HỎI MỤC TIÊU, KHÔNG BÁO GIÁ GÓI]
Khách: "muốn đăng ký ${svc}" / "cho hỏi lớp ${svc}"
Em: "${highlight}
     ${h} muốn tập để giảm mỡ, tăng cơ hay thư giãn phục hồi — để em gợi đúng hướng nha"
⚠️ KHÔNG liệt kê gói hoặc báo giá ở bước này.`;
  }

  // ── FITNESS: đang evaluation → show gói có narrative ──
  if (flow === "fitness" && stage === "evaluation" && knownInfo.serviceType !== null) {
    const svc  = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal ?? "sức khỏe tổng thể";
    return `[EXAMPLE_STRUCTURE — BUILD VALUE RỒI MỚI GIÁ]
Khách: muốn tập ${svc} để ${goal}
Em: "[Nhấn 1-2 điểm khác biệt cụ thể của ${svc} phù hợp với ${goal}]
     [Kết nối: 'Với mục tiêu ${goal} của ${h}, [điểm đó] sẽ giúp...']

     Có mấy hướng phù hợp với ${h}:
     [GÓI DÀI HẠN — best value]: [giá] — [lợi ích cụ thể cho mục tiêu ${goal}]
     [GÓI PHỔ BIẾN]: [giá] — [mô tả ngắn]
     [GÓI THỬ/NGẮN]: [giá] — để ${h} cảm nhận trước

     Hội viên mục tiêu ${goal} thường chọn [GÓI PHỔ BIẾN] nhất ${h}.
     ${h} hay tập buổi sáng hay chiều để em gợi lịch phù hợp nha"
⚠️ GIÁ PHẢI ĐÚNG THEO BẢNG GIÁ TRONG INSTRUCTIONS.
⚠️ KHÔNG liệt kê khô — mỗi gói phải có 1 câu lý do phù hợp mục tiêu.`;
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (flow === "giai-co" && stage === "discovery" && knownInfo.painArea === null) {
    return `[EXAMPLE — ANSWER FIRST + DẪN DẮT TÂM LÝ]
Khách: "giải cơ là gì / giá bao nhiêu"
Em: "Giải cơ chuyên sâu khác massage thông thường ${h} —
     không phải vuốt bề mặt mà tháo từng nút thắt bên trong cơ (Trigger Points),
     nên hiệu quả bền hơn thay vì thư giãn tạm thời.
     Giá từ 200k (45 phút, 1-2 vùng) đến 590k (CS-VIP 2 kèm tắm thuốc + xông).
     ${h} đang cảm thấy đau mỏi vùng nào nhiều nhất để em tư vấn đúng gói nha"`;
  }

  // ── GIẢI CƠ: biết vùng đau + duration ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null &&
    knownInfo.painDuration !== null
  ) {
    return `[EXAMPLE — BUILD VALUE: HÌNH ẢNH HÓA TRƯỚC, GIÁ SAU]
Khách: đau ${knownInfo.painArea} đã ${knownInfo.painDuration}, đã thử massage rồi
Em: "Đúng rồi ${h} — massage bề mặt chỉ 'đánh lừa' cảm giác nhất thời.
     Đau ${knownInfo.painArea} lâu như vậy thường là nút thắt đã xơ hóa —
     giống sợi guitar căng quá, vuốt bên ngoài không gỡ được gốc.
     Bên em tác động vào lớp cơ sâu nhất để xử lý tận nơi.

     Với tình trạng của ${h}, em gợi:
     CS-VIP 2 × 10 buổi (3.8tr, tặng 1 buổi) — kèm tắm thuốc + xông, phục hồi toàn diện
     CS-VIP 1 × 10 buổi (4.2tr, tặng 1 buổi) — tập trung sâu nhất vùng ${knownInfo.painArea}
     Thử 1 buổi CS-VIP 2 (590k) — để ${h} tự cảm nhận hiệu quả trước

     ${h} hay có mặt khung giờ sáng hay chiều để em giữ slot nha"`;
  }

  // ── GIẢI CƠ: biết vùng đau, chưa biết duration ──
  if (flow === "giai-co" && stage === "evaluation" && knownInfo.painArea !== null) {
    return `[EXAMPLE_STRUCTURE — BUILD VALUE THEO VÙNG ĐAU]
Khách: đau ở ${knownInfo.painArea}
Em: "[Dùng hình ảnh hóa: cầu dao / cuộn len / dòng sông]
     [Giải thích tại sao massage không đủ với vùng ${knownInfo.painArea}]

     Với vùng ${knownInfo.painArea} thì bên em có:
     CS-VIP 2 (590k lẻ / 3.8tr × 10 buổi) — tắm thuốc + xông + giải cơ 75 phút
     Cơ bản 2 (380k lẻ) — ngâm bồn + xông + giải cơ chuẩn
     Giải cơ 75 phút (330k) — tập trung đúng vùng ${knownInfo.painArea}

     ${h} muốn thử 1 buổi trước hay em tư vấn lộ trình tiết kiệm hơn nha"`;
  }

  return null;
}

// ─────────────────────────────────────────────
// KNOWN INFO SUMMARY
// ─────────────────────────────────────────────

function buildKnownSummary(info: KnownInfo, flow: Flow): string {
  const parts: string[] = [];

  if (info.name !== null)  parts.push(`tên=${info.name}`);
  if (info.phone !== null) parts.push(`sđt=${info.phone}`);

  if (flow === "fitness") {
    if (info.serviceType !== null)    parts.push(`dịch-vụ=${info.serviceType}`);
    if (info.fitnessGoal !== null)    parts.push(`mục-tiêu=${info.fitnessGoal}`);
    if (info.memberType !== null)     parts.push(`loại-thành-viên=${info.memberType}`);
    if (info.durationMonths !== null) parts.push(`thời-hạn=${info.durationMonths}tháng`);
    if (info.schedule !== null)       parts.push(`lịch=${info.schedule}`);
  } else {
    if (info.painArea !== null)       parts.push(`vùng-đau=${info.painArea}`);
    if (info.painDuration !== null)   parts.push(`đau-bao-lâu=${info.painDuration}`);
    if (info.sessionPackage !== null) parts.push(`gói=${info.sessionPackage}`);
    if (info.preferredTime !== null)  parts.push(`giờ-muốn=${info.preferredTime}`);
  }

  return parts.length > 0 ? `[KNOWN: ${parts.join(", ")}]` : "";
}

// ─────────────────────────────────────────────
// MISSING SLOTS HINT
// ─────────────────────────────────────────────

function buildMissingSlotHint(
  info: KnownInfo,
  flow: Flow,
  intent: Intent,
  stage: Stage
): string {
  const missing: string[] = [];

  if (flow === "fitness") {
    if (info.serviceType === null) missing.push("serviceType");
    // fitnessGoal chỉ bắt buộc ở discovery khi intent=explore
    if (info.fitnessGoal === null && stage === "discovery" && intent === "explore") {
      missing.push("fitnessGoal");
    }
    if (info.durationMonths === null && stage === "commitment") missing.push("durationMonths");
  } else {
    if (info.painArea === null) missing.push("painArea");
    if (info.painDuration === null && stage === "evaluation") missing.push("painDuration");
    if (info.sessionPackage === null && stage === "commitment") missing.push("sessionPackage");
  }

  if (missing.length === 0) return "[SLOTS: đủ thông tin cần thiết]";

  if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
    return `[SLOTS_MISSING: ${missing.join(", ")} — ANSWER câu hỏi khách TRƯỚC, hỏi slot SAU ở cuối response]`;
  }

  return `[SLOTS_MISSING: ${missing.join(", ")} — hỏi 1 slot quan trọng nhất TRƯỚC]`;
}

// ─────────────────────────────────────────────
// MAIN PREFIX BUILDER
// ─────────────────────────────────────────────

export function buildPrefix(state: ConversationState): string {
  const h = resolveHonorific(state.honorific);
  const tactic = getTactic(state.flow, state.stage, state.emotion);

  const lines: string[] = [
    `[HONORIFIC: ${h}] [TEMP: ${state.temperature}] [STAGE: ${state.stage}] [EMOTION: ${state.emotion}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
    `[TACTIC: ${tactic}]`,
    buildKnownSummary(state.knownInfo, state.flow),
    buildMissingSlotHint(state.knownInfo, state.flow, state.intent, state.stage),
    buildLogicGate(state),
    buildFewShot(state, h) ?? "",
  ];

  return lines.filter(Boolean).join("\n");
}
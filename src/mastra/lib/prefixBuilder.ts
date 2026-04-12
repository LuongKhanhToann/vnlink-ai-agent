/**
 * prefixBuilder.ts
 *
 * Build prefix inject vào agent message.
 * Tất cả giá trị đến từ deterministic state.
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

  // ── GIẢI CƠ: đã biết vùng đau, đang evaluation — gợi chẩn đoán ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null &&
    knownInfo.painDuration !== null
  ) {
    hints.push(
      `[GATE: đã biết vùng đau=${knownInfo.painArea}, đau ${knownInfo.painDuration} ` +
      "— dùng hình ảnh hóa phù hợp, gợi gói theo mức độ mạn tính]"
    );
  }

  // ── COMMITMENT: chốt đơn ──
  if (stage === "commitment") {
    const { name, phone } = knownInfo;
    const qrShown = (state as any).qrShown ?? false;

    if (!name || !phone) {
      hints.push(
        "[GATE: BƯỚC 1 — chưa có tên/SĐT. " +
        "Hỏi GỘP: 'Cho em xin tên và SĐT để xác nhận nha?' " +
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

  // FITNESS: hỏi giá/dịch vụ khi chưa biết loại
  if (flow === "fitness" && intent === "compare" && knownInfo.serviceType === null) {
    return `[EXAMPLE — ANSWER FIRST]
Khách: "bên mình có gói gì / giá bao nhiêu"
Em: "Fami có 4 dịch vụ chính ${h}:
     • Gym — 700m2 trong nhà + sân ngoài trời
     • Yoga & Zumba — GV người Ấn Độ, 4 ca/ngày
     • Bơi — bể 4 mùa, duy nhất Vĩnh Yên
     • Pilates — máy hiện đại, GV chuẩn quốc tế
     Thẻ Full cả 4 dịch vụ chỉ từ 1.2tr/tháng ${h}.
     ${h} đang quan tâm dịch vụ nào nhất để em tư vấn gói cụ thể nha?"`;
  }

  // FITNESS: biết dịch vụ → gợi gói
  if (flow === "fitness" && stage === "evaluation" && knownInfo.serviceType !== null) {
    return `[EXAMPLE_STRUCTURE — HỌC GIỌNG VÀ FORMAT]
Khách: muốn tập ${knownInfo.serviceType}
Em: "Với ${knownInfo.serviceType} thì có mấy hướng ${h}:
     • [GÓI DÀI — best value] — [giá] — [lợi ích nổi bật]
     • [GÓI VỪA — phổ biến nhất] — [giá] — [mô tả]
     • [GÓI THỬ — ngắn hạn] — [giá] — dùng để cảm nhận trước
     Hội viên hay chọn gói [BEST] nhất ${h}.
     ${h} hay tập [số buổi/tuần] để em gợi size chuẩn nha?"
⚠️ GIÁ PHẢI ĐÚNG THEO BẢNG GIÁ TRONG INSTRUCTIONS.`;
  }

  // GIẢI CƠ: khách hỏi giá/giải cơ là gì, chưa biết vùng đau
  if (flow === "giai-co" && stage === "discovery" && knownInfo.painArea === null) {
    return `[EXAMPLE — ANSWER FIRST + DẪN DẮT TÂM LÝ]
Khách: "giải cơ là gì / giá bao nhiêu"
Em: "Giải cơ chuyên sâu khác massage thông thường ${h} —
     không phải vuốt bề mặt mà tháo từng nút thắt bên trong cơ (Trigger Points),
     nên hiệu quả bền vững hơn thay vì chỉ thư giãn tạm.
     Giá từ 200k (45 phút) đến 380k (Cơ bản 2 kèm xông hơi + ngâm bồn).
     ${h} đang cảm thấy đau mỏi vùng nào để em tư vấn đúng gói nha?"`;
  }

  // GIẢI CƠ: đã thử massage không hiệu quả → chốt sự khác biệt
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null &&
    knownInfo.painDuration !== null
  ) {
    return `[EXAMPLE — CHỐT SỰ KHÁC BIỆT]
Khách: đau ${knownInfo.painArea} đã ${knownInfo.painDuration}, đã thử massage rồi
Em: "Đúng rồi ${h} — massage bề mặt chỉ 'đánh lừa' cảm giác nhất thời.
     Đau ${knownInfo.painArea} lâu như vậy thường là các nút thắt đã xơ hóa —
     giống như sợi guitar căng quá, vuốt bên ngoài không gỡ được gốc.
     Bên em tác động vào lớp cơ sâu nhất để xử lý tận nơi.
     ${h} thử 1 buổi 75 phút — hầu hết khách nhẹ 50-70% ngay buổi đầu.
     Em giữ slot cho ${h} vào khung giờ nào tiện nha?"`;
  }

  // GIẢI CƠ: biết vùng đau, chưa biết mức độ
  if (flow === "giai-co" && stage === "evaluation" && knownInfo.painArea !== null) {
    return `[EXAMPLE_STRUCTURE — HỌC GIỌNG VÀ FORMAT]
Khách: đau ở ${knownInfo.painArea}
Em: "Vùng ${knownInfo.painArea} thì bên em gặp nhiều lắm ${h}.
     Mấy gói phù hợp:
     • Giải cơ CS-VIP 2 (380k) — kèm tắm thuốc + xông hơi, tác động sâu nhất
     • Cơ bản 2 (380k) — thêm ngâm bồn + xông, thư giãn toàn diện
     • Giải cơ 75 phút (330k) — tập trung đúng vùng ${knownInfo.painArea}
     Muốn kết quả bền vững thì gói 10 buổi tiết kiệm hơn ${h} —
     tặng thêm 1 buổi, đủ để cơ tái cấu trúc hoàn toàn.
     ${h} muốn thử 1 buổi trước hay đăng ký gói tiết kiệm luôn nha?"`;
  }

  return null;
}

// ─────────────────────────────────────────────
// KNOWN INFO SUMMARY
// ─────────────────────────────────────────────

function buildKnownSummary(info: KnownInfo, flow: Flow): string {
  const parts: string[] = [];

  if (info.name !== null) parts.push(`tên=${info.name}`);
  if (info.phone !== null) parts.push(`sđt=${info.phone}`);

  if (flow === "fitness") {
    if (info.serviceType !== null)    parts.push(`dịch-vụ=${info.serviceType}`);
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
  // getTactic giờ nhận flow để lookup đúng playbook
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
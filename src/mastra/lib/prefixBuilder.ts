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

function canAnswerWithoutCoreSlot(
  intent: Intent,
  flow: Flow,
  stage: Stage,
): boolean {
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
  if (
    flow === "fitness" &&
    stage === "discovery" &&
    knownInfo.serviceType === null
  ) {
    if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết serviceType — ANSWER FIRST: trả lời câu hỏi khách trước, " +
          "lồng hỏi 'anh/chị quan tâm dịch vụ nào / mục tiêu gì' vào CUỐI response]",
      );
    } else {
      hints.push(
        "[GATE: chưa biết serviceType — COLLECT FIRST: hỏi dịch vụ quan tâm trước]",
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
        "Trước khi hỏi, nhấn 1 điểm nổi bật của dịch vụ đó để giữ interest.]",
    );
  }

  // ── FITNESS: inbody pitch — cấm show giá ──
  if (flow === "fitness" && stage === "inbody") {
    const goalCtx = knownInfo.fitnessGoal
      ? `mục_tiêu=${knownInfo.fitnessGoal}`
      : "chưa có mục tiêu";
    const scheduleCtx = knownInfo.schedule
      ? `lịch=${knownInfo.schedule}`
      : "chưa rõ lịch";
    hints.push(
      `[GATE: inbody — ${goalCtx}, ${scheduleCtx}. ` +
        "BẮT BUỘC: (1) xác nhận lịch tập 1 câu → (2) pitch Inbody miễn phí → (3) câu mời nhẹ. " +
        "TUYỆT ĐỐI KHÔNG show gói/giá ở bước này — Inbody phải xảy ra trước evaluation.]",
    );
  }

  // ── FITNESS: evaluation — nhắc build value trước ──
  if (flow === "fitness" && stage === "evaluation") {
    const goalCtx = knownInfo.fitnessGoal
      ? `mục_tiêu=${knownInfo.fitnessGoal}`
      : "chưa có mục tiêu";
    const svcCtx = knownInfo.serviceType
      ? `dịch_vụ=${knownInfo.serviceType}`
      : "";
    hints.push(
      `[GATE: evaluation — ${svcCtx} ${goalCtx}. ` +
        "BẮT BUỘC: nhấn điểm khác biệt của dịch vụ phù hợp mục tiêu TRƯỚC, " +
        "SAU ĐÓ mới gợi tối đa 3 gói có narrative. KHÔNG liệt kê giá thẳng.]",
    );
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea === null
  ) {
    if (canAnswerWithoutCoreSlot(intent, flow, stage)) {
      hints.push(
        "[GATE: chưa biết painArea — ANSWER FIRST: trả lời câu hỏi khách trước, " +
          "lồng hỏi về vùng đang đau/mỏi vào CUỐI response một cách tự nhiên]",
      );
    } else {
      hints.push(
        "[GATE: chưa biết painArea — COLLECT FIRST: hỏi anh/chị đang đau/mỏi vùng nào trước]",
      );
    }
  }

  // ── GIẢI CƠ: biết painArea nhưng chưa hỏi painSpread ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea !== null &&
    knownInfo.painSpread === null
  ) {
    hints.push(
      `[GATE: biết vùng_đau=${knownInfo.painArea} nhưng chưa biết tính chất lan tỏa. ` +
        "BẮT BUỘC hỏi BƯỚC 2: 'đau lan ra xung quanh hay đau một điểm cố định thôi ạ?' " +
        "Đây là bước TRƯỚC khi hỏi pastMethod. KHÔNG hỏi pastMethod trước khi có painSpread.]",
    );
  }

  // ── GIẢI CƠ: biết painArea + painSpread, chưa hỏi pastMethod ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea !== null &&
    knownInfo.painSpread !== null &&
    knownInfo.pastMethod === null
  ) {
    hints.push(
      `[GATE: biết vùng_đau=${knownInfo.painArea}, lan_toa=${knownInfo.painSpread} nhưng chưa có pastMethod. ` +
        "BẮT BUỘC hỏi BƯỚC 3: 'Trước giờ anh/chị có đi massage hay dùng thuốc chưa — đỡ được lâu không?' " +
        "pastMethod là bước tạo contrast quan trọng nhất trước khi tư vấn. KHÔNG báo giá khi chưa có pastMethod.]",
    );
  }

  // ── GIẢI CƠ: đã biết vùng đau + pastMethod, đang evaluation ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null
  ) {
    const durationCtx = knownInfo.painDuration
      ? `đau ${knownInfo.painDuration}`
      : "chưa biết thời gian đau";
    const methodCtx = knownInfo.pastMethod
      ? `đã_thử=${knownInfo.pastMethod}`
      : "chưa có pastMethod";

    // Map painArea → media key để chỉ agent gọi đúng key
    const pain = knownInfo.painArea.toLowerCase();
    let mediaKey = "mr-general";
    if (
      pain.includes("vai") ||
      pain.includes("gay") ||
      pain.includes("co") ||
      pain.includes("gay")
    ) {
      mediaKey = "mr-neck-shoulder";
    } else if (pain.includes("lung") || pain.includes("lưng")) {
      mediaKey = "mr-general";
    } else if (
      pain.includes("chan") ||
      pain.includes("chân") ||
      pain.includes("goi") ||
      pain.includes("gối")
    ) {
      mediaKey = "mr-sport";
    }

    hints.push(
      `[GATE: evaluation — vùng_đau=${knownInfo.painArea}, ${durationCtx}, ${methodCtx}. ` +
        `BƯỚC 0 (BẮT BUỘC): gọi tool get-media với key="${mediaKey}" TRƯỚC KHI viết response — ` +
        "đưa URLs vào output mediaUrls để Facebook gửi kèm. " +
        "BẮT BUỘC tiếp theo: (1) hình ảnh hóa vùng đó → (2) contrast với pastMethod đã biết → (3) vẽ viễn cảnh sau khi gỡ → " +
        "(4) CHỈ mời 1 buổi thử + chốt lịch. KHÔNG show bảng gói 3 dòng ngay lần đầu.]",
    );
  }

  // ── COMMITMENT: chốt đơn ──
  if (stage === "commitment") {
    const { name, phone } = knownInfo;
    const qrShown = (state as any).qrShown ?? false;

    if (!name || !phone) {
      const timeCtx = knownInfo.preferredTime
        ? `khách muốn ${knownInfo.preferredTime}`
        : "chưa biết giờ";
      hints.push(
        `[GATE: CHƯA CÓ TÊN/SĐT (${timeCtx}) — tin này CHỈ được phép hỏi tên và SĐT. ` +
          "Nếu đã biết giờ → xác nhận giờ 1 câu rồi hỏi ngay tên/SĐT. " +
          "TUYỆT ĐỐI KHÔNG: xác nhận slot, soft-close, hỏi 'cần thêm thông tin gì không', " +
          "dùng nextStep='close' khi chưa có tên/SĐT.]",
      );
    } else if (!knownInfo.preferredTime) {
      hints.push(
        "[GATE: đã có tên/SĐT, chưa có giờ cụ thể. Hỏi khung giờ + gợi cọc nhẹ nếu slot đẹp.]",
      );
    } else if (!qrShown) {
      hints.push(
        "[GATE: đủ info. Gợi cọc nhẹ — nếu khách đồng ý thì gọi get-qr, không thì xác nhận lịch thường.]",
      );
    } else {
      hints.push(
        "[GATE: BƯỚC 3 — đã gửi QR. Xác nhận và hướng dẫn bước tiếp theo.]",
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
  if (
    flow === "fitness" &&
    intent === "compare" &&
    knownInfo.serviceType === null
  ) {
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
    const svc = knownInfo.serviceType;
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
      boi: `Bể bơi bên em là bể 4 mùa duy nhất tại Vĩnh Yên ${h} — nước nóng quanh năm, lọc ozone, có đội cứu hộ.`,
      yoga: `Yoga bên em có GV người Ấn Độ chuyên nghiệp ${h} — 4 ca/ngày nên rất linh hoạt lịch tập.`,
      zumba: `Zumba bên em do GV người Ấn Độ dạy ${h} — 4 ca/ngày, lớp vui và năng động lắm.`,
      gym: `Phòng gym bên em rộng 700m2 trong nhà + 300m2 sân ngoài có mái che ${h} — chứa 100 người mà không chật.`,
      pilates: `Pilates bên em có 13 máy chuẩn quốc tế ${h} — GV chứng chỉ quốc tế, mới khai trương 12/2024.`,
      full: `Thẻ Full cho ${h} dùng cả 4 dịch vụ: Gym, Bơi, Yoga và Zumba — từ 1.2tr/tháng.`,
    };
    const highlight =
      highlights[svc] ??
      `Dịch vụ ${svc} bên em rất được hội viên yêu thích ${h}.`;
    return `[EXAMPLE — BUILD INTEREST + HỎI MỤC TIÊU, KHÔNG BÁO GIÁ GÓI]
Khách: "muốn đăng ký ${svc}" / "cho hỏi lớp ${svc}"
Em: "${highlight}
     ${h} muốn tập để giảm mỡ, tăng cơ hay thư giãn phục hồi — để em gợi đúng hướng nha"
⚠️ KHÔNG liệt kê gói hoặc báo giá ở bước này.`;
  }

  // ── FITNESS: inbody pitch — few-shot ──
  if (flow === "fitness" && stage === "inbody") {
    const goal = knownInfo.fitnessGoal ?? "mục tiêu";
    const schedule = knownInfo.schedule ?? "lịch tập";
    return `[EXAMPLE — INBODY PITCH: XÁC NHẬN LỊCH + MỜI ĐO, TUYỆT ĐỐI KHÔNG GIÁ/GÓI]
⚠️ TEXT THUẦN TÚY — không dùng **bold**, không bullet "-"
⚠️ 1 message = 1 bước: CHỈ xác nhận lịch + pitch Inbody + câu mời. KHÔNG làm gì thêm.

SAI (nhảy sang gói ngay):
"Với lịch ${schedule}, ${h} có thể chọn: Full 12 tháng 7tr / Full 6 tháng 4.5tr..."

ĐÚNG (inbody trước):
"3 buổi/tuần là hợp lý để ${goal} rồi ${h}.
Bên em có đo Inbody miễn phí lần đầu — HLV phân tích tỷ lệ mỡ/cơ và tư vấn lộ trình đúng luôn, không đoán mò.
${h} qua thử 1 buổi trước cho dễ chọn gói nha?"

Hoặc:
"Tối ${schedule ? schedule.replace("toi", "").trim() || "mấy buổi/tuần" : "3 buổi/tuần"} thì bên em có khung giờ thoải mái ${h}.
Trước khi chọn gói, bên em đo Inbody miễn phí lần đầu — biết được % mỡ và cơ thực tế để HLV lên lịch tập chuẩn hơn.
${h} qua thử không, em giữ slot HLV luôn nha?"`;
  }

  // ── FITNESS: đang evaluation → show gói có narrative ──
  if (
    flow === "fitness" &&
    stage === "evaluation" &&
    knownInfo.serviceType !== null
  ) {
    const svc = knownInfo.serviceType;
    const goal = knownInfo.fitnessGoal ?? "sức khỏe tổng thể";

    // Goal-specific value hint
    const goalHint: Record<string, string> = {
      "tang-co": `Tăng cơ cần tập có hệ thống + kỹ thuật đúng giai đoạn đầu → nhấn PT cá nhân, cộng thêm Yoga/Pilates để phục hồi cơ. KHÔNG chỉ nhấn diện tích phòng.`,
      "giam-mo": `Giảm mỡ hiệu quả = cardio + weight training kết hợp → nhấn thẻ Full (Gym + Zumba/Bơi dùng chung), bể bơi 4 mùa duy nhất Vĩnh Yên. KHÔNG chỉ nhấn diện tích phòng.`,
      "thu-gian": `Thư giãn → nhấn Yoga GV Ấn Độ 4 ca/ngày linh hoạt lịch + không gian rộng không chen chúc.`,
      "hoc-boi": `Học bơi → nhấn bể 4 mùa duy nhất Vĩnh Yên + cam kết biết bơi sau khóa (học lại miễn phí).`,
      "suc-khoe": `Sức khỏe tổng thể → nhấn thẻ Full 4 dịch vụ trong 1 thẻ, ~19k/ngày.`,
    };
    const specificHint =
      goalHint[goal] ??
      `Nhấn điểm khác biệt cụ thể của ${svc} phù hợp mục tiêu ${goal}.`;

    return `[EXAMPLE_STRUCTURE — BUILD VALUE RỒI MỚI GIÁ]
⚠️ TUYỆT ĐỐI KHÔNG dùng **bold** hay *italic* — TEXT THUẦN TÚY như nhắn Zalo
⚠️ KHÔNG khen giả: "không gian thoải mái sẽ giúp", "mục tiêu đó rất hay", "Với mục tiêu X, [cơ sở Y] sẽ giúp..."
⚠️ Value phải CỤ THỂ theo goal, KHÔNG generic
⚠️ ${specificHint}

SAI (generic + markdown + khen giả):
"Với mục tiêu ${goal} của ${h}, không gian thoải mái sẽ giúp tập hiệu quả hơn.
Có mấy gói: **Gói 12 tháng**: 7tr..."

ĐÚNG (structure):
"[1-2 câu nhấn điểm khác biệt CỤ THỂ của ${svc} cho mục tiêu ${goal} — không phải generic]

Có mấy hướng cho ${h}:
[tên gói mô tả ngắn] [giá] — [lý do phù hợp mục tiêu ${goal}]
[tên gói 2] [giá] — [mô tả ngắn]
[tên gói 3] [giá] — nếu ${h} muốn thử trước

Hội viên mục tiêu ${goal} thường chọn [gói phổ biến] nhất ${h}.
[câu hỏi dẫn dắt về lịch / số buổi]"

GIÁ PHẢI ĐÚNG THEO BẢNG GIÁ. KHÔNG liệt kê khô — mỗi gói cần 1 lý do gắn với mục tiêu ${goal}.`;
  }

  // ── GIẢI CƠ: chưa biết vùng đau ──
  if (
    flow === "giai-co" &&
    stage === "discovery" &&
    knownInfo.painArea === null
  ) {
    return `[EXAMPLE — ANSWER FIRST + DẪN DẮT TÂM LÝ]
Khách: "giải cơ là gì / giá bao nhiêu"
Em: "Giải cơ chuyên sâu khác massage thông thường ${h} —
     không phải vuốt bề mặt mà tháo từng nút thắt bên trong cơ (Trigger Points),
     nên hiệu quả bền hơn thay vì thư giãn tạm thời.
     Giá từ 200k (45 phút, 1-2 vùng) đến 590k (CS-VIP 2 kèm tắm thuốc + xông).
     ${h} đang cảm thấy đau mỏi vùng nào nhiều nhất để em tư vấn đúng gói nha"`;
  }

  // ── GIẢI CƠ: evaluation — visualize + contrast + invite 1 buổi ──
  if (
    flow === "giai-co" &&
    stage === "evaluation" &&
    knownInfo.painArea !== null
  ) {
    const pain = knownInfo.painArea;
    const method = knownInfo.pastMethod;
    const duration = knownInfo.painDuration;

    // Contrast text dựa trên pastMethod
    const contrastMap: Record<string, string> = {
      massage: `Massage làm mềm bề mặt nhất thời — nút thắt sâu vẫn còn, đó là lý do đỡ rồi lại đau lại ${h}.`,
      thuoc: `Thuốc giảm viêm bề mặt nhưng không gỡ được điểm kích hoạt bên trong — hết thuốc là đau lại ${h}.`,
      "vat-ly-tri-lieu": `Vật lý trị liệu thông thường tác động vào khớp nhiều hơn — với cơ bị xơ cứng thì cần vào sâu lớp cơ hơn ${h}.`,
      "chua-thu": `Cơ thể ${h} chưa được xử lý gốc lần nào — đây là thời điểm phù hợp để gỡ trước khi xơ hóa nặng hơn.`,
    };
    const contrastText = method
      ? (contrastMap[method] ??
        `Phương pháp trước chỉ xử lý bề mặt — giải cơ chuyên sâu đi vào tận lớp cơ sâu ${h}.`)
      : `Đau ${pain} kiểu này thường là nút thắt đã bắt đầu xơ hóa — massage bề mặt không gỡ được ${h}.`;

    return `[EXAMPLE — GIẢI CƠ EVALUATION: VISUALIZE → CONTRAST → VIỄN CẢNH → MỜI 1 BUỔI]
⚠️ BƯỚC 0: GỌI get-media TRƯỚC — đưa URLs vào mediaUrls output, KHÔNG hỏi "có muốn xem video không"
⚠️ KHÔNG show bảng 3 gói ngay — chỉ mời 1 buổi thử trước
⚠️ TEXT THUẦN TÚY — không **bold**, không bullet "-"

SAI (hỏi thay vì chủ động gửi):
"${h} có muốn xem video demo không?"

SAI (bán gói quá sớm):
"Với tình trạng của ${h}, em gợi: CS-VIP 2 × 10 buổi (3.8tr)..."

ĐÚNG (gọi get-media TRƯỚC rồi mới viết text):
"[Hình ảnh hóa vùng ${pain}${duration ? ` đã ${duration}` : ""}: sợi guitar căng quá / cầu dao điện bị kẹt / cuộn len rối — dùng cái phù hợp nhất]

${contrastText}

Khi gỡ được điểm đó thì sáng dậy ${pain.includes("vai") || pain.includes("co") ? "cổ vai không còn cứng ngắc" : "không còn cảm giác đau âm ỉ"} nữa ${h}.

Bên em có KTV chuyên giải cơ chuyên sâu — ${h} thử 1 buổi trước, KTV đánh giá thực tế rồi tư vấn lộ trình phù hợp luôn, không cam kết gì trước.
${h} tiện khung sáng hay chiều để em giữ slot nha?"`;
  }

  // ── GIẢI CƠ: commitment — trả lời ngắn + hỏi tên/SĐT ──
  if (flow === "giai-co" && stage === "commitment") {
    const { name, phone, preferredTime } = knownInfo;
    return `[EXAMPLE — COMMITMENT: 3 SUB-STATE]
⚠️ TUYỆT ĐỐI KHÔNG lặp "KTV sẽ đánh giá thực tế" / "tư vấn lộ trình phù hợp" — đã nói rồi
⚠️ Khi khách hỏi giá/phí → trả lời 1 câu rồi hỏi tên/SĐT ngay — KHÔNG giải thích thêm

--- BƯỚC 1: chưa có tên/SĐT ---
Khách: "buổi đầu mất phí không"
ĐÚNG: "Có tính phí ${h} — buổi 200k. Cho em xin tên với SĐT để giữ slot chiều nha?"
SAI: "Buổi đầu có phí anh nhé, nhưng đây là cơ hội để KTV đánh giá thực tế..."

Khách: "ok"
ĐÚNG: "Cho em xin tên với SĐT để giữ slot ${h} nha?"

Khách: "sáng nha" / "chiều được" / "tối nha" / [báo khung giờ bất kỳ]
ĐÚNG: "Sáng bên em mở từ 9h, ${h} cho em xin tên với SĐT để giữ chỗ cho mình ạ"
SAI: "Em giữ slot buổi sáng cho ${h} nhé. KTV sẽ đánh giá thực tế và tư vấn lộ trình phù hợp luôn."
SAI: "Em giữ slot cho ${h} rồi nha."
⚠️ Khách báo giờ ≠ đã chốt — vẫn phải hỏi tên/SĐT trước khi xác nhận bất cứ điều gì.

--- BƯỚC 2: đã có tên/SĐT, chưa có giờ ---
ĐÚNG: "Chiều bên em còn 15h và 17h — ${h} tiện khung nào hơn?"

--- BƯỚC 3: đã có tên/SĐT/giờ ---
ĐÚNG: "Em giữ slot [giờ] cho ${h} rồi. Nếu ${h} muốn chắc chỗ thì cọc trước giúp em, còn không qua rồi thanh toán cũng được nha."`;
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
    if (info.serviceType !== null) parts.push(`dịch-vụ=${info.serviceType}`);
    if (info.fitnessGoal !== null) parts.push(`mục-tiêu=${info.fitnessGoal}`);
    if (info.memberType !== null)
      parts.push(`loại-thành-viên=${info.memberType}`);
    if (info.durationMonths !== null)
      parts.push(`thời-hạn=${info.durationMonths}tháng`);
    if (info.schedule !== null) parts.push(`lịch=${info.schedule}`);
  } else {
    if (info.painArea !== null) parts.push(`vùng-đau=${info.painArea}`);
    if (info.painSpread !== null) parts.push(`lan-toa=${info.painSpread}`);
    if (info.painDuration !== null)
      parts.push(`đau-bao-lâu=${info.painDuration}`);
    if (info.pastMethod !== null) parts.push(`đã-thử=${info.pastMethod}`);
    if (info.sessionPackage !== null) parts.push(`gói=${info.sessionPackage}`);
    if (info.preferredTime !== null)
      parts.push(`giờ-muốn=${info.preferredTime}`);
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
  stage: Stage,
): string {
  const missing: string[] = [];

  if (flow === "fitness") {
    if (info.serviceType === null) missing.push("serviceType");
    // fitnessGoal chỉ bắt buộc ở discovery khi intent=explore
    if (
      info.fitnessGoal === null &&
      stage === "discovery" &&
      intent === "explore"
    ) {
      missing.push("fitnessGoal");
    }
    if (info.durationMonths === null && stage === "commitment")
      missing.push("durationMonths");
  } else {
    if (info.painArea === null) missing.push("painArea");
    if (info.painSpread === null && stage === "discovery")
      missing.push("painSpread");
    if (info.painDuration === null && stage === "discovery")
      missing.push("painDuration");
    // pastMethod là slot bắt buộc ở discovery — phải có trước khi sang evaluation
    if (
      info.pastMethod === null &&
      (stage === "discovery" || stage === "evaluation")
    ) {
      missing.push("pastMethod");
    }
    if (info.sessionPackage === null && stage === "commitment")
      missing.push("sessionPackage");
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
    buildMissingSlotHint(
      state.knownInfo,
      state.flow,
      state.intent,
      state.stage,
    ),
    buildLogicGate(state),
    buildFewShot(state, h) ?? "",
  ];

  return lines.filter(Boolean).join("\n");
}

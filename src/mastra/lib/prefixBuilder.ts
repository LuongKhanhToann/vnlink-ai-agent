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
import { buildDateContext } from "./dateHelper";

// ─────────────────────────────────────────────
// DIGRESSION CLASSIFIER
// ─────────────────────────────────────────────

function canAnswerWithoutCoreSlot(
  intent: Intent,
  _flow: Flow,
  stage: Stage,
): boolean {
  if (intent === "compare") return true;
  if (stage === "opening") return true;
  return false;
}

// ─────────────────────────────────────────────
// DEPOSIT / PAYMENT-AHEAD DETECTION
// ─────────────────────────────────────────────

/**
 * True khi tin nhắn khách chủ động hỏi về cọc / thanh toán trước / chuyển khoản / QR.
 * Dùng để kích hoạt GATE gọi get-qr, vượt lên các lệnh "DỪNG HẲN" khác.
 */
export function detectDepositAsk(message: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    /\bcọc\b|đặt\s?cọc/.test(m) ||
    /thanh\s?toán\s?trước|trả\s?trước/.test(m) ||
    /chuyển\s?(khoản|tiền)/.test(m) ||
    /\bqr\b|mã\s?qr/.test(m) ||
    /số\s?tài\s?khoản|\bstk\b|số\s?tk/.test(m)
  );
}

// ─────────────────────────────────────────────
// MEDIA KEY SUGGESTION
// ─────────────────────────────────────────────

/**
 * Map slots → key tool get-media phù hợp nhất.
 * Trả null nếu chưa đủ info để gợi key tốt (vd fitness chưa có serviceType).
 *
 * Fitness:
 *   gym/full → fitness-gym
 *   yoga    → fitness-yoga
 *   zumba   → fitness-zumba
 *   boi     → fitness-pool
 *   pilates → fitness-gym (cùng phòng tập, fallback an toàn)
 *
 * Giải cơ:
 *   vai/gáy/cổ → mr-neck-shoulder
 *   chân/gối   → mr-sport
 *   khác       → mr-general
 */
function computeSuggestedMediaKey(state: ConversationState): string | null {
  const { flow, knownInfo } = state;

  if (flow === "fitness") {
    const svc = knownInfo.serviceType;
    if (!svc) return null;
    const mapFitness: Record<string, string> = {
      gym: "fitness-gym",
      full: "fitness-gym",
      pilates: "fitness-gym",
      yoga: "fitness-yoga",
      zumba: "fitness-zumba",
      boi: "fitness-pool",
    };
    return mapFitness[svc] ?? null;
  }

  // giai-co
  const pain = knownInfo.painArea;
  if (!pain) return null;
  const tokens = pain.toLowerCase().split(/[\s,/\-_]+/).filter(Boolean);
  const has = (...words: string[]) => words.some((w) => tokens.includes(w));
  if (has("vai", "gáy", "gay", "cổ", "co")) return "mr-neck-shoulder";
  if (has("chân", "chan", "gối", "goi")) return "mr-sport";
  return "mr-general";
}

/**
 * Block [MEDIA]: hint MỀM, không ép.
 * Bot tự quyết có gọi get-media hay không dựa trên moment phù hợp.
 *
 * Nguyên tắc inject:
 *   - mediaShown=true            → cấm cứng (đã handle ở đầu buildLogicGate).
 *   - opening / commitment       → không khuyến khích (sai moment).
 *   - không có suggestedKey      → không gợi.
 *   - còn lại                    → gợi key + để LLM tự quyết.
 */
function buildMediaHint(state: ConversationState): string {
  if (state.mediaShown) return "";
  if (state.stage === "opening" || state.stage === "commitment") return "";

  const key = computeSuggestedMediaKey(state);
  if (!key) return "";

  const target = state.flow === "fitness" ? "phòng tập" : "vùng đang đau";
  return (
    `[MEDIA: chưa gửi ảnh/video. suggestedKey="${key}" (${target}). ` +
    "TỰ QUYẾT có gọi tool get-media hay không trong turn này dựa trên cảm nhận: " +
    "  ✓ NÊN gửi khi: khách đang quan tâm cụ thể (so sánh, hỏi chi tiết), đang phân vân cần thêm trust, " +
    "    đang ở stage build-value mà text suông chưa đủ thuyết phục. " +
    "  ✗ KHÔNG gửi khi: khách chỉ chào hỏi/cảm ơn, đang chốt giờ, message ngắn không có ý so sánh, " +
    "    hoặc khách đã thể hiện sẵn sàng đăng ký (đừng cản dòng chốt). " +
    "Chỉ gửi 1 LẦN/cuộc trò chuyện. Đây là moment marketing — gửi đúng thì tăng trust, sai thì spam.]"
  );
}

// ─────────────────────────────────────────────
// LOGIC GATES
// ─────────────────────────────────────────────

export function buildLogicGate(state: ConversationState, message?: string): string {
  const { stage, intent, flow, knownInfo, mediaShown } = state;
  const hints: string[] = [];

  // ── CROSS-CUTTING: media đã gửi rồi → cấm gọi lại ──
  if (mediaShown) {
    hints.push(
      "[GATE: mediaShown=true — ĐÃ gửi ảnh/video cho khách. " +
        "TUYỆT ĐỐI KHÔNG gọi lại tool get-media trong turn này, dù GATE khác có yêu cầu. " +
        "Nếu khách hỏi xem thêm/khác vùng → trả lời text rồi mời ghé trực tiếp xem.]",
    );
  }

  // ── CROSS-CUTTING: khách chủ động hỏi cọc / thanh toán trước ──
  // Phải check TRƯỚC các GATE commitment "DỪNG HẲN" để không bị che.
  if (message && detectDepositAsk(message)) {
    const qrShown = (state as any).qrShown ?? false;
    if (!qrShown) {
      if (knownInfo.name && knownInfo.phone) {
        const qrFlow = flow === "fitness" ? "fitness" : "muscle-release";
        return (
          `[GATE ƯU TIÊN TUYỆT ĐỐI: khách chủ động hỏi về cọc / thanh toán trước. ` +
          `BẮT BUỘC GỌI tool get-qr với flow="${qrFlow}" NGAY trong turn này. ` +
          `Sau đó viết reply ngắn: xác nhận đặt cọc được + gửi kèm QR + 1 dòng hướng dẫn ghi nội dung chuyển khoản là tên và SĐT khách. ` +
          `Copy qrUrl từ kết quả tool vào field "qrUrl" của output, set nextStep="show_qr". ` +
          `BỎ QUA mọi lệnh "DỪNG HẲN" khác — cọc là yêu cầu chủ động của khách, phải đáp ứng.]`
        );
      }
      // Chưa có tên/SĐT → xin trước, chưa gọi QR
      return (
        `[GATE: khách hỏi về cọc/thanh toán trước nhưng CHƯA đủ tên/SĐT. ` +
        `Trả lời: "Dạ cọc trước được nha ${flow === "fitness" ? "anh/chị" : "anh/chị"} — cho em xin tên với SĐT để lập đơn rồi em gửi QR ngay ạ". ` +
        `KHÔNG gọi get-qr cho đến khi có đủ tên/SĐT.]`
      );
    }
    // Đã gửi QR rồi mà khách hỏi lại → hướng dẫn lại
    return (
      `[GATE: QR đã được gửi trước đó. Không gọi lại get-qr. ` +
      `Xác nhận nội dung chuyển khoản (tên + SĐT khách) và hướng dẫn bước tiếp theo.]`
    );
  }

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
    const step1 = knownInfo.schedule
      ? "xác nhận định hướng tập luyện 1 câu ngắn, tự tin"
      : `đưa ra định hướng tập luyện 1 câu ngắn, tự tin (không hỏi, không đề cập số buổi)`;
    hints.push(
      `[GATE: inbody — ${goalCtx}, ${scheduleCtx}. ` +
        `BẮT BUỘC: (1) ${step1} → (2) pitch Inbody miễn phí → (3) câu mời nhẹ. ` +
        "TUYỆT ĐỐI KHÔNG show gói/giá ở bước này — Inbody phải xảy ra trước evaluation.]",
    );
  }

  // ── FITNESS: evaluation — nhắc build value trước ──
  if (flow === "fitness" && stage === "evaluation") {
    // Khách chủ động chọn/đăng ký → skip pitch, hỏi ngay tên/SĐT
    if (intent === "selecting" || intent === "ready") {
      hints.push(
        "[GATE: khách đã sẵn sàng đăng ký. KHÔNG pitch thêm gói — " +
          "hỏi ngay tên và SĐT: 'Cho em xin tên với SĐT để giữ slot ạ' " +
          "TUYỆT ĐỐI không giới thiệu lại dịch vụ hay giá ở tin này.]",
      );
    } else {
      const goalCtx = knownInfo.fitnessGoal
        ? `mục_tiêu=${knownInfo.fitnessGoal}`
        : "chưa có mục tiêu";
      const svcCtx = knownInfo.serviceType
        ? `dịch_vụ=${knownInfo.serviceType}`
        : "";
      hints.push(
        `[GATE: evaluation — ${svcCtx} ${goalCtx}. ` +
          "BẮT BUỘC theo thứ tự: (1) 1-2 câu value CỤ THỂ theo mục tiêu → " +
          "(2) gợi tối đa 3 gói ANCHOR CAO→VỪA→NHẸ, MỖI GÓI PHẢI ghi giá thật từ bảng giá kèm 1 lý do gắn mục tiêu → " +
          "(3) kết bằng câu hỏi giờ/lịch đến InBody. " +
          "TUYỆT ĐỐI KHÔNG bỏ giá trong mô tả gói — gói thiếu giá là sai.]",
      );
    }
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

    // Khách đã đồng ý + báo giờ → bỏ qua pitch, hỏi ngay tên/SĐT
    if ((intent === "selecting" || intent === "ready") && knownInfo.preferredTime !== null) {
      hints.push(
        `[GATE: khách đã xác nhận đặt lịch buổi ${knownInfo.preferredTime}. ` +
          "KHÔNG pitch lại — xác nhận ngắn 1 câu rồi hỏi ngay tên và SĐT: " +
          "'Để em giữ slot [giờ] cho anh/chị, cho em xin tên với SĐT ạ' " +
          "TUYỆT ĐỐI không lặp lại nội dung tư vấn đã nói.]",
      );
    } else {
      const hasContact = knownInfo.name !== null && knownInfo.phone !== null;
      const closingInstruction = hasContact
        ? `đã có tên=${knownInfo.name} và SĐT — KHÔNG hỏi lại tên/SĐT. Sau pitch xác nhận ngắn 1 câu ('Em giữ slot ${knownInfo.preferredTime ?? "..."} cho ${knownInfo.name} rồi ạ') rồi dừng`
        : knownInfo.preferredTime
          ? `đã biết giờ=${knownInfo.preferredTime} — sau khi pitch xong KẾT THÚC bằng xin tên/SĐT ('Để em giữ slot ${knownInfo.preferredTime} cho anh, cho em xin tên với SĐT nha'). TUYỆT ĐỐI không hỏi lại giờ`
          : "sau khi pitch xong hỏi giờ muốn đến (sáng/chiều/tối) và xin tên/SĐT trong 1 câu gộp";
      hints.push(
        `[GATE: evaluation — vùng_đau=${knownInfo.painArea}, ${durationCtx}, ${methodCtx}. ` +
          "Cấu trúc response: (1) hình ảnh hóa vùng đó → (2) contrast với pastMethod đã biết → (3) vẽ viễn cảnh sau khi gỡ → " +
          `(4) CHỈ mời 1 buổi thử — ${closingInstruction}. KHÔNG show bảng gói 3 dòng ngay lần đầu. ` +
          "Quyết định gửi ảnh/video xem [MEDIA] block riêng — KHÔNG ép.]",
      );
    }
  }

  // ── COMMITMENT: chốt lịch ──
  if (stage === "commitment") {
    const dateCtx = buildDateContext();
    const { name, phone } = knownInfo;
    const hasTime = knownInfo.preferredTime !== null;
    const qrShown = (state as any).qrShown ?? false;

    if (!name || !phone) {
      if (!hasTime) {
        // Chưa có cả 3 → hỏi GỘP 1 lần
        hints.push(
          "[GATE: CHƯA CÓ tên, SĐT và giờ. " +
            "Hỏi GỘP 1 câu duy nhất: 'Cho em xin tên, SĐT với anh/chị muốn đến buổi sáng, chiều hay tối để em giữ slot ạ' " +
            "TUYỆT ĐỐI KHÔNG hỏi từng thứ riêng lẻ. KHÔNG đề cập giá hay gói (10 buổi, liệu trình...) trong tin này. Chỉ 1 câu hỏi gộp.]",
        );
      } else {
        // Đã biết giờ, chỉ cần tên/SĐT
        hints.push(
          `[GATE: đã biết giờ=${knownInfo.preferredTime} — chỉ cần tên và SĐT. ` +
            "Hỏi: 'Cho em xin tên với SĐT để giữ slot ạ' " +
            "TUYỆT ĐỐI KHÔNG đề cập giá hay gói (10 buổi, liệu trình...) trong tin này. Chỉ 1 câu hỏi tên/SĐT.]",
        );
      }
    } else if (!hasTime) {
      // Đã có tên/SĐT, cần giờ
      hints.push(
        "[GATE: đã có tên/SĐT — chỉ cần hỏi khung giờ: 'Anh/chị muốn đến buổi sáng, chiều hay tối ạ?' KHÔNG hỏi thêm gì khác.]",
      );
    } else if (!qrShown) {
      // ĐỦ INFO (tên + SĐT + giờ) → XÁC NHẬN VÀ DỪNG
      hints.push(
        `[GATE: ĐỦ INFO — tên=${name}, sđt=${phone}, giờ=${knownInfo.preferredTime}. ` +
        `NGÀY HÔM NAY:\n${dateCtx}\n` +
        "XÁC NHẬN lịch 1 câu ngắn gọn, ghi ngày cụ thể nếu preferredTime đã có ngày " +
        "('Em giữ slot [thời gian] cho [tên] rồi nha') rồi DỪNG HẲN. " +
        "Nếu preferredTime chỉ có buổi (sáng/chiều/tối) thì hỏi thêm ngày: " +
        "'Anh/chị muốn đến [buổi] ngày nào để em giữ slot ạ' " +
        "TUYỆT ĐỐI KHÔNG hỏi thêm bất cứ điều gì khác.]"
      );
    } else {
      hints.push(
        "[GATE: đã gửi QR. Xác nhận và hướng dẫn bước tiếp theo. DỪNG.]",
      );
    }
  }

  return hints.join("\n");
}

// ─────────────────────────────────────────────
// KNOWLEDGE BLOCKS — inject theo stage, tránh thừa token
// ─────────────────────────────────────────────

function buildFitnessPricing(info: KnownInfo): string {
  const svc = info.serviceType;
  const mt = info.memberType;
  const lines: string[] = [];

  if (!svc || svc === "boi") {
    lines.push("  Bơi TE: 1m=600k|3m=1.2tr|6m=2.2tr|12m(3b/t)=2tr|12m-full=3tr|+lớp=3.5tr");
    lines.push("  Bơi NL: 1m=800k|3m=1.8tr|6m=3.5tr|12m(3b/t)=3tr|12m-full=5tr|+lớp=5.5tr");
    lines.push("  Học bơi: lớp(12b)=1.2tr+1m | 1-1(12b)=3tr+3m | 1-1(20b,2kiểu)=5tr+3m | nhóm≥2=5tr/cặp+3m. Cam kết biết bơi.");
  }
  if (!svc || svc === "gym" || svc === "full") {
    lines.push("  Gym: fulltime-12m=5tr | 3b/t-12m=4.5tr | 3b/t-6m=2tr");
    lines.push("  PT: 10b=3tr|15b=4tr|20b=5tr | 20b(2m)=6tr|30b(2m)=8tr|40b(2m)=10tr | 50b(3m)=12tr");
  }
  if (!svc || svc === "yoga" || svc === "zumba" || svc === "full") {
    lines.push("  Yoga/Zumba: fulltime-12m=5.8tr | 3b/t-12m=4.5tr (GV Ấn Độ, 4 ca/ngày)");
  }
  if (!svc || svc === "pilates") {
    lines.push("  Pilates thảm(1:7): 10b=1.5tr|20b=2.4tr|30b=3tr");
    lines.push("  Pilates máy(1:6): 10b=1.9tr|20b=3.6tr|30b=5.1tr | Nhóm(1:3): 10b=3tr | Cá nhân(1:1): 10b=4.5tr");
  }
  if (mt === "hoc-sinh") {
    lines.push("  FULL HS/SV(14-22t): 1m=700k|3m=2tr|6m=3tr|12m=4tr ← anchor chính");
  } else if (mt === "gia-dinh") {
    lines.push("  FULL cá nhân: 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr(~19k/ngày)");
    lines.push("  FULL gia đình: 2ng=12tr|3ng=17tr|4ng=20tr ← anchor chính");
  } else {
    lines.push("  FULL(Gym+Bơi+Yoga+Zumba): 1m=1.2tr|3m=3tr|6m=4.5tr|12m=7tr(~19k/ngày) ← anchor chính");
  }
  return `[PRICING:\n${lines.join("\n")}\n]`;
}

function buildFitnessObjections(h: string): string {
  return `[OBJECTIONS:
  "Đắt quá" → "Full 12m chỉ ~19k/ngày ${h} — rẻ hơn ly cà phê mà sức khỏe cả năm" + 4 dịch vụ/1 thẻ. KHÔNG giảm giá. Offer gói ngắn nếu vẫn từ chối.
  "Tập 1 môn" → "Thẻ Full chỉ hơn chút mà dùng cả 4 ${h} — tập 1 môn lâu chán, thêm Yoga/Bơi duy trì động lực"
  "Tháng lẻ thôi" → "1.2tr/tháng nhưng gói năm 7tr = ~583k/tháng ${h} — bảo lưu được, chuyển nhượng trong gia đình"
  "Chờ KM" → "Giá bên em xu hướng chỉ tăng ${h} — đợt này đang mức tốt nhất. Em giữ chỗ trước nha"
  "Chưa tin" → gọi get-media + "${h} qua tham quan — HLV đo Inbody miễn phí, xem số rồi chọn gói chuẩn luôn"
  "Xin thêm/quen sếp" → Trình bày đủ giá niêm yết, "đây là mức ưu đãi tốt nhất em áp dụng được" → chốt ngay]`;
}

function buildGiaiCoPricing(): string {
  return `[PRICING:
  Lẻ: Thải độc=100k|Spa Foot=200k|Full Foot=270k|Spa Body=280k|Full Body=330k|VIP2=380k|VIP1=420k
  Giải cơ lẻ: 45p(1-2v)=200k|75p=330k|CB1=330k|CB2=380k|CS-CB=380k|CS-VIP1=480k|CS-VIP2=590k
  ⚠️ Không nhận tip — KTV được trả công đầy đủ
  Liệu trình (ưu tiên tư vấn):
    VIP1×10=4.2tr(tặng 1→11b)⭐ | VIP1×20=8.4tr(tặng 3→23b)
    VIP2×10=3.8tr(tặng 1→11b)⭐ | VIP2×20=7.6tr(tặng 3→23b)
    Full Body×10=3.3tr(tặng 1→11b) | Full Body×20=6.6tr(tặng 3→23b)
  Anchor: CS-VIP2(590k)→CS-VIP1(480k)→CB1(330k). Ưu tiên chốt VIP2×10 = ~345k/buổi.]`;
}

function buildGiaiCoObjections(h: string): string {
  return `[OBJECTIONS:
  "Có đau không?" → "Sẽ có cảm giác 'đau đã' ở vùng bị tắc ${h} — đó là đúng điểm. KTV điều chỉnh lực theo ngưỡng. Sau đó hầu hết nói: 'Biết thế đến sớm hơn'"
  "Ê ẩm không?" → "Có thể ê nhẹ 1-2 ngày — như vừa tập gym về. Dấu hiệu tốt ${h}"
  "Giá cao hơn" → "KTV được đào tạo giải phẫu cơ bài bản ${h} — tác động đúng nhóm cơ. Trả cho kết quả bền vững"
  "Thoát vị đĩa đệm?" → "Được ${h} — KTV tránh trực tiếp cột sống, giải tỏa cơ xung quanh để giảm áp lực đĩa đệm"
  "Chấn thương TT" → Cấp tính: "Nghỉ 3-5 ngày rồi mình xử lý ${h}" | Mạn tính: "Đây chính xác là điều bên em làm tốt nhất ${h}"
  "Không có TG" → "75p/tuần thôi ${h} — cơ thể 'đình công' thật sự thì mọi công sức làm ra rất đáng tiếc"
  "Thử 1 buổi rồi tính" → "Hoàn toàn hợp lý ${h} — buổi đầu thường nhẹ 50-70% ngay. Em không ép"]`;
}

function buildKnowledgeBlock(state: ConversationState, h: string): string {
  const { stage, flow, knownInfo, intent } = state;

  const showPricing =
    stage === "evaluation" ||
    stage === "negotiation" ||
    stage === "commitment" ||
    intent === "selecting" ||
    intent === "ready";

  const showObjHandling = stage === "objection" || stage === "negotiation";

  const blocks: string[] = [];

  if (flow === "fitness") {
    if (stage === "opening" || stage === "discovery") {
      blocks.push(
        `[CENTER: Fami Fitness & Yoga Center Vĩnh Yên | 05:00–20:00 | Thành lập 2014\n` +
        `  Bơi → Bể 4 mùa 350m2 DUY NHẤT Vĩnh Yên, nước nóng quanh năm, lọc ozone\n` +
        `  Gym → 700m2 trong nhà + 300m2 ngoài có mái che, chứa 100 người\n` +
        `  Yoga/Zumba → GV người Ấn Độ chuyên nghiệp, 4 ca/ngày\n` +
        `  Pilates → 13 máy chuẩn quốc tế, GV chứng chỉ QT (từ 12/2024)]`,
      );
    }
    if (showPricing) blocks.push(buildFitnessPricing(knownInfo));
    if (showObjHandling) blocks.push(buildFitnessObjections(h));
  }

  if (flow === "giai-co") {
    if (stage === "opening" || stage === "discovery") {
      blocks.push(
        `[CENTER: TT Chăm sóc Sức khỏe Hoa Sen | 09:00–23:00 | Thành lập 08/2018\n` +
        `  17 phòng | 4 KTV giải cơ chuyên sâu + 15 KTV massage\n` +
        `  Dịch vụ: giải cơ chuyên sâu, massage, spa, tắm thuốc, gội đầu, chăm sóc da]`,
      );
    }
    if (showPricing) blocks.push(buildGiaiCoPricing());
    if (showObjHandling) blocks.push(buildGiaiCoObjections(h));
  }

  if (blocks.length === 0) return "";
  return `[KNOWLEDGE:\n${blocks.join("\n")}\n]`;
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
    return `[EXAMPLE — TIN ĐẦU: 1 CÂU HỎI SCHEDULE, KHÔNG KHEN, KHÔNG GIỚI THIỆU, KHÔNG GIÁ]
Khách: "mình muốn tập ${svc} ${goal}"
ĐÚNG: "${h} tập mấy buổi một tuần?" hoặc "${h} hay tập sáng hay chiều tối hơn?"
SAI: "Tuyệt vời!", "Dạ, tập Gym để giảm mỡ là hợp lý...", giới thiệu cơ sở, list gói/giá.`;
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
    return `[EXAMPLE — INBODY PITCH: text thuần, KHÔNG **bold**, KHÔNG giá/gói]
1 message = xác nhận lịch ngắn + pitch Inbody + câu mời. KHÔNG kèm bất cứ gì khác.

SAI: "Với lịch X, ${h} có thể chọn Full 12 tháng 7tr..."  ← nhảy gói
ĐÚNG: "Dạ, để ${goal} hiệu quả thì cần kết hợp tập luyện đúng hướng ${h}. Bên em đo InBody miễn phí lần đầu, HLV phân tích tỷ lệ mỡ cơ rồi tư vấn lộ trình chuẩn luôn. ${h} qua thử 1 buổi cho dễ chọn gói nha"`;
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

    // Concrete package examples per goal — correct anchor order: high → mid → light
    const goalPackages: Record<string, string> = {
      "giam-mo":
        `Full 12 tháng 7tr (~19k/ngày) — Gym + Bơi/Zumba 1 thẻ, cardio + weight kết hợp đốt mỡ nhanh nhất\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — chỉ gym, lịch ổn định cả năm\n` +
        `Gym 3 buổi/tuần 6 tháng 2tr — thử nửa năm trước, ít áp lực hơn`,
      "tang-co":
        `PT 20 buổi (2 tháng) 6tr — HLV 1-1 xây kỹ thuật nền đúng, tránh chấn thương\n` +
        `Full 12 tháng 7tr — Gym + Yoga/Pilates phục hồi cơ trong 1 thẻ\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — tự tập theo lịch dài hơi`,
      "thu-gian":
        `Full 12 tháng 7tr (~19k/ngày) — Gym + Yoga + Zumba + Bơi trong 1 thẻ\n` +
        `Yoga/Zumba fulltime 12 tháng 5.8tr — không giới hạn ca, GV Ấn Độ 4 ca/ngày\n` +
        `Yoga/Zumba 3 buổi/tuần 12 tháng 4.5tr — lịch cố định 3 buổi/tuần`,
      "hoc-boi":
        `Học bơi 1-1 (12 buổi) 3tr + 3 tháng bể — HLV riêng, cam kết biết bơi, học lại miễn phí\n` +
        `Học bơi lớp nhóm (12 buổi) 1.2tr + 1 tháng bể — lớp nhỏ, tiết kiệm hơn\n` +
        `Bơi NL fulltime 12 tháng 5tr — sau khi biết bơi, tập tự do cả năm`,
      "suc-khoe":
        `Full 12 tháng 7tr (~19k/ngày) — Gym + Bơi + Yoga + Zumba 1 thẻ, toàn diện nhất\n` +
        `Full 6 tháng 4.5tr — đủ 4 dịch vụ, thử 6 tháng trước\n` +
        `Gym 3 buổi/tuần 12 tháng 4.5tr — chỉ gym nếu muốn đơn giản`,
    };
    const concretePackages =
      goalPackages[goal] ??
      `[gói cao nhất] [giá] — [lý do gắn ${goal}]\n[gói vừa] [giá] — [lý do]\n[gói nhẹ nhất] [giá] — thử trước`;

    return `[EXAMPLE — BUILD VALUE TRƯỚC, RỒI 3 GÓI CÓ GIÁ THẬT, THỨ TỰ CAO→VỪA→NHẸ]
⚠️ Text thuần, KHÔNG **bold**/*italic*. KHÔNG khen giả ("không gian thoải mái sẽ giúp...").
⚠️ Value CỤ THỂ theo goal: ${specificHint}

SAI: bỏ giá khỏi gói; "12 tháng = thử trước"; thứ tự sai.

ĐÚNG (cấu trúc):
"[1-2 câu nhấn điểm khác biệt CỤ THỂ của ${svc} cho ${goal}]

Có mấy hướng cho ${h}:
${concretePackages}

Hội viên ${goal} hay chọn [gói đầu tiên] nhất.
[câu hỏi giờ đến InBody — KHÔNG hỏi 'muốn đăng ký không']"

BẮT BUỘC: mỗi gói có giá thật, thứ tự cao→vừa→nhẹ.`;
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

    const preferredTime = knownInfo.preferredTime;
    const hasContact = knownInfo.name !== null && knownInfo.phone !== null;
    const closingLine = hasContact
      ? `Em giữ slot ${preferredTime ?? "..."} cho ${knownInfo.name} rồi ạ`
      : preferredTime
        ? `Để em giữ slot ${preferredTime} cho ${h}, cho em xin tên với SĐT nha`
        : `${h} tiện khung sáng hay chiều để em giữ slot — cho em xin tên với SĐT luôn nha`;

    const timeNote = preferredTime
      ? `ĐÃ BIẾT giờ=${preferredTime} → KHÔNG hỏi giờ lại, kết bằng xin tên/SĐT.`
      : "Chưa có giờ → hỏi giờ ở cuối.";
    const visualHint =
      pain.includes("vai") || pain.includes("co")
        ? "vùng cổ vai sẽ nhẹ hơn, đỡ cứng khựng"
        : "cảm giác đau âm ỉ cũng dịu rõ hơn";
    return `[EXAMPLE — GIẢI CƠ EVALUATION: VISUALIZE → CONTRAST → VIỄN CẢNH → MỜI 1 BUỔI]
⚠️ Không show bảng 3 gói. Text thuần, không markdown. ${timeNote}
⚠️ Quyết định gửi ảnh xem [MEDIA] block — nếu thấy moment phù hợp (khách đang phân vân, cần thêm trust)
   thì gọi get-media với suggestedKey. Nếu khách đã rõ ràng/đang chốt → bỏ qua, gửi text thôi.

SAI: "em gửi hình để dễ hình dung nha" (hỏi thay vì chủ động gửi nếu đã quyết gửi);
     "em gợi CS-VIP 2 × 10 buổi 3.8tr..." (bán gói sớm);
     hỏi lại giờ khi đã có.

ĐÚNG (text response, có hoặc không kèm media tùy moment):
"Dạ, vùng ${pain}${duration ? ` đã ${duration}` : ""} như ${h} mô tả thường giống một nút thắt bị kẹt trong cơ ạ. ${contrastText}
Khi xử lý đúng điểm đó thì sáng dậy ${visualHint} ${h}.
Bên em có KTV chuyên giải cơ chuyên sâu, ${h} có thể thử 1 buổi trước để cảm nhận thực tế. ${closingLine}"`;
  }

  // ── GIẢI CƠ / FITNESS: commitment — hỏi GỘP 3 thứ, xác nhận và dừng ──
  if (stage === "commitment") {
    return `[EXAMPLE — COMMITMENT: HỎI GỘP → XÁC NHẬN → DỪNG]
⚠️ Không lặp "KTV đánh giá thực tế / tư vấn lộ trình". Không đẩy QR trừ khi khách hỏi.

CHƯA đủ 3 (tên+SĐT+giờ):
ĐÚNG: "Cho em xin tên, SĐT với ${h} muốn đến buổi sáng, chiều hay tối ạ"
SAI:  thiếu giờ; xác nhận khi chưa có tên/SĐT.

ĐÃ đủ 3:
ĐÚNG: "Em giữ slot [giờ] cho ${h} [tên] rồi ạ." → DỪNG HẲN.
SAI:  hỏi thêm "cọc trước không".`;
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

export function buildPrefix(state: ConversationState, message?: string): string {
  const h = resolveHonorific(state.honorific);
  const tactic = getTactic(state.flow, state.stage, state.emotion);

  const lines: string[] = [
    `[HONORIFIC: ${h}] [TEMP: ${state.temperature}] [STAGE: ${state.stage}] [EMOTION: ${state.emotion}] [INTENT: ${state.intent}] [FLOW: ${state.flow}]`,
    `[TACTIC: ${tactic}]`,
    `[NOTE: Không bao giờ lặp lại nguyên văn nội dung trong TACTIC, GATE, KNOWLEDGE, EXAMPLE. Chỉ dùng để hiểu và tự viết lại thành câu nói tự nhiên cho khách.]`,
    buildKnownSummary(state.knownInfo, state.flow),
    buildMissingSlotHint(
      state.knownInfo,
      state.flow,
      state.intent,
      state.stage,
    ),
    buildKnowledgeBlock(state, h),
    buildMediaHint(state),
    buildLogicGate(state, message),
    buildFewShot(state, h) ?? "",
  ];

  return lines.filter(Boolean).join("\n");
}

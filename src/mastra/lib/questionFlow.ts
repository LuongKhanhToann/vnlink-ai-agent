/**
 * questionFlow.ts
 *
 * Decision engine cho LUỒNG HỎI fitness (theo TL Fami kịch bản).
 *
 * MỤC TIÊU: gpt-4o-mini có 1 instruction DUY NHẤT mỗi turn. Hạn chế tối đa GATE
 * cạnh tranh / clause optional / câu chữ mềm — toàn bộ là imperative template.
 *
 * KIẾN TRÚC:
 *   - decideFitnessQuestion(state, message, prevBotReply) → 1 decision hoặc null
 *   - Decision = template phản hồi CHÍNH XÁC + danh sách keyword bắt buộc.
 *   - prefixBuilder gọi hàm này TRƯỚC tiên. Nếu non-null → return ngay 1 ANSWER_LOCK
 *     block, bỏ qua các GATE / few-shot / TACTIC khác.
 *
 * GIỚI HẠN: chỉ phụ trách câu hỏi-trả lời. KHÔNG động vào KNOWLEDGE
 * (giá/địa chỉ/giờ mở cửa/facility) — vẫn lấy từ buildKnowledgeBlock.
 */

import { ConversationState, resolveHonorific } from "./stateMachine";

export interface QuestionFlowDecision {
  /** Tên decision (debug log). */
  id: string;
  /** Template reply CHÍNH XÁC bot phải xuất. Đã interpolate honorific. */
  template: string;
  /** Cụm bắt buộc xuất hiện trong reply (test check). */
  mustInclude: string[];
  /** Cụm KHÔNG được xuất hiện. */
  mustNotInclude?: string[];
  /** Comment giải thích — chỉ debug. */
  note?: string;
}

// ─────────────────────────────────────────────
// HELPERS — message classifiers
// ─────────────────────────────────────────────

function lc(s: string): string {
  return (s || "").toLowerCase().trim();
}

function isGreetingOnly(m: string): boolean {
  const s = lc(m);
  return /^(quan\s*tâm|alo|h(i|ello)|chào\b|xin\s*chào|hey)\s*[!?.]*\s*$/i.test(
    s,
  );
}

function isTrialIntro(m: string): boolean {
  // KH chủ động nói muốn "tập trải nghiệm" / "tập thử" ngay tin đầu
  const s = lc(m);
  return /(muốn\s+)?(tập\s+trải\s+nghiệm|trải\s+nghiệm\s+thử|trải\s+nghiệm)\b/.test(
    s,
  );
}

function isGiamCanIntro(m: string): boolean {
  const s = lc(m);
  return /(muốn\s+)?(tập\s+)?giảm\s*(cân|mỡ|béo)/.test(s);
}

function isChuongTrinhConsult(m: string): boolean {
  const s = lc(m);
  if (/ưu\s*đãi|khuyến\s*mãi/.test(s)) return false;
  return (
    /(tư\s*vấn|tham\s*khảo).{0,20}(chương\s*trình|gói|dịch\s*vụ|bộ\s*môn|tập\s*luyện)/.test(
      s,
    ) ||
    /(chương\s*trình|gói\s+tập)\s+(tập|tập\s*luyện|nào|gì)/.test(s) ||
    /có\s+(những\s+)?(chương\s*trình|gói|dịch\s*vụ|bộ\s*môn)\s+(gì|nào)/.test(s)
  );
}

function isPriceOpening(m: string): boolean {
  // "có ưu đãi nào không" / "có chương trình ưu đãi" — câu hỏi giá/ưu đãi turn đầu
  const s = lc(m);
  return /(ưu\s*đãi|khuyến\s*mãi)\s*(nào|gì|không|chứ)?/.test(s);
}

function isTrialAsk(m: string): boolean {
  const s = lc(m);
  if (/gói\s+giá|những\s+gói|các\s+gói\s+nào|gói\s+nào/.test(s)) return false;
  return /(tập\s*thử|tập\s*được\s*thử|trải\s*nghiệm\s*thử|thử\s+(1|một)\s+buổi|thử\s+xem|cho.{0,5}thử|được\s+thử)/.test(
    s,
  );
}

function isExplicitPriceList(m: string): boolean {
  const s = lc(m);
  return /(có\s+(những|các)\s+gói|gói\s+giá\s+nào|những\s+gói\s+nào|các\s+gói\s+(nào|gì)|gói\s+nào\s+(thế|em|ạ))/.test(
    s,
  );
}

function isTrialRegisterAsk(m: string): boolean {
  const s = lc(m);
  return /(đk|đăng\s*k(ý|i))\s+(trải\s+nghiệm|tập\s+thử|thử)/.test(s);
}

function isFullPackageConfirm(m: string): boolean {
  const s = lc(m);
  return (
    /(đăng\s*k(ý|i)|chọn|lấy|tham\s*gia|thử)\s+(luôn\s+)?(gói\s+)?full/.test(
      s,
    ) || /(gói\s+full|thẻ\s+full)\s+(nhỉ|nha|nhé|đi|luôn)/.test(s)
  );
}

function isChuaBietTapGi(m: string): boolean {
  const s = lc(m);
  return (
    /(chưa\s+biết|không\s+biết)\s*(nên\s+)?tập\s+(gì|môn\s+nào|bộ\s*môn\s+nào)/.test(
      s,
    ) || /(em\s+cho|cho)\s+(chị|anh|em|mình|tôi).{0,10}tham\s*khảo/.test(s)
  );
}

function isThamQuan(m: string): boolean {
  const s = lc(m);
  return /tham\s*quan|đi\s+qua\s+(coi|xem)|chỉ\s+(đi|ghé)\s+(qua|xem)/.test(s);
}

function isBoiNlTeAsk(m: string): boolean {
  const s = lc(m);
  // KH "quan tâm/muốn học bơi" — chưa nói NL/TE/tuổi
  if (
    !/(quan\s*tâm|muốn|cần|hỏi\s+về)\s+(học\s+)?bơi|học\s+bơi/.test(s)
  )
    return false;
  if (
    /(trẻ\s*(con|em)|bé\s*nhà|con\s+(tôi|chị|anh|em)|cháu\s+(nhà|tôi|chị|anh)|\bbé\b|người\s*lớn|nl\b|adult)/.test(
      s,
    )
  )
    return false;
  if (/\b\d{1,2}\s*(tuổi|t)\b/.test(s)) return false;
  return true;
}

function isBoiTreEmAsk(m: string): boolean {
  const s = lc(m);
  if (/\b\d{1,2}\s*(tuổi|t)\b/.test(s)) return false;
  return /(trẻ\s*(con|em)|bé\s*nhà|con\s+(tôi|chị|anh|em)|cháu\s+(nhà|tôi|chị|anh)|\bbé\b)/.test(
    s,
  );
}

function isChildAgeStated(m: string): boolean {
  return /\b\d{1,2}\s*(tuổi|t)\b/i.test(m);
}

function isZumbaAerobicCompare(m: string): boolean {
  return /aerobic|earobic/i.test(m);
}

function isZumbaGiamCanAsk(m: string): boolean {
  const s = lc(m);
  return /(giảm\s*(cân|mỡ|béo)|đốt\s*mỡ)/.test(s);
}

function isYesIWillTry(m: string): boolean {
  // KH đồng ý đăng ký trải nghiệm
  const s = lc(m);
  return (
    /^(có|được|ok|vâng|ừ|đồng\s*ý|đăng\s*k(ý|i)\s+đi|cho\s+(em|chị|anh)\s+trải\s+nghiệm|chị\s+thử|tôi\s+thử)/.test(
      s,
    )
  );
}

function isNewUserAsk(m: string): boolean {
  // "chưa tập, có lớp cho người mới không" — câu trấn an
  const s = lc(m);
  return (
    /(chưa\s+tập|chưa\s+từng|chưa\s+bao\s+giờ).{0,40}(lớp|người\s+mới|theo|tập\s+được)/.test(
      s,
    ) || /(có\s+lớp|lớp\s+cho)\s+(người\s+mới|mới\s+tập)/.test(s)
  );
}

function isHaveYouPracticedBefore(m: string): boolean {
  // Bot hỏi "trước đây mình đã tập X chưa" — match từ prev bot reply
  const s = lc(m);
  return /(đã\s+tập\s+(yoga|zumba|gym)\s+(bao\s+giờ\s+)?chưa|trước\s+đây.{0,20}tập|tập\s+(yoga|zumba|gym)\s+chưa)/.test(
    s,
  );
}

function isPriceQuestionPerMonth(m: string): boolean {
  const s = lc(m);
  return /(bao\s+nhiêu\s+tiền|giá|tiền\/tháng|tiền\s+(1|một)?\s*tháng|phí|học\s+phí)/.test(
    s,
  );
}

function isHowToRegisterTrial(m: string): boolean {
  const s = lc(m);
  return (
    /(đăng\s*k(ý|i)|đk)\s+(trải\s+nghiệm|thử|tập\s+thử)\s+(như\s+thế\s+nào|làm\s+sao|kiểu\s+gì)/.test(
      s,
    ) ||
    /trải\s+nghiệm.{0,20}(như\s+thế\s+nào|làm\s+sao)/.test(s)
  );
}

function isMaintainAfterGoal(m: string): boolean {
  const s = lc(m);
  // "sau khi giảm cân rồi, muốn tập duy trì" / "mất ngủ"
  return (
    /(sau\s+khi|sau\s+ấy|sau\s+đó).{0,30}(duy\s+trì|về\s+cân|đạt\s+mục\s+tiêu)/.test(
      s,
    ) ||
    /(mất\s+ngủ|khó\s+ngủ|ngủ\s+không\s+ngon|stress)/.test(s) ||
    /(tập\s+duy\s+trì|duy\s+trì\s+sức\s+kh)/.test(s)
  );
}

function isAskAboutGuidance(m: string): boolean {
  const s = lc(m);
  return /(có\s+ai|có\s+người).{0,15}(hướng\s+dẫn|kèm|dạy)|hlv|huấn\s+luyện\s+viên|giáo\s+viên/.test(
    s,
  );
}

// ─────────────────────────────────────────────
// FACILITY / FAQ — bể bơi
// ─────────────────────────────────────────────

function isPoolHoursAsk(m: string): boolean {
  const s = lc(m);
  return /(bể\s*bơi|hồ\s*bơi).{0,15}(mở|đóng|giờ|mấy\s*giờ|từ\s*mấy)/.test(
    s,
  );
}
function isPoolWarmAsk(m: string): boolean {
  const s = lc(m);
  return /(nước|bể).{0,15}(ấm|nóng|lạnh|nhiệt\s*độ|4\s*mùa|bốn\s*mùa|mái\s*che|trong\s*nhà|ngoài\s*trời)/.test(
    s,
  );
}
function isSwimwearAsk(m: string): boolean {
  const s = lc(m);
  return /(đồ\s*bơi|quần\s*áo\s*bơi|mặc\s+đồ)/.test(s);
}
function isChlorineAsk(m: string): boolean {
  const s = lc(m);
  return /\bclo\b|chlo/.test(s);
}
function isWaterChangeAsk(m: string): boolean {
  const s = lc(m);
  return /(thay\s*nước|đổi\s*nước|nước\s*sạch\s*không)/.test(s);
}
function isLifeguardAsk(m: string): boolean {
  const s = lc(m);
  return /(cứu\s*hộ|thầy\s*kèm|trông\s*coi|giám\s*sát|có\s+thầy)/.test(s);
}
function isPoolTrafficAsk(m: string): boolean {
  const s = lc(m);
  return /(vắng|đông|cao\s*điểm|ít\s*người|đông\s*người).{0,10}(bể|bơi)|bể.{0,10}(vắng|đông)/.test(
    s,
  );
}
function isPoolLimitAsk(m: string): boolean {
  const s = lc(m);
  return /(giới\s*hạn|lượt|số\s*lần|bơi\s*mấy\s*lượt)/.test(s);
}

// ─────────────────────────────────────────────
// MAIN DECISION
// ─────────────────────────────────────────────

export function decideFitnessQuestion(
  state: ConversationState,
  message: string,
  prevBotReply?: string,
): QuestionFlowDecision | null {
  if (state.flow !== "fitness") return null;
  if (!message) return null;

  const h = resolveHonorific(state.honorific);
  const ki = state.knownInfo;
  const stage = state.stage;
  const turn = state.turnCount;
  const m = message;
  const prev = (prevBotReply || "").toLowerCase();
  const askedGiamCanHistory = /biện pháp giảm cân/i.test(prev);

  // ─── EARLY: KH "muốn giảm cân" + chưa biết bộ môn + chưa hỏi history.
  // Áp dụng bất kể turn — kịch bản Fami: LUÔN hỏi history trước khi recommend.
  // Turn 1 (chưa chào) → kèm câu chào. Turn 2+ (đã chào) → vào thẳng câu hỏi history.
  if (isGiamCanIntro(m) && ki.serviceType === null && !askedGiamCanHistory) {
    const greeting =
      turn <= 1
        ? `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. `
        : `Dạ vâng ${h}, `;
    return {
      id: "giam_can_ask_history",
      template:
        greeting +
        `Không biết ${h} có đang tập luyện hay sử dụng biện pháp giảm cân nào không ạ.`,
      mustInclude: ["biện pháp giảm cân"],
    };
  }

  // ─── EARLY: KH hỏi "có ưu đãi/khuyến mãi gì không" + chưa biết bộ môn.
  // Áp dụng bất kể turn — kịch bản Fami: nói ưu đãi CHUNG (333k/tháng) + redirect hỏi BỘ MÔN,
  // KHÔNG bung 3 gói cụ thể khi chưa biết khách quan tâm bộ môn nào.
  if (isPriceOpening(m) && ki.serviceType === null) {
    const greeting =
      turn <= 1
        ? `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. `
        : `Dạ vâng ${h}, `;
    return {
      id: "uu_dai_ask_service",
      template:
        greeting +
        `Hiện tại trung tâm mở cửa từ 5h00 đến 20h30 tất cả các ngày, giá ưu đãi chỉ từ 333k/tháng. ` +
        `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn ưu đãi phù hợp ạ.`,
      mustInclude: ["333k", "20h30", "bộ môn nào"],
    };
  }

  // ─── OPENING patterns (turn 1 — chưa có gì)
  if (turn <= 1 && stage === "opening" && ki.serviceType === null) {
    // (1) "Tôi muốn tập trải nghiệm" — list dịch vụ + giờ mở
    if (isTrialIntro(m)) {
      return {
        id: "opening_trai_nghiem",
        template:
          `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
          `Bên em cung cấp rất nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
          `Không biết ${h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
        mustInclude: ["em chào", "khung giờ"],
      };
    }

    // (2) [moved] "Tôi muốn tập giảm cân" — xem block EARLY giam_can_ask_history phía trên.

    // (3) "Tư vấn cho tôi về chương trình tập luyện" — list 4 dịch vụ
    if (isChuongTrinhConsult(m)) {
      return {
        id: "opening_chuong_trinh",
        template:
          `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
          `Bên em hiện tại có rất nhiều bộ môn: Gym, Yoga, Zumba, Bơi. ` +
          `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ.`,
        mustInclude: ["em chào", "Gym", "Yoga", "Zumba", "Bơi", "bộ môn nào"],
      };
    }

    // (4) [moved] "có chương trình ưu đãi nào không?" — xem block EARLY uu_dai_ask_service phía trên.

    // (5) Greeting only ("Quan tâm", "alo") — hỏi bộ môn
    if (isGreetingOnly(m)) {
      return {
        id: "opening_greeting",
        template:
          `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
          `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ.`,
        mustInclude: ["em chào", "bộ môn nào"],
      };
    }

    // (6) "chưa biết tập gì, cho chị tham khảo" — hỏi history
    if (isChuaBietTapGi(m)) {
      return {
        id: "opening_chua_biet",
        template:
          `Dạ em chào ${h}, ${h} ơi trước đây mình đã từng tập bộ môn nào chưa ạ, ` +
          `hay là mình có yêu thích bộ môn nào không ạ.`,
        mustInclude: ["em chào", "đã từng tập"],
        mustNotInclude: ["Gym, Yoga, Zumba, Bơi"], // chưa list ở turn này
      };
    }
  }

  // ─── Continuous turn 2+: KH muốn trải nghiệm SAU khi đã chào
  // Theo TL2 kịch bản Fami: list 4 dịch vụ + giờ mở cửa + hỏi khung giờ.
  // KHÔNG hỏi "bộ môn nào" lại (T1 đã hỏi) — chuyển sang hỏi KHUNG GIỜ với
  // đầy đủ ngữ cảnh dịch vụ để khách biết bên em có gì.
  if (turn >= 2 && stage !== "commitment" && isTrialIntro(m) && ki.serviceType === null) {
    return {
      id: "trial_intro_followup",
      template:
        `Dạ vâng ${h}, bên em cung cấp nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
        `Không biết ${h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
      mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "khung giờ", "20h30"],
    };
  }

  // ─── KH "tham quan thôi" — list 4 dịch vụ + gói Full
  if (isThamQuan(m)) {
    return {
      id: "tham_quan",
      template:
        `Dạ vâng ${h}, bên em là Tổ hợp thể thao bao gồm Gym, Yoga, Zumba và Bơi, mỗi bộ môn sẽ có lợi ích riêng. ` +
        `Bên em cũng có gói Full đa năng bao gồm cả 4 dịch vụ để mình linh động đỡ nhàm chán. ` +
        `${h} đang thiên về mục tiêu nào để em tư vấn thêm ạ.`,
      mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "gói Full"],
    };
  }

  // ─── KH "đăng kí gói Full nhỉ?" — ACK + xin info
  if (isFullPackageConfirm(m)) {
    return {
      id: "full_package_confirm",
      template:
        `Dạ vâng ${h}, em thấy gói Full phù hợp với ${h} lắm — vì mỗi thời điểm mình sẽ có 1 mục tiêu khác nhau, tập đủ 4 dịch vụ rất linh động. ` +
        `Cho em xin tên, SĐT với ${h} muốn đến buổi sáng, chiều hay tối ạ.`,
      mustInclude: ["gói Full", "phù hợp", "tên", "SĐT"],
    };
  }

  // ─── BƠI: hỏi NL/TE
  if (ki.serviceType === "boi") {
    if (isBoiNlTeAsk(m)) {
      return {
        id: "boi_nl_te",
        template:
          `Dạ em chào ${h}, không biết ${h} đang quan tâm học bơi cho người lớn hay trẻ em ạ.`,
        mustInclude: ["người lớn", "trẻ em"],
      };
    }
    if (isBoiTreEmAsk(m) && !isChildAgeStated(m)) {
      return {
        id: "boi_tre_em",
        template:
          `Dạ để học bơi được hiệu quả, bên em sẽ nhận học sinh từ 6 tuổi. ` +
          `Không biết bạn nhà mình năm nay mấy tuổi rồi ạ.`,
        mustInclude: ["6 tuổi", "mấy tuổi"],
      };
    }
    if (isChildAgeStated(m)) {
      return {
        id: "boi_test_nuoc",
        template:
          `Dạ bên em nhận từ 6 tuổi, tuy nhiên để chương trình học đạt hiệu quả cao, ` +
          `bên em hỗ trợ test nước với các bạn nhỏ về mức độ bạo nước. ` +
          `Không biết bé nhà mình ở nhà có tắm được vòi sen hay đi bơi có dám ngụp nước không ạ.`,
        mustInclude: ["test nước", "bạo nước", "vòi sen", "ngụp nước"],
      };
    }
    // Bơi FAQ
    if (isPoolHoursAsk(m)) {
      return {
        id: "boi_faq_hours",
        template:
          `Dạ chào ${h}, bể bơi bên em mở cửa từ 6h sáng đến 20h hàng ngày ạ. ` +
          `${h} có thể đi bơi khung giờ nào ạ.`,
        mustInclude: ["6h", "20h"],
      };
    }
    if (isPoolWarmAsk(m)) {
      return {
        id: "boi_faq_4_mua",
        template:
          `Dạ bể bên em là bể bơi bốn mùa có mái che, mùa đông bể bên em có nước ấm ạ. ` +
          `Mình bơi quanh năm duy trì sức khỏe được ạ.`,
        mustInclude: ["bốn mùa", "mái che", "nước ấm"],
      };
    }
    if (isSwimwearAsk(m)) {
      return {
        id: "boi_faq_do_boi",
        template:
          `Dạ bên em không bắt buộc 100%, tuy nhiên mặc đồ bơi là cách để bảo vệ chính mình và những người đi bơi cùng. ` +
          `Bể bơi luôn sạch sẽ, mặc đồ bơi tránh được vụn vải, bụi bẩn vào nước. ` +
          `Em khuyến khích ${h} cứ bảo vệ mình đầu tiên ạ.`,
        mustInclude: ["đồ bơi", "khuyến khích", "bảo vệ"],
      };
    }
    if (isChlorineAsk(m)) {
      return {
        id: "boi_faq_clo",
        template:
          `Dạ Clo là một trong những loại hóa chất khử sạch, vệ sinh bể bơi. ` +
          `Bên em có sử dụng Clo ở mức tiêu chuẩn để khử khuẩn, đảm bảo nước sạch an toàn. ` +
          `Bộ phận kỹ thuật đo các chỉ số hàng ngày nên ${h} có thể yên tâm về chất lượng nước ạ.`,
        mustInclude: ["có sử dụng", "tiêu chuẩn", "khử khuẩn"],
        mustNotInclude: ["không dùng clo", "không có clo"],
      };
    }
    if (isWaterChangeAsk(m)) {
      return {
        id: "boi_faq_thay_nuoc",
        template:
          `Dạ bên em có bộ phận xử lý nước đúng tiêu chuẩn, và có thay nước định kỳ để đảm bảo chất lượng dịch vụ, ${h} yên tâm ạ.`,
        mustInclude: ["thay nước", "định kỳ"],
      };
    }
    if (isLifeguardAsk(m)) {
      return {
        id: "boi_faq_cuu_ho",
        template:
          `Dạ ${h} yên tâm, bể bơi bên em 100% có cứu hộ trên bờ để quan sát các bạn và xử lý các tình huống phát sinh ạ.`,
        mustInclude: ["cứu hộ", "trên bờ"],
      };
    }
    if (isPoolTrafficAsk(m)) {
      return {
        id: "boi_faq_vang_dong",
        template:
          `Dạ bể bơi bên em mùa này thường đều khách cả ngày, tuy nhiên nếu ${h} đi bơi được khung giờ 6-8h, 10-12h hoặc 19-20h thì sẽ đỡ đông hơn ạ.`,
        mustInclude: ["6-8h"],
      };
    }
    if (isPoolLimitAsk(m)) {
      return {
        id: "boi_faq_limit",
        template:
          `Dạ đối với thẻ bơi, bên em không giới hạn tần suất, tuy nhiên khuyến khích bơi 1 lượt/ngày, không quá 60 phút/lượt — vừa đủ để vận động mà không bị mất sức hay nhiễm lạnh ạ.`,
        mustInclude: ["không giới hạn", "1 lượt"],
      };
    }
  }

  // ─── ZUMBA flow
  if (ki.serviceType === "zumba") {
    // KH so sánh Zumba vs Aerobic
    if (isZumbaAerobicCompare(m)) {
      return {
        id: "zumba_vs_aerobic",
        template:
          `Dạ Zumba và Aerobic đều tập trên nền nhạc, tuy nhiên Zumba thiên về nhảy và cảm thụ âm nhạc hơn — đa dạng động tác, nhẹ nhàng uyển chuyển cũng có mà mạnh mẽ dứt khoát cũng có. ` +
          `Aerobic thiên về mạnh mẽ, cardio liên tục, sẽ khó theo hơn Zumba ạ. ` +
          `${h} qua thử 1 buổi Zumba xem phòng tập và giáo viên có phù hợp không nha.`,
        mustInclude: ["Aerobic", "nền nhạc", "nhảy"],
      };
    }
    // KH "Tập Zumba có giảm cân không?"
    if (isZumbaGiamCanAsk(m) && !isExplicitPriceList(m)) {
      return {
        id: "zumba_giam_can",
        template:
          `Dạ Zumba là một trong những bộ môn giảm mỡ toàn thân, săn chắc eo, đùi và bắp tay, đồng thời giúp xả stress, xóa tan năng lượng tiêu cực. ` +
          `${h} đang có nhu cầu giảm cân thì có thể kết hợp thêm 1-2 buổi Gym để có kết quả tốt nhất ạ.`,
        mustInclude: ["giảm mỡ", "săn chắc"],
      };
    }
  }

  // ─── KH hỏi "có được tập thử không?" — XÁC NHẬN trial (ưu tiên cao)
  if (isTrialAsk(m) && !isExplicitPriceList(m)) {
    return {
      id: "trial_ask_confirm",
      template:
        `Dạ bên em có ạ, em hỗ trợ ${h} tập thử 1 buổi để xem phòng tập và giáo viên có phù hợp không, sau đó mình cân đối các gói giá phù hợp ${h} ạ.`,
      mustInclude: ["bên em có", "tập thử 1 buổi"],
      note: "Yes/no confirmation. Câu mở đầu PHẢI là 'Dạ bên em có ạ' để xác nhận.",
    };
  }

  // ─── KH "ĐK trải nghiệm như thế nào?" — xin SĐT + khung giờ
  if (isHowToRegisterTrial(m) || (isTrialRegisterAsk(m) && !ki.phone)) {
    return {
      id: "trial_register",
      template:
        `Em gửi ${h} lịch tập các khung giờ. ${h} cho em xin SĐT và khung giờ tập để em đăng ký trải nghiệm và hỗ trợ thông tin cho ${h} nhé.`,
      mustInclude: ["SĐT", "khung giờ"],
    };
  }

  // ─── KH explicit hỏi list gói giá ("có những gói giá nào")
  if (isExplicitPriceList(m)) {
    const svcLabel =
      ki.serviceType === "zumba"
        ? "Zumba"
        : ki.serviceType === "yoga"
          ? "Yoga"
          : ki.serviceType === "boi"
            ? "Bơi"
            : ki.serviceType === "gym"
              ? "Gym"
              : "dịch vụ";
    const minPrice =
      ki.serviceType === "zumba"
        ? "375k"
        : ki.serviceType === "yoga"
          ? "350k"
          : "333k";
    return {
      id: "explicit_price_list",
      template:
        `Dạ vâng ${h}, về học phí, bên em có nhiều gói cho mình lựa chọn — theo tháng, quý, 6 tháng hoặc 1 năm tuỳ nhu cầu. ` +
        `Với ${svcLabel}, hiện tại bên em ưu đãi chỉ từ ${minPrice}/tháng thôi ạ.`,
      mustInclude: ["gói", "ưu đãi", minPrice],
    };
  }

  // ─── KH hỏi giá/tháng đầu tiên cho dịch vụ cụ thể (yoga/zumba) — báo giá ưu đãi + mời trải nghiệm
  if (
    isPriceQuestionPerMonth(m) &&
    (ki.serviceType === "yoga" || ki.serviceType === "zumba") &&
    !ki.phone &&
    !ki.name
  ) {
    const minPrice = ki.serviceType === "yoga" ? "350k" : "375k";
    return {
      id: "price_per_month_first",
      template:
        `Dạ hiện tại bên em có rất nhiều ưu đãi chỉ từ ${minPrice}/tháng. ` +
        `Vì ${h} là người mới, em tặng ${h} chương trình trải nghiệm thử để xem có phù hợp với bộ môn không. ` +
        `${h} có muốn đăng ký chương trình trải nghiệm không ạ.`,
      mustInclude: [minPrice, "trải nghiệm"],
    };
  }

  // ─── KH "chưa tập, có lớp cho người mới không em?" — trấn an theo dịch vụ
  if (isNewUserAsk(m)) {
    if (ki.serviceType === "yoga") {
      return {
        id: "yoga_tran_an",
        template:
          `Yoga là chuỗi các động tác bắt đầu từ hơi thở. Các động tác chậm và có sự hướng dẫn của HLV nên ${h} hoàn toàn yên tâm sẽ có thể tập bình thường ở lớp cộng đồng kể cả là người mới. ` +
          `Sau giờ tập em sẽ báo giáo viên hỗ trợ ${h} làm quen thêm 1 chút ạ.`,
        mustInclude: ["lớp cộng đồng", "HLV"],
      };
    }
    if (ki.serviceType === "zumba") {
      return {
        id: "zumba_tran_an",
        template:
          `Dạ Zumba là quá trình rèn luyện, ${h} yên tâm đừng lo không theo được. ` +
          `Khi mình tham gia lớp ở thời điểm này, có những bài tập đang được lớp duy trì — mình cố gắng tập theo. ` +
          `Trong giờ giải lao, cô giáo sẽ hỗ trợ thêm nếu mình cần. Còn những bài tập mới, cô sẽ hướng dẫn từng đoạn, từng động tác ạ.`,
        mustInclude: ["yên tâm", "cô giáo", "hỗ trợ"],
      };
    }
  }

  // ─── DISCOVERY: hỏi "đã tập X bao giờ chưa" — fire khi chưa hỏi experience cho bộ môn này.
  // Gate bằng prevBotReply (kiểm "đã tập <bộ môn>") thay vì turnCount — để cover cả case
  // KH đổi bộ môn giữa cuộc thoại (vd đang nói bơi → "tôi quan tâm gym" → fire gym_discovery).
  if (
    stage === "discovery" &&
    ki.serviceType !== null &&
    ki.fitnessGoal === null
  ) {
    const askedExperience = new RegExp(`đã tập ${ki.serviceType}`, "i").test(prev);
    if (!askedExperience) {
      if (ki.serviceType === "gym") {
        return {
          id: "gym_discovery",
          template:
            `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến bộ môn Gym của trung tâm. ` +
            `Không biết ${h} đã tập gym bao giờ chưa ạ.`,
          mustInclude: ["em chào", "đã tập gym"],
        };
      }
      if (ki.serviceType === "yoga") {
        return {
          id: "yoga_discovery",
          template:
            `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập yoga chưa ạ.`,
          mustInclude: ["đã tập yoga"],
        };
      }
      if (ki.serviceType === "zumba") {
        return {
          id: "zumba_discovery",
          template:
            `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập zumba chưa ạ.`,
          mustInclude: ["đã tập zumba"],
        };
      }
    }
  }

  // ─── GYM: KH trả lời "chưa tập bao giờ" → hỏi mục tiêu
  if (
    ki.serviceType === "gym" &&
    ki.fitnessGoal === null &&
    /^(chưa|không|chưa\s+từng|chưa\s+bao\s+giờ|mới\s+tập)/i.test(lc(m))
  ) {
    return {
      id: "gym_ask_goal",
      template:
        `Dạ em hiểu rồi ạ. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
      mustInclude: ["mục tiêu", "tăng cân", "giảm cân", "duy trì"],
    };
  }

  // ─── FULL: KH "sau khi giảm cân rồi, muốn duy trì" / "mất ngủ" — recommend Yoga
  if (isMaintainAfterGoal(m)) {
    return {
      id: "full_duy_tri_yoga",
      template:
        `Dạ nếu sau thời gian mình đã về số cân mong muốn, ${h} vẫn duy trì những bộ môn này nhẹ nhàng. ` +
        `Em chắc rằng lúc đó ${h} đã yêu ít nhất 2/3 bộ môn rồi ạ. ` +
        `${h} có thể kết hợp thêm Yoga thư giãn, giảm căng thẳng và có thể ngủ ngon hơn ạ.`,
      mustInclude: ["Yoga", "thư giãn"],
    };
  }

  // ─── FULL: KH hỏi "có ai hướng dẫn không?"
  if (isAskAboutGuidance(m) && !ki.preferredTime && !ki.name) {
    return {
      id: "full_hlv_support",
      template:
        `Dạ bên em có chứ ạ. Đối với người mới, tất cả các dịch vụ đều sẽ được sự hỗ trợ từ HLV và cả lớp, ${h} cứ yên tâm ạ.`,
      mustInclude: ["HLV", "hỗ trợ"],
    };
  }

  // ─── FULL: KH "đang béo quá, muốn giảm cân" — recommend Gym + Zumba (+ Bơi)
  // CHỈ fire khi đã qua opening (turn 2+) và chưa có serviceType (FULL flow)
  if (
    turn >= 2 &&
    ki.serviceType === null &&
    isGiamCanIntro(m) &&
    ki.fitnessGoal !== "giam-mo" // tránh trigger ở opening_giam_can
  ) {
    return {
      id: "full_giam_can_recommend",
      template:
        `Dạ vâng, đối với giảm cân, em khuyến khích ${h} nên tập kết hợp Gym và Zumba ạ. ` +
        `Nếu ${h} yêu thích bộ môn Bơi có thể kết hợp cả Bơi. ` +
        `3 bộ môn này đều đốt calo và săn chắc cơ thể, kết hợp với nhau sẽ đạt mục tiêu nhanh hơn. ` +
        `Ngoài ra, Zumba còn hỗ trợ ${h} xả stress, giúp có động lực tập luyện duy trì lâu dài ạ.`,
      mustInclude: ["Gym", "Zumba", "Bơi"],
    };
  }

  return null;
}

// ─────────────────────────────────────────────
// FORMAT DECISION → PREFIX BLOCK
// ─────────────────────────────────────────────

/**
 * Format quyết định thành 1 ANSWER_LOCK block.
 * Bot được instruct DUY NHẤT 1 việc: paraphrase template với phong cách Fami,
 * đảm bảo chứa các keyword bắt buộc.
 */
export function formatDecision(d: QuestionFlowDecision): string {
  const parts: string[] = [
    `[ANSWER_LOCK ${d.id}: BẮT BUỘC reply theo template dưới đây.`,
    `Cho phép paraphrase NHẸ (đổi vài từ nối, đảo thứ tự câu) để giọng tự nhiên,`,
    `nhưng KHÔNG được đổi ý chính, KHÔNG được thêm câu hỏi khác, KHÔNG bỏ thông tin.`,
    ``,
    `TEMPLATE:`,
    `"${d.template}"`,
    ``,
    `BẮT BUỘC reply chứa CÁC CỤM (nguyên văn): ${d.mustInclude.map((s) => `"${s}"`).join(", ")}.`,
  ];
  if (d.mustNotInclude && d.mustNotInclude.length > 0) {
    parts.push(
      `TUYỆT ĐỐI KHÔNG chứa: ${d.mustNotInclude.map((s) => `"${s}"`).join(", ")}.`,
    );
  }
  parts.push(
    `KHÔNG pitch 3 gói số giá, KHÔNG list dịch vụ khác ngoài template, KHÔNG hỏi tên/SĐT trừ khi template yêu cầu.]`,
  );
  return parts.join("\n");
}

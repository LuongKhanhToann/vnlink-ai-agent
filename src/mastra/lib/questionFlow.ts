/**
 * questionFlow.ts
 *
 * Decision engine — map state.intentTopic (do LLM classifier output) → reply template.
 *
 * KIẾN TRÚC:
 *   - LLM classifier (classifier.ts) phân loại MỖI tin nhắn thành 1 IntentTopic (hoặc null).
 *   - decideFitnessQuestion(state, message, prevBotReply) lookup TEMPLATES[intentTopic].
 *   - Mỗi template generator nhận (state, h, prevBotReply) và trả về 1 decision hoặc null.
 *   - Template có thể state-dependent (turn 1 vs turn 2+, đã hỏi history chưa, serviceType...).
 *
 * KHÔNG dùng regex match intent — đã chuyển hoàn toàn sang LLM (xem classifier.ts).
 * Chỉ giữ kiểm tra phrase trong prevBotReply để gate "đã hỏi câu này chưa" (deterministic state).
 */

import { ConversationState, IntentTopic, resolveHonorific } from "./stateMachine";

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

type TemplateGenerator = (
  state: ConversationState,
  h: string,
  prev: string,
  message: string,
) => QuestionFlowDecision | null;

// ─────────────────────────────────────────────
// HELPERS — state-based gating (KHÔNG regex match intent)
// ─────────────────────────────────────────────

function askedGiamCanHistory(prev: string): boolean {
  return /biện pháp giảm cân/i.test(prev);
}

function askedExperience(prev: string, service: string): boolean {
  return new RegExp(`đã tập ${service}`, "i").test(prev);
}

function svcLabel(service: string | null): string {
  switch (service) {
    case "zumba": return "Zumba";
    case "yoga": return "Yoga";
    case "boi": return "Bơi";
    case "gym": return "Gym";
    case "pilates": return "Pilates";
    default: return "dịch vụ";
  }
}

function minPriceFor(service: string | null): string {
  if (service === "zumba") return "375k";
  if (service === "yoga") return "350k";
  return "333k";
}

// Greeting prefix: turn 1 → kèm chào; turn 2+ → "Dạ vâng" ngắn.
function greetingPrefix(state: ConversationState, h: string): string {
  return state.turnCount <= 1
    ? `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. `
    : `Dạ vâng ${h}, `;
}

// KH vừa mention dịch vụ (yoga/zumba/gym) lần đầu, chưa hỏi experience, chưa có goal.
// → Ưu tiên discovery thay vì templates opening_* / generic.
function isFreshServiceDiscovery(
  state: ConversationState,
  prev: string,
): boolean {
  const svc = state.knownInfo.serviceType;
  if (!svc) return false;
  if (svc !== "yoga" && svc !== "zumba" && svc !== "gym") return false;
  if (state.knownInfo.fitnessGoal !== null) return false;
  // Đã có tên hoặc SĐT → KH đang ở giai đoạn chốt slot, KHÔNG quay lại discovery.
  if (state.knownInfo.name || state.knownInfo.phone) return false;
  if (askedExperience(prev, svc)) return false;
  return true;
}

// ─────────────────────────────────────────────
// TEMPLATE GENERATORS
// ─────────────────────────────────────────────

const TEMPLATES: Partial<Record<IntentTopic, TemplateGenerator>> = {
  // ── OPENING ──────────────────────────────
  // Khi KH đã mention dịch vụ cụ thể (yoga/zumba/gym) → yield cho discovery
  // (tránh classifier mis-label "Quan tâm zumba" → opening_chua_biet).
  opening_greeting: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    return {
      id: "opening_greeting",
      template:
        `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
        `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ.`,
      mustInclude: ["em chào", "bộ môn nào"],
    };
  },

  opening_chuong_trinh: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    return {
      id: "opening_chuong_trinh",
      template:
        `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
        `Bên em hiện tại có rất nhiều bộ môn: Gym, Yoga, Zumba, Bơi. ` +
        `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ.`,
      mustInclude: ["em chào", "Gym", "Yoga", "Zumba", "Bơi", "bộ môn nào"],
    };
  },

  opening_chua_biet: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    return {
      id: "opening_chua_biet",
      template:
        `Dạ em chào ${h}, ${h} ơi trước đây mình đã từng tập bộ môn nào chưa ạ, ` +
        `hay là mình có yêu thích bộ môn nào không ạ.`,
      mustInclude: ["em chào", "đã từng tập"],
      mustNotInclude: ["Gym, Yoga, Zumba, Bơi"],
    };
  },

  tham_quan: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    return {
      id: "tham_quan",
      template:
        `Dạ vâng ${h}, bên em là Tổ hợp thể thao bao gồm Gym, Yoga, Zumba và Bơi, mỗi bộ môn sẽ có lợi ích riêng. ` +
        `Bên em cũng có gói Full đa năng bao gồm cả 4 dịch vụ để mình linh động đỡ nhàm chán. ` +
        `${h} đang thiên về mục tiêu nào để em tư vấn thêm ạ.`,
      mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "gói Full"],
    };
  },

  // ── INTRO ────────────────────────────────
  intro_trai_nghiem: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    if (s.turnCount <= 1) {
      // Turn 1: list 4 dịch vụ + giờ mở (kịch bản TL2)
      return {
        id: "intro_trai_nghiem_t1",
        template:
          `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến dịch vụ của trung tâm. ` +
          `Bên em cung cấp rất nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
          `Không biết ${h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
        mustInclude: ["em chào", "Gym", "Yoga", "Zumba", "Bơi", "khung giờ", "20h30"],
      };
    }
    if (s.knownInfo.serviceType !== null) return null; // đã biết bộ môn → fallback
    return {
      id: "intro_trai_nghiem_followup",
      template:
        `Dạ vâng ${h}, bên em cung cấp nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
        `Không biết ${h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
      mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "khung giờ", "20h30"],
    };
  },

  intro_giam_can: (s, h, prev) => {
    // Context: KH đã ở tham_quan (bot đã list 4 dịch vụ + gói Full) — KHÔNG hỏi history nữa,
    // recommend thẳng giải pháp Gym+Zumba+Bơi theo TL Fami.
    const inThamQuanContext =
      /Tổ hợp/i.test(prev) || /gói Full/i.test(prev);
    if (inThamQuanContext) {
      return {
        id: "giam_can_recommend_solution",
        template:
          `Dạ vâng ${h}, đối với giảm cân em khuyến khích mình kết hợp Gym và Zumba ạ. ` +
          `Nếu ${h} thích Bơi có thể kết hợp thêm Bơi — 3 bộ môn này đều đốt calo và săn chắc cơ thể, kết hợp với nhau sẽ đạt mục tiêu nhanh hơn. ` +
          `Zumba còn giúp xả stress để mình duy trì lâu dài ạ.`,
        mustInclude: ["Gym", "Zumba", "Bơi"],
      };
    }
    // Chưa biết bộ môn + chưa hỏi history → hỏi history (TL Fami kịch bản)
    if (s.knownInfo.serviceType === null && !askedGiamCanHistory(prev)) {
      return {
        id: "giam_can_ask_history",
        template:
          greetingPrefix(s, h) +
          `Không biết ${h} có đang tập luyện hay sử dụng biện pháp giảm cân nào không ạ.`,
        mustInclude: ["biện pháp giảm cân"],
      };
    }
    return null; // fallback (LLM tự pitch giải pháp theo EXAMPLE)
  },

  intro_uu_dai: (s, h, prev) => {
    if (isFreshServiceDiscovery(s, prev)) return null;
    if (s.knownInfo.serviceType !== null) return null; // đã biết bộ môn → fallback
    return {
      id: "uu_dai_ask_service",
      template:
        greetingPrefix(s, h) +
        `Hiện tại trung tâm mở cửa từ 5h00 đến 20h30 tất cả các ngày, giá ưu đãi chỉ từ 333k/tháng. ` +
        `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn ưu đãi phù hợp ạ.`,
      mustInclude: ["333k", "20h30", "bộ môn nào"],
    };
  },

  // ── TRIAL ────────────────────────────────
  trial_ask_confirm: (_s, h) => ({
    id: "trial_ask_confirm",
    template:
      `Dạ bên em có ạ, em hỗ trợ ${h} tập thử 1 buổi để xem phòng tập và giáo viên có phù hợp không, ` +
      `sau đó mình cân đối các gói giá phù hợp ${h} ạ.`,
    mustInclude: ["bên em có", "tập thử 1 buổi"],
    note: "Yes/no confirmation. Câu mở đầu PHẢI là 'Dạ bên em có ạ' để xác nhận.",
  }),

  trial_register_how: (_s, h) => ({
    id: "trial_register_how",
    template:
      `Em gửi ${h} lịch tập các khung giờ. ` +
      `${h} cho em xin SĐT và khung giờ tập để em đăng ký trải nghiệm và hỗ trợ thông tin cho ${h} nhé.`,
    mustInclude: ["SĐT", "khung giờ"],
  }),

  // ── DISCOVERY / LỚP HỌC ─────────────────
  no_experience: (s, h) => {
    // KH trả lời "chưa tập bao giờ" — branch theo serviceType
    if (s.knownInfo.serviceType === "gym" && s.knownInfo.fitnessGoal === null) {
      return {
        id: "gym_ask_goal",
        template:
          `Dạ em hiểu rồi ạ. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
        mustInclude: ["mục tiêu", "tăng cân", "giảm cân", "duy trì"],
      };
    }
    if (s.knownInfo.serviceType === "yoga") {
      return {
        id: "yoga_tran_an",
        template:
          `Yoga là chuỗi các động tác bắt đầu từ hơi thở. ` +
          `Các động tác chậm và có sự hướng dẫn của HLV nên ${h} hoàn toàn yên tâm sẽ có thể tập bình thường ở lớp cộng đồng kể cả là người mới. ` +
          `Sau giờ tập em sẽ báo giáo viên hỗ trợ ${h} làm quen thêm 1 chút ạ.`,
        mustInclude: ["lớp cộng đồng", "HLV"],
      };
    }
    if (s.knownInfo.serviceType === "zumba") {
      return {
        id: "zumba_tran_an",
        template:
          `Dạ Zumba là quá trình rèn luyện, ${h} yên tâm đừng lo không theo được. ` +
          `Khi mình tham gia lớp ở thời điểm này, có những bài tập đang được lớp duy trì — mình cố gắng tập theo. ` +
          `Trong giờ giải lao, cô giáo sẽ hỗ trợ thêm nếu mình cần. ` +
          `Còn những bài tập mới, cô sẽ hướng dẫn từng đoạn, từng động tác ạ.`,
        mustInclude: ["yên tâm", "cô giáo", "hỗ trợ"],
      };
    }
    return null;
  },

  // KH trả lời "đã từng tập rồi" — TL Fami: bước tiếp theo của TL1 là TL2 hỏi mục tiêu.
  // Branch theo bộ môn (gym ask goal, yoga/zumba hỏi schedule trial-first).
  has_experience: (s, h) => {
    const svc = s.knownInfo.serviceType;
    if (svc === "gym" && s.knownInfo.fitnessGoal === null) {
      return {
        id: "gym_ask_goal_yes",
        template:
          `Dạ vâng ${h}. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
        mustInclude: ["mục tiêu", "tăng cân", "giảm cân", "duy trì"],
      };
    }
    if (svc === "yoga") {
      return {
        id: "yoga_experienced_ask_schedule",
        template:
          `Dạ vâng ${h} đã có kinh nghiệm yoga rồi nha. ${h} tiện đi tập buổi sáng hay chiều ạ.`,
        mustInclude: ["sáng", "chiều"],
      };
    }
    if (svc === "zumba") {
      return {
        id: "zumba_experienced_ask_schedule",
        template:
          `Dạ vâng ${h} đã có kinh nghiệm zumba rồi nha. ${h} tiện đi tập buổi sáng hay chiều ạ.`,
        mustInclude: ["sáng", "chiều"],
      };
    }
    // Bộ môn khác / chưa biết → ack ngắn + hỏi mục tiêu chung
    return null;
  },

  // ── LOGISTICS ────────────────────────────
  // KH hỏi giờ mở cửa / "khi nào qua được". Phải answer 5h–20h30 + mời ghé buổi.
  // CẤM list 3 gói (đã từng fail khi stage=evaluation override bằng EXAMPLE).
  ask_open_hours: (_s, h) => ({
    id: "ask_open_hours",
    template:
      `Dạ trung tâm bên em mở cửa từ 5h sáng đến 20h30 tất cả các ngày ạ. ${h} tiện ghé buổi sáng hay chiều ạ.`,
    mustInclude: ["5h", "20h30", "sáng", "chiều"],
  }),

  new_class_inquiry: (s, h) => {
    // "có lớp cho người mới không" — trấn an theo dịch vụ
    if (s.knownInfo.serviceType === "yoga") {
      return {
        id: "yoga_new_class",
        template:
          `Yoga là chuỗi các động tác bắt đầu từ hơi thở. ` +
          `Các động tác chậm và có sự hướng dẫn của HLV nên ${h} hoàn toàn yên tâm sẽ có thể tập bình thường ở lớp cộng đồng kể cả là người mới. ` +
          `Sau giờ tập em sẽ báo giáo viên hỗ trợ ${h} làm quen thêm 1 chút ạ.`,
        mustInclude: ["lớp cộng đồng", "HLV"],
      };
    }
    if (s.knownInfo.serviceType === "zumba") {
      return {
        id: "zumba_new_class",
        template:
          `Dạ Zumba là quá trình rèn luyện, ${h} yên tâm đừng lo không theo được. ` +
          `Khi mình tham gia lớp, có những bài tập lớp đang duy trì — mình cố gắng tập theo, cô giáo sẽ hỗ trợ thêm nếu cần. ` +
          `Bài tập mới cô sẽ hướng dẫn từng đoạn từng động tác ạ.`,
        mustInclude: ["yên tâm", "cô giáo"],
      };
    }
    return null;
  },

  class_has_newbies: (s, h) => {
    if (s.knownInfo.serviceType !== "zumba" && s.knownInfo.serviceType !== "yoga") {
      return null;
    }
    return {
      id: "class_has_newbies",
      template:
        `Dạ lớp bên em tuyển sinh liên tục, nên ở thời điểm nào cũng sẽ có 1 vài người mới vào, ` +
        `có thể là chỉ trước mình 1-2 buổi thôi ${h} ạ.`,
      mustInclude: ["tuyển sinh liên tục", "1-2 buổi"],
    };
  },

  // ── BƠI ──────────────────────────────────
  pool_audience_ask: (_s, h) => ({
    id: "pool_audience_ask",
    template:
      `Dạ em chào ${h}, không biết ${h} đang quan tâm học bơi cho người lớn hay trẻ em ạ.`,
    mustInclude: ["người lớn", "trẻ em"],
  }),

  pool_child_no_age: (_s, h) => ({
    id: "pool_child_no_age",
    template:
      `Dạ để học bơi được hiệu quả, bên em sẽ nhận học sinh từ 6 tuổi. ` +
      `Không biết bạn nhà mình năm nay mấy tuổi rồi ${h} ạ.`,
    mustInclude: ["6 tuổi", "mấy tuổi"],
  }),

  pool_child_with_age: (_s, h) => ({
    id: "pool_child_with_age",
    template:
      `Dạ bên em nhận từ 6 tuổi, tuy nhiên để chương trình học đạt hiệu quả cao, ` +
      `bên em hỗ trợ test nước với các bạn nhỏ về mức độ bạo nước. ` +
      `Không biết bé nhà mình ở nhà có tắm được vòi sen hay đi bơi có dám ngụp nước không ${h} ạ.`,
    mustInclude: ["test nước", "bạo nước", "vòi sen", "ngụp nước"],
  }),

  pool_hours: (_s, h) => ({
    id: "pool_hours",
    template:
      `Dạ chào ${h}, bể bơi bên em mở cửa từ 6h sáng đến 20h hàng ngày ạ. ` +
      `${h} có thể đi bơi khung giờ nào ạ.`,
    mustInclude: ["6h", "20h"],
  }),

  pool_temperature: (_s, h) => ({
    id: "pool_temperature",
    template:
      `Dạ bể bên em là bể bơi bốn mùa có mái che, mùa đông bể bên em có nước ấm ${h} ạ. ` +
      `Mình bơi quanh năm duy trì sức khỏe được ạ.`,
    mustInclude: ["bốn mùa", "mái che", "nước ấm"],
  }),

  pool_swimwear: (_s, h) => ({
    id: "pool_swimwear",
    template:
      `Dạ bên em không bắt buộc 100%, tuy nhiên mặc đồ bơi là cách để bảo vệ chính mình và những người đi bơi cùng. ` +
      `Bể bơi luôn sạch sẽ, mặc đồ bơi tránh được vụn vải, bụi bẩn vào nước. ` +
      `Em khuyến khích ${h} cứ bảo vệ mình đầu tiên ạ.`,
    mustInclude: ["đồ bơi", "khuyến khích", "bảo vệ"],
  }),

  pool_chlorine: (_s, h) => ({
    id: "pool_chlorine",
    template:
      `Dạ Clo là một trong những loại hóa chất khử sạch, vệ sinh bể bơi. ` +
      `Bên em có sử dụng Clo ở mức tiêu chuẩn để khử khuẩn, đảm bảo nước sạch an toàn. ` +
      `Bộ phận kỹ thuật đo các chỉ số hàng ngày nên ${h} có thể yên tâm về chất lượng nước ạ.`,
    mustInclude: ["có sử dụng", "tiêu chuẩn", "khử khuẩn"],
    mustNotInclude: ["không dùng clo", "không có clo"],
  }),

  pool_water_change: (_s, h) => ({
    id: "pool_water_change",
    template:
      `Dạ bên em có bộ phận xử lý nước đúng tiêu chuẩn, và có thay nước định kỳ để đảm bảo chất lượng dịch vụ, ${h} yên tâm ạ.`,
    mustInclude: ["thay nước", "định kỳ"],
  }),

  pool_lifeguard: (_s, h) => ({
    id: "pool_lifeguard",
    template:
      `Dạ ${h} yên tâm, bể bơi bên em 100% có cứu hộ trên bờ để quan sát các bạn và xử lý các tình huống phát sinh ạ.`,
    mustInclude: ["cứu hộ", "trên bờ"],
  }),

  pool_traffic: (_s, h) => ({
    id: "pool_traffic",
    template:
      `Dạ bể bơi bên em mùa này thường đều khách cả ngày, ` +
      `tuy nhiên nếu ${h} đi bơi được khung giờ 6-8h, 10-12h hoặc 19-20h thì sẽ đỡ đông hơn ạ.`,
    mustInclude: ["6-8h"],
  }),

  pool_limit: (_s, h) => ({
    id: "pool_limit",
    template:
      `Dạ đối với thẻ bơi, bên em không giới hạn tần suất, ` +
      `tuy nhiên khuyến khích bơi 1 lượt/ngày, không quá 60 phút/lượt — vừa đủ để vận động mà không bị mất sức hay nhiễm lạnh ${h} ạ.`,
    mustInclude: ["không giới hạn", "1 lượt"],
  }),

  // ── ZUMBA ────────────────────────────────
  // Guard: chỉ fire khi message THỰC SỰ nhắc "aerobic" — tránh classifier mis-label
  // "Quan tâm zumba" thành zumba_vs_aerobic.
  zumba_vs_aerobic: (_s, h, _prev, message) => {
    if (!/aerobic/i.test(message)) return null;
    return {
      id: "zumba_vs_aerobic",
      template:
        `Dạ Zumba và Aerobic đều tập trên nền nhạc, tuy nhiên Zumba thiên về nhảy và cảm thụ âm nhạc hơn — ` +
        `đa dạng động tác, nhẹ nhàng uyển chuyển cũng có mà mạnh mẽ dứt khoát cũng có. ` +
        `Aerobic thiên về mạnh mẽ, cardio liên tục, sẽ khó theo hơn Zumba ạ. ` +
        `${h} qua thử 1 buổi Zumba xem phòng tập và giáo viên có phù hợp không nha.`,
      mustInclude: ["Aerobic", "nền nhạc", "nhảy"],
    };
  },

  // Guard: chỉ fire khi message thực sự hỏi giảm cân (tránh mis-label).
  zumba_weight_loss: (_s, h, _prev, message) => {
    if (!/(giảm\s*(cân|mỡ|béo)|đốt\s*mỡ|béo)/i.test(message)) return null;
    return {
      id: "zumba_weight_loss",
      template:
        `Dạ Zumba là một trong những bộ môn giảm mỡ toàn thân, săn chắc eo, đùi và bắp tay, ` +
        `đồng thời giúp xả stress, xóa tan năng lượng tiêu cực. ` +
        `${h} đang có nhu cầu giảm cân thì có thể kết hợp thêm 1-2 buổi Gym để có kết quả tốt nhất ạ.`,
      mustInclude: ["giảm mỡ", "săn chắc"],
    };
  },

  // ── PRICING ──────────────────────────────
  price_with_worry: (_s, h) => ({
    id: "price_with_worry",
    template:
      `Dạ bên em có các gói giá từ 6 đến 12 tháng ${h} ạ. ` +
      `Nếu ${h} sợ không theo được, cứ thử 1 buổi xem nhé, 90% các bác sau khi thử là nghiện đấy ạ.`,
    mustInclude: ["6", "12 tháng", "thử 1 buổi", "90%"],
  }),

  price_explicit_list: (s, h) => {
    const label = svcLabel(s.knownInfo.serviceType);
    const minPrice = minPriceFor(s.knownInfo.serviceType);
    return {
      id: "price_explicit_list",
      template:
        `Dạ vâng ${h}, về học phí, bên em có nhiều gói cho mình lựa chọn — theo tháng, quý, 6 tháng hoặc 1 năm tuỳ nhu cầu. ` +
        `Với ${label}, hiện tại bên em ưu đãi chỉ từ ${minPrice}/tháng thôi ạ.`,
      mustInclude: ["gói", "ưu đãi", minPrice],
    };
  },

  price_ask_generic: (s, h) => {
    // Yoga/Zumba lần đầu (chưa có name/phone) → báo giá ưu đãi + mời trải nghiệm
    if (
      (s.knownInfo.serviceType === "yoga" || s.knownInfo.serviceType === "zumba") &&
      !s.knownInfo.name &&
      !s.knownInfo.phone
    ) {
      const minPrice = minPriceFor(s.knownInfo.serviceType);
      return {
        id: "price_per_month_first",
        template:
          `Dạ hiện tại bên em có rất nhiều ưu đãi chỉ từ ${minPrice}/tháng. ` +
          `Vì ${h} là người mới, em tặng ${h} chương trình trải nghiệm thử để xem có phù hợp với bộ môn không. ` +
          `${h} có muốn đăng ký chương trình trải nghiệm không ạ.`,
        mustInclude: [minPrice, "trải nghiệm"],
      };
    }
    // Chưa biết bộ môn → ưu đãi chung + hỏi bộ môn
    if (s.knownInfo.serviceType === null) {
      return {
        id: "price_ask_no_service",
        template:
          greetingPrefix(s, h) +
          `Hiện tại trung tâm mở cửa từ 5h00 đến 20h30 tất cả các ngày, giá ưu đãi chỉ từ 333k/tháng. ` +
          `Không biết ${h} đang quan tâm đến bộ môn nào để em tư vấn ưu đãi phù hợp ạ.`,
        mustInclude: ["333k", "bộ môn nào"],
      };
    }
    return null;
  },

  // ── PACKAGE / GOAL ───────────────────────
  full_package_confirm: (s, h) => {
    // Đã có tên + SĐT → KHÔNG xin lại; hỏi luôn khung giờ để chốt slot.
    if (s.knownInfo.name && s.knownInfo.phone) {
      return {
        id: "full_package_ask_time",
        template:
          `Dạ vâng ${h} ${s.knownInfo.name}, gói Full rất phù hợp với mình ạ. ` +
          `${h} muốn đến buổi sáng, chiều hay tối để em giữ slot ạ.`,
        mustInclude: ["gói Full", "sáng", "chiều", "tối"],
      };
    }
    return {
      id: "full_package_confirm",
      template:
        `Dạ vâng ${h}, em thấy gói Full phù hợp với ${h} lắm — vì mỗi thời điểm mình sẽ có 1 mục tiêu khác nhau, tập đủ 4 dịch vụ rất linh động. ` +
        `Cho em xin tên, SĐT với ${h} muốn đến buổi sáng, chiều hay tối ạ.`,
      mustInclude: ["gói Full", "phù hợp", "tên", "SĐT"],
    };
  },

  maintain_after_goal: (_s, h) => ({
    id: "maintain_after_goal",
    template:
      `Dạ nếu sau thời gian mình đã về số cân mong muốn, ${h} vẫn duy trì những bộ môn này nhẹ nhàng. ` +
      `Em chắc rằng lúc đó ${h} đã yêu ít nhất 2/3 bộ môn rồi ạ. ` +
      `${h} có thể kết hợp thêm Yoga thư giãn, giảm căng thẳng và có thể ngủ ngon hơn ạ.`,
    mustInclude: ["Yoga", "thư giãn"],
  }),

  guidance_ask: (s, h) => {
    // Chỉ fire khi chưa chốt lịch / chưa có tên
    if (s.knownInfo.preferredTime || s.knownInfo.name) return null;
    return {
      id: "guidance_ask",
      template:
        `Dạ bên em có chứ ạ. Đối với người mới, tất cả các dịch vụ đều sẽ được sự hỗ trợ từ HLV và cả lớp, ${h} cứ yên tâm ạ.`,
      mustInclude: ["HLV", "hỗ trợ"],
    };
  },

  combo_service_ask: (_s, h) => ({
    id: "combo_service_ask",
    template:
      `Dạ nếu ${h} có nhu cầu, bên em cũng có gói kết hợp cho mình tập đa dịch vụ ạ. ` +
      `Mình sắp xếp thời gian qua bên em xem trực tiếp ạ.`,
    mustInclude: ["gói kết hợp", "sắp xếp"],
  }),

  // ── SWITCH SERVICE ───────────────────────
  // Khi LLM classify switch_service → kết hợp với slot extraction (serviceType mới)
  // và logic switch trong stateMachine.buildNextState (đã reset slots phụ thuộc).
  // Template ở đây = discovery turn của bộ môn mới.
  switch_service: (s, h, prev) => {
    if (s.knownInfo.serviceType === "gym" && !askedExperience(prev, "gym")) {
      return {
        id: "gym_discovery_after_switch",
        template:
          `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến bộ môn Gym của trung tâm. ` +
          `Không biết ${h} đã tập gym bao giờ chưa ạ.`,
        mustInclude: ["em chào", "đã tập gym"],
      };
    }
    if (s.knownInfo.serviceType === "yoga" && !askedExperience(prev, "yoga")) {
      return {
        id: "yoga_discovery_after_switch",
        template:
          `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập yoga chưa ạ.`,
        mustInclude: ["đã tập yoga"],
      };
    }
    if (s.knownInfo.serviceType === "zumba" && !askedExperience(prev, "zumba")) {
      return {
        id: "zumba_discovery_after_switch",
        template:
          `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập zumba chưa ạ.`,
        mustInclude: ["đã tập zumba"],
      };
    }
    return null;
  },
};

// ─────────────────────────────────────────────
// DISCOVERY FALLBACK — fire khi vừa biết serviceType nhưng chưa hỏi experience
// (vd KH mới nói "tôi quan tâm gym" → topic null, nhưng cần fire gym_discovery).
// Trigger điều kiện: stage=discovery, serviceType known, goal null, chưa hỏi "đã tập X".
// ─────────────────────────────────────────────

function fallbackDiscoveryAfterServiceMention(
  state: ConversationState,
  h: string,
  prev: string,
): QuestionFlowDecision | null {
  if (state.stage !== "discovery") return null;
  if (state.knownInfo.serviceType === null) return null;
  if (state.knownInfo.fitnessGoal !== null) return null;
  // Đã thu được tên hoặc SĐT → không quay lại hỏi discovery (đang chốt slot).
  if (state.knownInfo.name || state.knownInfo.phone) return null;
  const svc = state.knownInfo.serviceType;

  // ── BƯỚC 2: prev đã hỏi experience, KH đã trả lời (classifier không bắt
  // được no_experience / has_experience topic vì câu trả lời mơ hồ). Fire
  // ask-goal cho gym hoặc ask-schedule cho yoga/zumba theo TL Fami.
  if (askedExperience(prev, svc)) {
    if (svc === "gym") {
      return {
        id: "gym_ask_goal_after_experience",
        template:
          `Dạ vâng ${h}. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
        mustInclude: ["mục tiêu", "tăng cân", "giảm cân", "duy trì"],
      };
    }
    if (svc === "yoga" || svc === "zumba") {
      return {
        id: `${svc}_ask_schedule_after_experience`,
        template:
          `Dạ vâng ${h}. ${h} tiện đi tập buổi sáng hay chiều ạ.`,
        mustInclude: ["sáng", "chiều"],
      };
    }
    return null;
  }

  // ── BƯỚC 1: chưa hỏi experience → fire câu hỏi discovery theo bộ môn.
  if (svc === "gym") {
    return {
      id: "gym_discovery",
      template:
        `Dạ em chào ${h}, cảm ơn ${h} đã quan tâm đến bộ môn Gym của trung tâm. ` +
        `Không biết ${h} đã tập gym bao giờ chưa ạ.`,
      mustInclude: ["em chào", "đã tập gym"],
    };
  }
  if (svc === "yoga") {
    return {
      id: "yoga_discovery",
      template: `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập yoga chưa ạ.`,
      mustInclude: ["đã tập yoga"],
    };
  }
  if (svc === "zumba") {
    return {
      id: "zumba_discovery",
      template: `Dạ em chào ${h}, ${h} ơi trước đây ${h} đã tập zumba chưa ạ.`,
      mustInclude: ["đã tập zumba"],
    };
  }
  return null;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

export function decideFitnessQuestion(
  state: ConversationState,
  message: string,
  prevBotReply?: string,
): QuestionFlowDecision | null {
  if (state.flow !== "fitness") return null;
  if (!message) return null;

  const h = resolveHonorific(state.honorific);
  const prev = prevBotReply || "";

  // Ưu tiên cao nhất: đã đủ tên + SĐT + giờ → CHỐT SLOT, KHÔNG hỏi gì nữa.
  if (
    state.knownInfo.name &&
    state.knownInfo.phone &&
    state.knownInfo.preferredTime
  ) {
    return {
      id: "close_slot_confirm",
      template:
        `Dạ em giữ slot ${state.knownInfo.preferredTime} cho mình rồi nha ${h} ${state.knownInfo.name}, hẹn gặp ${h} ạ.`,
      mustInclude: ["giữ slot", "hẹn gặp"],
    };
  }

  // Đã có tên + SĐT nhưng thiếu giờ → hỏi khung giờ, KHÔNG hỏi gì khác.
  if (
    state.knownInfo.name &&
    state.knownInfo.phone &&
    !state.knownInfo.preferredTime
  ) {
    return {
      id: "ask_time_after_name_phone",
      template:
        `Dạ vâng ${h} ${state.knownInfo.name}, ${h} tiện đến buổi sáng, chiều hay tối để em giữ slot ạ.`,
      mustInclude: ["sáng", "chiều", "tối"],
    };
  }

  // Override: nếu KH nhắc "aerobic" trực tiếp (so sánh với Zumba) → force topic.
  // Classifier có khi miss topic này khi cùng tin có cả "giảm cân" lẫn "aerobic".
  if (
    /aerobic/i.test(message) &&
    (state.knownInfo.serviceType === "zumba" || !state.knownInfo.serviceType)
  ) {
    const zumbaCmp = TEMPLATES.zumba_vs_aerobic;
    if (zumbaCmp) {
      const decision = zumbaCmp(state, h, prev, message);
      if (decision) return decision;
    }
  }

  // 1. Lookup topic-based template
  if (state.intentTopic) {
    const generator = TEMPLATES[state.intentTopic];
    if (generator) {
      const decision = generator(state, h, prev, message);
      if (decision) return decision;
    }
  }

  // 2. Fallback: vừa biết serviceType nhưng chưa hỏi experience → discovery question
  return fallbackDiscoveryAfterServiceMention(state, h, prev);
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

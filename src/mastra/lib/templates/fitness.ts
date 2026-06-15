/**
 * templates/fitness.ts — Stage-aware templates cho FitnessAgent (Phase 2 migrate).
 *
 * MIGRATION STATUS: incremental. Templates được migrate dần từ questionFlow.TEMPLATES (legacy)
 * sang format mới với declarative `stages` filter + cleaner guards.
 *
 * Mỗi template:
 *   - id unique
 *   - match: stage filter + topic/signal match
 *   - guards (optional): cross-turn checks không liên quan stage
 *   - render: nội dung template + mustInclude
 *
 * Lookup: findTemplate(FITNESS_TEMPLATES, ctx) trả về RenderedTemplate đầu tiên match.
 */

import type { Template, TemplateContext } from "./engine";

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function greetingPrefix(ctx: TemplateContext): string {
  return ctx.state.turnCount <= 1
    ? `Dạ em chào ${ctx.h}, cảm ơn ${ctx.h} đã quan tâm đến dịch vụ của trung tâm. `
    : `Dạ vâng ${ctx.h}, `;
}

function alreadyRecommendedSolution(prev: string): boolean {
  if (!prev) return false;
  return /(kết\s*hợp\s+Gym\s+và\s+Zumba|Gym\s+và\s+Zumba|PT\s+1-?1|Yoga\s+GV\s+Ấn|lớp\s+1-?1\s+12\s+buổi|thẻ\s+Full\s+4\s+dịch\s+vụ|đã\s+gợi\s+(gói|combo)\s+(phù\s+hợp|Gym))/i.test(
    prev,
  );
}

/**
 * Anti-repeat cho các template SAFETY (postpartum/prenatal/senior/post-surgery/teen):
 * 1 đoạn trấn an dài CHỈ nói 1 lần. Lượt sau khách hỏi follow-up cùng chủ đề mà lại
 * bắn NGUYÊN VĂN đoạn cũ → lộ máy rõ nhất (HARD-LOOP). Đọc state.safetyTopicsCovered (sticky
 * TOÀN cuộc thoại, không chỉ turn liền trước) → nếu đã trấn an chủ đề này thì skip để engine
 * rớt xuống PITCH cho LLM trả lời ngắn, sát ngữ cảnh.
 */
function safetyAlreadyCovered(ctx: TemplateContext, topic: string): boolean {
  return (ctx.state.safetyTopicsCovered ?? []).includes(topic);
}

// ─────────────────────────────────────────────
// FITNESS TEMPLATES — stage-aware
// ─────────────────────────────────────────────

export const FITNESS_TEMPLATES: Template[] = [
  // ═══════════ OPENING ═══════════
  // Lưu ý thứ tự: templates cụ thể (attribute=browsing) PHẢI đứng TRƯỚC opening_greeting
  // generic (match all greeting). Không thì opening_greeting eat browsing case.
  {
    id: "opening_greeting",
    match: {
      flow: "fitness",
      stages: ["opening"],
      domain: "greeting",
      attribute: ["general_hi", "show_interest"], // KHÔNG match "browsing" — để tham_quan handle
    },
    guards: (ctx) => {
      // Skip nếu memberType set → để prefix builder pitch family/student
      if (ctx.state.knownInfo.memberType !== null) {
        return { skip: true, reason: "memberType set, để prefix pitch riêng" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "opening_greeting",
      template:
        greetingPrefix(ctx) +
        `Không biết ${ctx.h} đang quan tâm đến bộ môn nào để em tư vấn hỗ trợ ạ.`,
      mustInclude:
        ctx.state.turnCount <= 1 ? ["em chào", "bộ môn nào"] : ["bộ môn nào"],
    }),
  },

  // ═══════════ DISCOVERY ANSWER — INDECISIVE ═══════════
  {
    id: "indecisive_pick_for_me",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "discovery_answer",
      attribute: "indecisive_pick_for_me",
    },
    guards: (ctx) => {
      // Yêu cầu message có cue indecisive THẬT (deterministic check) — chống mini mis-label
      const hasIndecisiveCue =
        /(chọn\s*(giúp|hộ|cho)|tư\s*vấn\s+(cho|giúp)|chưa\s+biết|không\s+biết\s+(tập|chọn|môn)|gợi\s*ý)/i.test(
          ctx.message || "",
        );
      if (!hasIndecisiveCue)
        return { skip: true, reason: "thiếu indecisive cue trong message" };
      return true;
    },
    render: (ctx) => {
      const goal = ctx.state.knownInfo.fitnessGoal;
      const h = ctx.h;
      // Đã recommend rồi mà KH VẪN nhờ tư vấn ("chọn giúp em") →
      if (alreadyRecommendedSolution(ctx.prevReply)) {
        // Đã có giờ / tên+SĐT → KH đi tiếp được, nudge nhẹ về trải nghiệm.
        if (
          ctx.state.knownInfo.preferredTime ||
          (ctx.state.knownInfo.name && ctx.state.knownInfo.phone)
        ) {
          return {
            id: "indecisive_after_recommended_invite",
            template: `Dạ vâng ${h}, ${h} tiện ghé buổi sáng hay chiều để em hỗ trợ đo InBody miễn phí và xem trực tiếp phòng tập ạ.`,
            mustInclude: ["sáng", "chiều"],
          };
        }
        // KH vẫn phân vân, xin chọn LẠI → TÁI KHẲNG ĐỊNH gợi ý dứt khoát theo goal
        // (KHÔNG đẩy lịch "sáng hay chiều" — sale thật phải chốt giúp khách đang lưỡng lự).
        const reaffirm: Record<string, { pick: string; must: string[] }> = {
          "giam-mo": { pick: "Gym kết hợp Zumba", must: ["Gym", "Zumba"] },
          "tang-co": { pick: "Gym kèm PT 1-1", must: ["Gym", "PT"] },
          "tang-can": { pick: "Gym kèm PT 1-1", must: ["Gym", "PT"] },
          "thu-gian": { pick: "Yoga", must: ["Yoga"] },
          "hoc-boi": { pick: "lớp bơi 1-1", must: ["bơi"] },
          "giu-dang": { pick: "thẻ Full đa năng (Gym, Bơi, Yoga, Zumba dùng chung 1 thẻ)", must: ["Full"] },
        };
        const r = (goal && reaffirm[goal]) || {
          pick: "thẻ Full đa năng (Gym, Bơi, Yoga, Zumba dùng chung 1 thẻ)",
          must: ["Full"],
        };
        return {
          id: "indecisive_reaffirm_recommend",
          template:
            `Dạ ${h} cứ bắt đầu với ${r.pick} như em gợi là hợp mục tiêu của mình nhất ạ. ` +
            `${h} ghé thử 1 buổi cảm nhận rồi quyết cũng được ạ.`,
          mustInclude: r.must,
        };
      }
      if (goal === "giam-mo") {
        return {
          id: "indecisive_recommend_giam_mo",
          template:
            `Dạ với mục tiêu giảm cân, em gợi ${h} bắt đầu với Gym kết hợp Zumba ạ — Gym đốt calo săn chắc cơ, Zumba thì vui nên dễ theo lâu dài, thích thì thêm Bơi cũng tốt. ` +
            `${h} ghé thử 1 buổi cảm nhận phòng tập với giáo viên rồi mình tính gói sau cũng được, ${h} tiện sáng hay chiều ạ?`,
          mustInclude: ["Gym", "Zumba"],
        };
      }
      if (goal === "tang-co") {
        return {
          id: "indecisive_recommend_tang_co",
          template:
            `Dạ với mục tiêu tăng cơ, em gợi ${h} tập Gym kèm PT 1-1 giai đoạn đầu ạ — HLV xây kỹ thuật nền chuẩn, tránh sai tư thế rồi quen tay ${h} tự tập sau. ` +
            `${h} ghé đo InBody miễn phí 1 buổi để HLV xem thể trạng rồi tư vấn lộ trình nha, ${h} tiện sáng hay chiều ạ?`,
          mustInclude: ["PT", "Gym"],
        };
      }
      if (goal === "tang-can") {
        return {
          id: "indecisive_recommend_tang_can",
          template:
            `Dạ với mục tiêu tăng cân, em gợi ${h} tập Gym kèm PT 1-1 ạ — HLV lên giáo án tăng khối cơ nạc + thực đơn 5-6 bữa dễ ăn, tăng cân khoa học không tích mỡ bụng. ` +
            `${h} ghé đo InBody miễn phí 1 buổi để HLV xem lượng cơ thiếu rồi tư vấn lộ trình nha, ${h} tiện sáng hay chiều ạ?`,
          mustInclude: ["PT", "Gym"],
        };
      }
      if (goal === "giu-dang") {
        return {
          id: "indecisive_recommend_giu_dang",
          template:
            `Dạ với mục tiêu giữ dáng, em gợi ${h} thẻ Full đa năng ạ — Gym, Bơi, Yoga, Zumba dùng chung 1 thẻ, đổi môn cho đỡ chán mà duy trì vóc dáng săn chắc. ` +
            `${h} ghé thử 1 buổi cảm nhận phòng tập rồi mình tính gói sau cũng được, ${h} tiện sáng hay chiều ạ?`,
          mustInclude: ["Full"],
        };
      }
      if (goal === "thu-gian") {
        return {
          id: "indecisive_recommend_thu_gian",
          template:
            `Dạ với mục tiêu thư giãn giảm stress, em gợi ${h} tập Yoga với GV người Ấn Độ ạ — động tác chậm theo hơi thở, giãn cơ, ngủ ngon hơn, rất hợp người hay căng thẳng công việc. ` +
            `${h} tiện đi tập buổi sáng hay chiều để em xếp lớp cho mình ạ?`,
          mustInclude: ["Yoga"],
        };
      }
      if (goal === "hoc-boi") {
        return {
          id: "indecisive_recommend_hoc_boi",
          template:
            `Dạ với học bơi, em gợi ${h} lớp 1-1 để HLV kèm sát, cam kết biết bơi sau khóa ạ — bể 4 mùa duy nhất Vĩnh Yên, mùa đông vẫn có nước ấm nên bơi quanh năm được. ` +
            `${h} muốn học cho người lớn hay trẻ em để em tư vấn đúng lớp ạ?`,
          mustInclude: ["bơi", "1-1"],
        };
      }
      // Default: Full đa năng
      return {
        id: "indecisive_recommend_full",
        template:
          `Dạ để em gợi cho ${h} thẻ Full đa năng ạ — Gym, Bơi, Yoga, Zumba dùng chung 1 thẻ, hôm nào thích môn nào thì tập môn đó cho đỡ chán. ` +
          `${h} ghé thử 1 buổi cảm nhận trước rồi mình tính gói sau nha, ${h} tiện sáng hay chiều ạ?`,
        mustInclude: ["Full", "Gym"],
      };
    },
  },

  // ═══════════ PRICING — STUDENT ═══════════
  {
    id: "ask_student_pricing",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation", "negotiation"],
      domain: "pricing",
      attribute: "ask_price_student",
    },
    guards: (ctx) => {
      // Anti-loop: prev đã pitch HS/SV → KHÔNG fire lại template y hệt
      if (/báo\s*giá\s*HS\/SV|check\s*thẻ\s*HS\/SV/i.test(ctx.prevReply || "")) {
        return { skip: true, reason: "prev đã pitch student pricing" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_student_pricing",
      template:
        `Dạ với học sinh / sinh viên, bên em có ưu đãi riêng tuỳ thời điểm ${ctx.h} ạ. ` +
        `${ctx.h} cho em xin SĐT để em báo lại bộ phận sale gửi báo giá HS/SV cụ thể, ` +
        `hoặc ${ctx.h} ghé trực tiếp em check thẻ HS/SV để áp ưu đãi nha.`,
      mustInclude: ["học sinh", "ưu đãi"],
    }),
  },

  // ═══════════ POOL — CHILD AGE ═══════════
  {
    id: "pool_child_no_age",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_no_age",
    },
    guards: (ctx) => {
      // Skip nếu age đã được nhắc (current message / prev bot / prev user message)
      const ageRe = /\b\d{1,2}\s*(tuổi|t)\b/i;
      if (ageRe.test(ctx.message)) {
        return { skip: true, reason: "age trong current message" };
      }
      if (ageRe.test(ctx.prevReply || "")) {
        return { skip: true, reason: "age trong prev bot reply" };
      }
      if (ageRe.test(ctx.prevUserMessage || "")) {
        return { skip: true, reason: "age trong prev user message" };
      }
      return true;
    },
    render: (ctx) => {
      // Nếu bot đã hỏi tuổi lần trước nhưng KH không cho → pivot sang test bạo nước
      if (/mấy\s*tuổi/i.test(ctx.prevReply || "")) {
        return {
          id: "pool_child_no_age_after_asked",
          template:
            `Dạ ${ctx.h} ơi, ở nhà bé có dám ngụp nước hay tắm vòi sen không ạ. ` +
            `Bên em test bạo nước trước để chọn lớp phù hợp.`,
          mustInclude: ["ngụp nước", "vòi sen"],
        };
      }
      return {
        id: "pool_child_no_age",
        template:
          `Dạ để học bơi được hiệu quả, bên em sẽ nhận học sinh từ 6 tuổi. ` +
          `Không biết bạn nhà mình năm nay mấy tuổi rồi ${ctx.h} ạ.`,
        mustInclude: ["6 tuổi", "mấy tuổi"],
      };
    },
  },

  // ═══════════ DISCOVERY — GIAM-CAN INTRO ═══════════
  {
    id: "intro_giam_can",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "discovery_answer",
      attribute: "goal_lose_weight",
    },
    guards: (ctx) => {
      // GUARD A: state past discovery → KHÔNG hỏi history nữa
      const ki = ctx.state.knownInfo;
      if (
        ki.schedule ||
        ki.serviceType ||
        ki.preferredTime ||
        ki.memberType ||
        (ctx.state.flowTurnCount ?? ctx.state.turnCount) >= 3
      ) {
        return { skip: true, reason: "past discovery — đã có slot" };
      }
      // GUARD A0: mục tiêu KHÔNG phải giảm cân (vd tăng cân/giữ dáng/tăng cơ) → KHÔNG hỏi
      // "biện pháp giảm cân" (sai + ngượng). classifier mini hay gắn nhầm attribute=goal_lose_weight
      // cho tin "tăng cân" (đều có chữ "cân"). fitnessGoal slot đã extract đúng → tin cậy goal.
      // Skip → tin rơi xuống PITCH mode → goalConsult khai thác đúng theo goal.
      if (ki.fitnessGoal !== null && ki.fitnessGoal !== "giam-mo") {
        return { skip: true, reason: `goal=${ki.fitnessGoal} không phải giảm cân` };
      }
      // GUARD B: health context (postpartum/prenatal/đau lưng) → để LLM handle natural
      const isHealthContext =
        /(mới\s*sinh|sau\s*sinh|đang\s*bầu|mang\s*thai|sinh\s*con|cho\s*con\s*bú|cao\s*tuổi|bệnh\s*nền|huyết\s*áp|tiểu\s*đường|phẫu\s*thuật|chấn\s*thương|đau\s*(lưng|gối|khớp))/i;
      if (isHealthContext.test(ctx.message)) {
        return { skip: true, reason: "health context — để LLM xử lý" };
      }
      // GUARD C: schedule cue → KHÔNG hỏi history, để LLM ack + pitch
      const hasScheduleCue =
        /(sáng|chiều|tối|trưa|\d+\s*buổi|mỗi\s*tuần|tuần\s*\d|hàng\s*ngày)/i.test(
          ctx.message || "",
        );
      if (hasScheduleCue) {
        return { skip: true, reason: "schedule cue trong message" };
      }
      return true;
    },
    render: (ctx) => {
      const h = ctx.h;
      const m = (ctx.message || "").toLowerCase();
      const prev = ctx.prevReply || "";
      // Đã recommend rồi → return invite
      if (alreadyRecommendedSolution(prev)) {
        if (
          ctx.state.knownInfo.preferredTime ||
          (ctx.state.knownInfo.name && ctx.state.knownInfo.phone)
        ) {
          // Fall-through to LLM — return empty-ish that anti-loop will skip
          // Actually we need to return SOMETHING. Use generic invite.
          return {
            id: "giam_can_after_recommended_invite",
            template: `Dạ vâng ${h}, ${h} tiện ghé buổi sáng hay chiều để em hỗ trợ đo InBody miễn phí và xem trực tiếp phòng tập ạ.`,
            mustInclude: ["sáng", "chiều"],
          };
        }
      }
      // KH chủ động xin tư vấn / báo giá / chọn giúp → skip history, recommend NGAY
      const askingRecommend =
        /tư\s*vấn|báo\s*(giá|chi\s*phí|phí)|gợi\s*ý|chọn\s*(giúp|hộ|cho)|môn\s*nào\s*phù\s*hợp|dịch\s*vụ\s*phù\s*hợp/.test(
          m,
        );
      // FUNNEL TL Fami: KH nêu GOAL rõ → KHAI THÁC NỖI ĐAU/lịch sử TRƯỚC (xuống block ask_history),
      // KHÔNG recommend value-first ngay (nhảy bước = bỏ cớ tư vấn sâu, lộ máy). CHỈ recommend NGAY khi
      // khách CHỦ ĐỘNG xin tư vấn/chọn giúp (askingRecommend) hoặc đang trong mạch tham quan.
      const inThamQuanContext = /Tổ\s*hợp\s*thể\s*thao/i.test(prev);
      if (inThamQuanContext || askingRecommend) {
        return {
          id: "giam_can_recommend_solution",
          template:
            `Dạ vâng ${h}, để giảm cân em gợi mình kết hợp Gym và Zumba ạ — cả hai đều đốt calo, săn chắc cơ thể, Zumba còn vui giúp mình giữ động lực lâu dài. ` +
            `Thích thì thêm Bơi cũng tốt vì bơi là cardio toàn thân. ${h} ghé thử 1 buổi cảm nhận trước rồi mình tính gói sau nha, ${h} tiện sáng hay chiều ạ?`,
          mustInclude: ["Gym", "Zumba", "Bơi"],
        };
      }
      // Chưa biết bộ môn + chưa hỏi history → hỏi history
      const askedHistory = /biện\s*pháp\s*giảm\s*cân/i.test(prev);
      if (ctx.state.knownInfo.serviceType === null && !askedHistory) {
        return {
          id: "giam_can_ask_history",
          template:
            greetingPrefix(ctx) +
            `Không biết ${h} có đang tập luyện hay sử dụng biện pháp giảm cân nào không ạ.`,
          mustInclude: ["biện pháp giảm cân"],
        };
      }
      // Đã hỏi history rồi → fallback recommend nhẹ
      return {
        id: "giam_can_recommend_solution",
        template:
          `Dạ vâng ${h}, để giảm cân em gợi mình kết hợp Gym và Zumba cho đốt mỡ tốt mà đỡ chán ạ. ` +
          `${h} ghé thử 1 buổi cảm nhận phòng tập rồi mình tính tiếp nha, ${h} tiện sáng hay chiều ạ?`,
        mustInclude: ["Gym", "Zumba"],
      };
    },
  },

  // ═══════════ YOGA ═══════════
  {
    id: "yoga_new_class_inquiry",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "service_inquiry",
      service: "yoga",
      attribute: "ask_new_class",
    },
    render: (ctx) => ({
      id: "yoga_new_class_inquiry",
      template:
        `Dạ Yoga là chuỗi các động tác bắt đầu từ hơi thở. Các động tác chậm và có HLV hướng dẫn nên ${ctx.h} hoàn toàn yên tâm tập được ở lớp cộng đồng kể cả người mới. ` +
        `Sau giờ tập em sẽ báo giáo viên hỗ trợ ${ctx.h} làm quen thêm ạ.`,
      mustInclude: ["hơi thở", "HLV", "yên tâm"],
    }),
  },

  // ═══════════ ZUMBA ═══════════
  {
    id: "zumba_new_class_inquiry",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "service_inquiry",
      service: "zumba",
      attribute: "ask_new_class",
    },
    render: (ctx) => ({
      id: "zumba_new_class_inquiry",
      template:
        `Dạ Zumba là quá trình rèn luyện ${ctx.h} ạ, nên ${ctx.h} yên tâm, đừng lo là không theo được. ` +
        `Vào lớp lúc này có bài đang được lớp duy trì, mình cố gắng tập theo. Trong giờ giải lao cô giáo sẽ hỗ trợ thêm nếu cần. ` +
        `Còn bài tập mới, cô hướng dẫn từng đoạn, từng động tác ạ.`,
      mustInclude: ["rèn luyện", "cô giáo"],
    }),
  },
  {
    id: "zumba_class_composition",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "zumba",
      attribute: "ask_class_composition",
    },
    render: (ctx) => ({
      id: "zumba_class_composition",
      template:
        `Dạ lớp bên em tuyển sinh liên tục, nên ở thời điểm nào cũng sẽ có 1 vài người mới vào — có thể chỉ trước mình 1-2 buổi thôi ${ctx.h} ạ.`,
      mustInclude: ["tuyển sinh", "người mới"],
    }),
  },
  {
    id: "zumba_weight_loss_combo",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "zumba",
      attribute: "ask_zumba_weight_loss",
    },
    render: (ctx) => ({
      id: "zumba_weight_loss_combo",
      template:
        `Dạ Zumba là một trong những bộ môn có thể giảm mỡ toàn thân ạ. Zumba còn giúp săn chắc eo, đùi và bắp tay, giảm stress giúp xóa tan năng lượng tiêu cực. ` +
        `${ctx.h} đang có nhu cầu giảm cân có thể kết hợp thêm 1-2 buổi Gym để có kết quả tốt nhất ạ.`,
      mustInclude: ["giảm mỡ", "Gym"],
    }),
  },
  {
    id: "zumba_vs_aerobic",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "zumba",
      attribute: "compare_zumba_aerobic",
    },
    render: (ctx) => ({
      id: "zumba_vs_aerobic",
      template:
        `Dạ Zumba và Aerobic đều là bộ môn tập trên nền nhạc, tuy nhiên Zumba thiên về nhảy và cảm thụ âm nhạc hơn — đa dạng động tác, nhẹ nhàng uyển chuyển cũng có mà mạnh mẽ dứt khoát cũng có. ` +
        `Aerobic thiên về mạnh mẽ, cardio liên tục, sẽ khó theo hơn Zumba ạ. ` +
        `${ctx.h} qua thử 1 buổi Zumba xem phòng tập và giáo viên có phù hợp không ạ.`,
      mustInclude: ["Aerobic", "Zumba", "nền nhạc"],
    }),
  },

  // ═══════════ SHARE-PACKAGE ═══════════
  // KH hỏi "mua 1 gói dùng cho 2 người / tích lượt / dùng chung thẻ".
  // Theo TL Fami: KHÔNG hỗ trợ — pivot sang gói cá nhân hoặc gói gia đình.
  // Fire khi message có cue rõ. Đặt trước pool templates để bắt trước generic.
  {
    id: "ask_share_package",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
    },
    guards: (ctx) => {
      const m = (ctx.message || "").toLowerCase();
      // Cue: "X người" + "1 gói/thẻ" trong cùng tin, hoặc explicit share keywords.
      const explicitShare =
        /(dùng\s*chung\s*(thẻ|gói)|chia\s*(thẻ|gói)|tích\s*lượt|chung\s*1\s*(thẻ|gói)|sử\s*dụng\s*chung)/i;
      const oneToMany =
        /(1\s*(gói|thẻ).{0,30}\d+\s*người|\d+\s*người.{0,30}1\s*(gói|thẻ))/i;
      if (!explicitShare.test(m) && !oneToMany.test(m))
        return { skip: true, reason: "không có cue share package" };
      return true;
    },
    render: (ctx) => ({
      id: "ask_share_package",
      template:
        `Dạ bên em chưa có chương trình hỗ trợ tích lượt hay dùng chung 1 thẻ như vậy ${ctx.h} ạ. ` +
        `${ctx.h} cho em xin nhu cầu của gia đình mình, em sẽ tư vấn gói phù hợp với cá nhân — gói cá nhân hiện tại cũng ưu đãi lắm ${ctx.h} ạ.`,
      mustInclude: ["chưa có", "tích lượt", "cá nhân"],
    }),
  },

  // ═══════════ POOL — facility FAQs ═══════════
  {
    id: "pool_temperature",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_temperature",
    },
    render: (ctx) => ({
      id: "pool_temperature",
      template:
        `Dạ bể bên em là bể bơi bốn mùa có mái che, mùa đông bể bên em có nước ấm ${ctx.h} ạ. ` +
        `Mình bơi quanh năm duy trì sức khỏe được ạ.`,
      mustInclude: ["bốn mùa", "nước ấm"],
    }),
  },
  {
    id: "pool_swimwear",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_swimwear",
    },
    render: (ctx) => ({
      id: "pool_swimwear",
      template:
        `Dạ bên em không bắt buộc 100%, tuy nhiên mặc đồ bơi là cách để bảo vệ chính mình và những người đi bơi cùng. ` +
        `Bể bơi luôn sạch sẽ, mặc đồ bơi tránh vụn vải, bụi bẩn vào nước. ` +
        `Em khuyến khích ${ctx.h} cứ bảo vệ mình đầu tiên ạ.`,
      mustInclude: ["đồ bơi", "bảo vệ"],
    }),
  },
  {
    id: "pool_chlorine",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_chlorine",
    },
    render: (ctx) => ({
      id: "pool_chlorine",
      template:
        `Dạ Clo là một loại hóa chất khử sạch, vệ sinh bể bơi. ` +
        `Bên em có sử dụng Clo ở mức tiêu chuẩn để khử khuẩn, đảm bảo nước sạch an toàn. ` +
        `Bộ phận kỹ thuật đo các chỉ số hàng ngày nên ${ctx.h} có thể yên tâm về chất lượng nước ạ.`,
      mustInclude: ["có sử dụng", "tiêu chuẩn", "khử khuẩn"],
      mustNotInclude: ["không dùng clo", "không có clo"],
    }),
  },
  {
    id: "pool_water_change",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_water_change",
    },
    render: (ctx) => ({
      id: "pool_water_change",
      template:
        `Dạ bên em có bộ phận xử lý nước đúng tiêu chuẩn, và có thay nước định kỳ để đảm bảo chất lượng dịch vụ, ${ctx.h} yên tâm ạ.`,
      mustInclude: ["thay nước", "định kỳ"],
    }),
  },
  {
    id: "pool_lifeguard",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_lifeguard",
    },
    render: (ctx) => ({
      id: "pool_lifeguard",
      template:
        `Dạ ${ctx.h} yên tâm, bể bơi bên em 100% có cứu hộ trên bờ để quan sát các bạn và xử lý các tình huống phát sinh ạ.`,
      mustInclude: ["cứu hộ", "trên bờ"],
    }),
  },
  {
    id: "pool_traffic",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_traffic",
    },
    render: (ctx) => ({
      id: "pool_traffic",
      template:
        `Dạ bể bơi bên em mùa này thường đều khách cả ngày, tuy nhiên nếu ${ctx.h} đi bơi được khung giờ 6-8h, 10-12h hoặc 19-20h thì sẽ đỡ đông hơn ạ.`,
      mustInclude: ["6-8h"],
    }),
  },
  {
    id: "pool_limit",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_limit",
    },
    render: (ctx) => ({
      id: "pool_limit",
      template:
        `Dạ đối với thẻ bơi, bên em không giới hạn tần suất, ` +
        `tuy nhiên khuyến khích bơi 1 lượt/ngày, không quá 60 phút/lượt — vừa đủ để vận động mà không bị mất sức hay nhiễm lạnh ${ctx.h} ạ.`,
      mustInclude: ["không giới hạn", "1 lượt"],
    }),
  },
  {
    id: "pool_hours",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_hours",
    },
    render: (ctx) => ({
      id: "pool_hours",
      template:
        `${ctx.state.turnCount <= 1 ? `Dạ em chào ${ctx.h}, ` : "Dạ "}bể bơi bên em mở cửa từ 6h sáng đến 20h hàng ngày ạ. ${ctx.h} có thể đi bơi khung giờ nào ạ.`,
      mustInclude: ["6h", "20h"],
    }),
  },
  {
    id: "pool_child_with_age",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_with_age",
    },
    render: (ctx) => ({
      id: "pool_child_with_age",
      template:
        `Dạ bên em nhận từ 6 tuổi, tuy nhiên để chương trình học đạt hiệu quả cao, ` +
        `bên em hỗ trợ test nước với các bạn nhỏ về mức độ bạo nước. ` +
        `Không biết bé nhà mình ở nhà có dám tắm vòi sen hay đi bơi có dám ngụp nước không ${ctx.h} ạ.`,
      mustInclude: ["test nước", "bạo nước"],
    }),
  },

  // ═══════════ FAQ — guidance / maintain / combo ═══════════
  {
    id: "guidance_ask",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_pt_guidance",
    },
    render: (ctx) => ({
      id: "guidance_ask",
      template:
        `Dạ bên em có chứ ạ. Đối với người mới tất cả các dịch vụ đều được sự hỗ trợ từ HLV và cả lớp, ${ctx.h} cứ yên tâm ạ.`,
      mustInclude: ["HLV"],
    }),
  },
  {
    id: "maintain_after_goal",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
      domain: "discovery_answer",
      attribute: "ask_maintain_after_goal",
    },
    render: (ctx) => ({
      id: "maintain_after_goal",
      template:
        `Dạ sau thời gian mình đã về số cân mong muốn, mình vẫn duy trì những bộ môn này nhẹ nhàng. ` +
        `Lúc đó ${ctx.h} có thể kết hợp thêm Yoga để thư giãn, giảm căng thẳng và ngủ ngon hơn ạ.`,
      mustInclude: ["duy trì", "Yoga"],
    }),
  },

  // ═══════════ PROMO ═══════════
  {
    id: "intro_uu_dai",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "pricing",
      attribute: "ask_promo",
    },
    guards: (ctx) => {
      // Nếu đã có serviceType → bot pitch giá cụ thể theo service (qua PITCH mode).
      if (ctx.state.knownInfo.serviceType !== null) {
        return { skip: true, reason: "đã có service → PITCH cụ thể" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "intro_uu_dai",
      template:
        `Dạ hiện tại trung tâm mở cửa từ 5h00 đến 20h30 tất cả các ngày, giá ưu đãi chỉ từ 333k/tháng ${ctx.h} ạ. ` +
        `Không biết ${ctx.h} đang quan tâm đến bộ môn nào để em tư vấn ưu đãi phù hợp ạ.`,
      mustInclude: ["333k", "bộ môn nào"],
    }),
  },

  // ═══════════ THAM QUAN ═══════════
  {
    id: "tham_quan",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "greeting",
      attribute: "browsing",
    },
    render: (ctx) => ({
      id: "tham_quan",
      template:
        `Dạ vâng ${ctx.h}, bên em là Tổ hợp thể thao bao gồm Gym, Yoga, Zumba và Bơi, mỗi bộ môn sẽ có lợi ích riêng. ` +
        `Bên em cũng có gói Full đa năng bao gồm cả 4 dịch vụ để mình linh động đỡ nhàm chán. ` +
        `${ctx.h} đang thiên về mục tiêu nào để em tư vấn thêm ạ.`,
      mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "gói Full"],
    }),
  },

  // ═══════════ TRIAL ═══════════
  {
    id: "intro_trai_nghiem",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "scheduling",
      attribute: "register_trial",
    },
    render: (ctx) => {
      if (ctx.state.turnCount <= 1) {
        return {
          id: "intro_trai_nghiem_t1",
          template:
            `Dạ em chào ${ctx.h}, cảm ơn ${ctx.h} đã quan tâm đến dịch vụ của trung tâm. ` +
            `Bên em cung cấp rất nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
            `Không biết ${ctx.h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
          mustInclude: ["em chào", "Gym", "Yoga", "Zumba", "Bơi", "khung giờ", "20h30"],
        };
      }
      return {
        id: "intro_trai_nghiem_followup",
        template:
          `Dạ vâng ${ctx.h}, bên em cung cấp nhiều dịch vụ: Gym, Yoga, Zumba, Bơi, phòng tập mở cửa từ 5h00 đến 20h30. ` +
          `Không biết ${ctx.h} có thể đi tập được khung giờ nào để em hỗ trợ tư vấn ạ.`,
        mustInclude: ["Gym", "Yoga", "Zumba", "Bơi", "khung giờ", "20h30"],
      };
    },
  },
  {
    id: "trial_ask_confirm",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "scheduling",
      attribute: "ask_trial_confirm",
    },
    render: (ctx) => {
      // Service-specific class times (theo TL Fami zumba: 5h sáng và 18h chiều).
      const svc = ctx.state.knownInfo.serviceType;
      if (svc === "zumba") {
        return {
          id: "trial_ask_confirm_zumba",
          template:
            `Dạ bên em có ạ, em hỗ trợ mình tập thử 1 buổi để xem phòng tập và giáo viên bên em có phù hợp với mình hay không, sau đó cân đối các gói giá phù hợp ạ. ` +
            `Em đang có lớp 5h sáng và 18h chiều, ${ctx.h} có thể tham gia 2 lớp này chứ ạ.`,
          mustInclude: ["tập thử", "5h sáng", "18h chiều"],
        };
      }
      return {
        id: "trial_ask_confirm",
        template:
          `Dạ bên em có ạ. Em hỗ trợ mình tập thử 1 buổi để xem phòng tập và giáo viên bên em có phù hợp với mình hay không, sau đó cân đối các gói giá phù hợp ạ. ` +
          `${ctx.h} tiện ghé buổi sáng hay chiều ạ.`,
        mustInclude: ["tập thử", "1 buổi"],
      };
    },
  },

  // ═══════════ TRIAL — register how ═══════════
  {
    id: "trial_register_how",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation", "negotiation"],
      domain: "scheduling",
      attribute: "ask_trial_register_how",
    },
    render: (ctx) => ({
      id: "trial_register_how",
      template:
        `Em gửi ${ctx.h} lịch tập các khung giờ. ` +
        `${ctx.h} cho em xin SĐT và khung giờ tập để em đăng ký trải nghiệm và hỗ trợ thông tin cho ${ctx.h} nhé.`,
      mustInclude: ["SĐT", "khung giờ"],
    }),
  },

  // ═══════════ DISCOVERY ANSWERS — has/no experience ═══════════
  {
    id: "no_experience",
    match: {
      flow: "fitness",
      stages: ["discovery"],
      domain: "discovery_answer",
      attribute: "no_experience",
    },
    render: (ctx) => {
      const svc = ctx.state.knownInfo.serviceType;
      const h = ctx.h;
      if (svc === "gym" && ctx.state.knownInfo.fitnessGoal === null) {
        return {
          id: "gym_ask_goal",
          template: `Dạ em hiểu rồi ạ. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
          mustInclude: ["mục tiêu", "tăng cân", "giảm cân", "duy trì"],
        };
      }
      if (svc === "yoga") {
        return {
          id: "yoga_tran_an",
          template:
            `Yoga là chuỗi các động tác bắt đầu từ hơi thở. Các động tác chậm và có sự hướng dẫn của HLV nên ${h} hoàn toàn yên tâm sẽ có thể tập bình thường ở lớp cộng đồng kể cả là người mới. ` +
            `Sau giờ tập em sẽ báo giáo viên hỗ trợ ${h} làm quen thêm 1 chút ạ.`,
          mustInclude: ["lớp cộng đồng", "HLV"],
        };
      }
      if (svc === "zumba") {
        return {
          id: "zumba_tran_an",
          template:
            `Dạ Zumba là quá trình rèn luyện, ${h} yên tâm đừng lo không theo được. ` +
            `Khi tham gia lớp ở thời điểm này, có bài tập đang được lớp duy trì — mình cố gắng tập theo. Trong giờ giải lao cô giáo sẽ hỗ trợ thêm nếu cần. ` +
            `Còn bài tập mới, cô sẽ hướng dẫn từng đoạn, từng động tác ạ.`,
          mustInclude: ["yên tâm", "cô giáo"],
        };
      }
      return {
        id: "no_experience_generic",
        template: `Dạ vâng ${h}, bên em có HLV hỗ trợ người mới ở tất cả các bộ môn nên ${h} cứ yên tâm tập ạ.`,
        mustInclude: ["HLV", "yên tâm"],
      };
    },
  },
  {
    id: "has_experience",
    match: {
      flow: "fitness",
      stages: ["discovery"],
      domain: "discovery_answer",
      attribute: "has_experience",
    },
    render: (ctx) => {
      const svc = ctx.state.knownInfo.serviceType;
      const h = ctx.h;
      if (svc === "gym" && ctx.state.knownInfo.fitnessGoal === null) {
        return {
          id: "gym_ask_goal_yes",
          template: `Dạ vâng ${h}. Mục tiêu tập gym của mình là tăng cân, giảm cân hay duy trì sức khoẻ ạ.`,
          mustInclude: ["mục tiêu", "tăng cân", "giảm cân"],
        };
      }
      if (svc === "yoga") {
        return {
          id: "yoga_experienced_ask_schedule",
          template: `Dạ vâng ${h} đã có kinh nghiệm yoga rồi nha. ${h} tiện đi tập buổi sáng hay chiều ạ.`,
          mustInclude: ["sáng", "chiều"],
        };
      }
      if (svc === "zumba") {
        return {
          id: "zumba_experienced_ask_schedule",
          template: `Dạ vâng ${h} đã có kinh nghiệm zumba rồi nha. ${h} tiện đi tập buổi sáng hay chiều ạ.`,
          mustInclude: ["sáng", "chiều"],
        };
      }
      return null;
    },
  },

  // ═══════════ FACILITY / LOGISTICS ═══════════
  {
    id: "ask_open_hours",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_facility_hours",
    },
    guards: (ctx) => {
      // pool-specific giờ → để pool_hours handle (đứng trước trong array)
      if (ctx.state.knownInfo.serviceType === "boi") return { skip: true, reason: "delegate to pool_hours" };
      return true;
    },
    render: (ctx) => ({
      id: "ask_open_hours",
      template: `Dạ trung tâm bên em mở cửa từ 5h sáng đến 20h30 tất cả các ngày ạ. ${ctx.h} tiện ghé buổi sáng hay chiều ạ.`,
      mustInclude: ["5h", "20h30", "sáng", "chiều"],
    }),
  },
  {
    id: "ask_address",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_address",
    },
    render: (ctx) => ({
      id: "ask_address",
      template:
        `Dạ trung tâm bên em ở 32A Nguyễn Chí Thanh, Vĩnh Yên ${ctx.h} ạ. ` +
        `${ctx.h} có cần em hướng dẫn đường đi không ạ.`,
      mustInclude: ["32A Nguyễn Chí Thanh", "Vĩnh Yên"],
    }),
  },
  {
    id: "ask_branch",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_branch",
    },
    render: (ctx) => ({
      id: "ask_branch",
      template:
        `Dạ hiện tại bên em có 1 cơ sở duy nhất tại 32A Nguyễn Chí Thanh, Vĩnh Yên ${ctx.h} ạ. ` +
        `Bên em chưa mở chi nhánh ở tỉnh khác nha.`,
      mustInclude: ["1 cơ sở", "Vĩnh Yên"],
    }),
  },
  {
    id: "ask_facility_parking",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_facility_parking",
    },
    render: (ctx) => ({
      id: "ask_facility_parking",
      template: `Dạ bên em có bãi gửi xe riêng cho hội viên, không mất phí ${ctx.h} ạ. ${ctx.h} cứ ghé tập không lo nha.`,
      mustInclude: ["gửi xe", "không mất phí"],
    }),
  },
  {
    id: "ask_facility_locker",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: ["ask_facility_locker", "ask_facility_shower"],
    },
    render: (ctx) => ({
      id: "ask_facility_locker",
      template: `Dạ bên em có tủ đồ riêng cho hội viên cùng phòng tắm có vòi sen nước nóng sau khi tập ${ctx.h} ạ.`,
      mustInclude: ["tủ đồ", "phòng tắm"],
    }),
  },
  {
    id: "ask_facility_wifi",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_facility_wifi",
    },
    render: (ctx) => ({
      id: "ask_facility_wifi",
      template: `Dạ phòng tập bên em có điều hòa, hệ thống lọc không khí và wifi miễn phí cho hội viên ${ctx.h} ạ.`,
      mustInclude: ["điều hòa", "wifi"],
    }),
  },
  {
    id: "ask_facility_kid_supervision",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_facility_kid_supervision",
    },
    render: (ctx) => ({
      id: "ask_facility_kid_supervision",
      template:
        `Dạ bên em hiện chưa có dịch vụ trông trẻ riêng ${ctx.h} ạ. ` +
        `Tuy nhiên có khu chờ thoáng cho người nhà, hoặc nếu bé từ 6 tuổi thì có thể đăng ký lớp bơi/yoga trẻ em tập cùng giờ ${ctx.h} nha.`,
      mustInclude: ["chưa có", "khu chờ"],
    }),
  },

  // ═══════════ POLICY (objection) ═══════════
  {
    id: "ask_hold_policy",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation", "objection"],
      domain: "objection",
      attribute: "ask_hold_policy",
    },
    render: (ctx) => ({
      id: "ask_hold_policy",
      template:
        `Dạ với gói năm, ${ctx.h} có thể bảo lưu khi vắng 1-2 tuần ạ. ` +
        `Gói tháng không bảo lưu nhưng có thể chuyển nhượng trong gia đình ${ctx.h} nha.`,
      mustInclude: ["bảo lưu", "gói năm", "chuyển nhượng"],
    }),
  },
  {
    id: "ask_refund_policy",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation", "objection"],
      domain: "objection",
      attribute: "ask_refund_policy",
    },
    render: (ctx) => ({
      id: "ask_refund_policy",
      template:
        `Dạ bên em không có chính sách hoàn tiền sau khi đăng ký ${ctx.h} ạ. ` +
        `Tuy nhiên ${ctx.h} có thể bảo lưu (gói năm 1-2 tuần) hoặc chuyển nhượng cho người thân, nên cứ yên tâm nha.`,
      mustInclude: ["không có chính sách hoàn tiền", "bảo lưu"],
    }),
  },
  {
    id: "ask_change_package",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation", "objection"],
      domain: "objection",
      attribute: "ask_change_package",
    },
    render: (ctx) => ({
      id: "ask_change_package",
      template:
        `Dạ ${ctx.h} có thể đổi sang dịch vụ khác giữa chừng ạ, bên em sẽ tính chênh lệch theo bảng giá hiện tại. ` +
        `${ctx.h} đang muốn đổi sang môn nào để em check phù hợp giúp ạ.`,
      mustInclude: ["đổi", "chênh lệch"],
    }),
  },
  {
    id: "ask_renewal",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation", "negotiation"],
      domain: "objection",
      attribute: "ask_renewal",
    },
    render: (ctx) => {
      const prefix =
        ctx.state.turnCount <= 1
          ? `Dạ em chào ${ctx.h}, cảm ơn ${ctx.h} đã quay lại với bên em ạ. `
          : `Dạ vâng ${ctx.h}, em hỗ trợ ${ctx.h} gia hạn nha. `;
      return {
        id: "ask_renewal",
        template:
          prefix +
          `Hội viên cũ gia hạn được ưu đãi giảm thêm so với khách mới. ` +
          `${ctx.h} cho em xin SĐT cũ để em check thẻ giúp ạ.`,
        mustInclude: ["hội viên cũ", "SĐT cũ"],
      };
    },
  },
  {
    id: "complaint_crowded",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation", "objection", "recovery"],
      domain: "objection",
      attribute: "complaint_crowded",
    },
    render: (ctx) => ({
      id: "complaint_crowded",
      template:
        `Dạ em xin lỗi vì bất tiện vừa rồi ${ctx.h} ạ. ` +
        `Khung 18-20h là giờ cao điểm nhất, nếu ${ctx.h} đổi sang khung 5-7h sáng, 10-12h trưa hoặc sau 20h thì sẽ vắng hơn nhiều. ` +
        `Em note lại để bên em cân đối thêm máy giờ cao điểm nha.`,
      mustInclude: ["xin lỗi", "vắng hơn"],
    }),
  },
  {
    id: "ask_unsupported_service",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "service_inquiry",
      attribute: "ask_unsupported",
    },
    render: (ctx) => {
      const m = (ctx.message || "").toLowerCase();
      const h = ctx.h;
      let alt = "";
      if (/(boxing|kickbox|võ|đấm\s*bốc|muay)/.test(m)) {
        alt = `Tuy nhiên Gym của bên em có khu cardio + tạ free-weight phù hợp với mục tiêu đốt mỡ + săn chắc tương tự boxing ${h} ạ.`;
      } else if (/(dance|nhảy|aerobic)/.test(m)) {
        alt = `Tuy nhiên Zumba của bên em chính là dance fitness — nhảy theo nhạc, đốt mỡ + xả stress với GV Ấn Độ ${h} ạ.`;
      } else if (/(crossfit|hiit|functional)/.test(m)) {
        alt = `Tuy nhiên Gym của bên em có khu cardio + tạ free-weight, ${h} có thể tự tập HIIT theo lịch riêng ạ.`;
      } else {
        alt = `Bên em hiện tập trung 5 dịch vụ: Gym, Yoga, Zumba, Bơi và Pilates ${h} ạ.`;
      }
      return {
        id: "ask_unsupported_service",
        template: `Dạ bộ môn này bên em hiện chưa có ${h} ạ. ${alt}`,
        mustInclude: ["chưa có"],
      };
    },
  },

  // ═══════════ SAFETY CONCERNS ═══════════
  {
    id: "ask_postpartum_safety",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "postpartum",
    },
    guards: (ctx) => {
      if (safetyAlreadyCovered(ctx, "postpartum")) {
        return { skip: true, reason: "đã trấn an postpartum → để LLM trả lời ngắn, sát" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_postpartum_safety",
      template:
        `Dạ ${ctx.h} mới sinh là bình thường có ngấn mỡ vùng bụng-eo do giãn cơ ${ctx.h} ạ. ` +
        `Đang cho con bú vẫn tập được — bên em sẽ điều chỉnh cường độ nhẹ (yoga phục hồi + đi bộ + gym nhẹ), tránh tập nặng làm mất sữa. ` +
        `HLV có kinh nghiệm tư vấn mẹ bỉm rồi, ${ctx.h} cứ yên tâm ạ.`,
      mustInclude: ["cho con bú", "điều chỉnh", "yên tâm"],
    }),
  },
  {
    id: "ask_prenatal_safety",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "prenatal",
    },
    guards: (ctx) => {
      if (safetyAlreadyCovered(ctx, "prenatal")) {
        return { skip: true, reason: "đã trấn an prenatal" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_prenatal_safety",
      template:
        `Dạ ${ctx.h} đang mang bầu thì bên em rất khuyến khích Yoga bầu nhẹ + đi bộ trong bể bơi để giãn cơ ${ctx.h} ạ. ` +
        `Tuy nhiên ${ctx.h} nên có giấy khám sức khỏe và xin ý kiến bác sĩ trước, tránh các động tác gập bụng, nằm ngửa hoặc xoắn người. ` +
        `Bên em chưa có lớp yoga bầu riêng nhưng HLV sẽ điều chỉnh động tác phù hợp cho ${ctx.h} nha.`,
      mustInclude: ["bầu", "yoga", "bác sĩ"],
    }),
  },
  {
    id: "ask_senior_safety",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "senior",
    },
    guards: (ctx) => {
      if (safetyAlreadyCovered(ctx, "senior")) {
        return { skip: true, reason: "đã trấn an senior" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_senior_safety",
      template:
        `Dạ với người trên 60 tuổi hoặc có bệnh nền (cao huyết áp, tim mạch, khớp), ` +
        `${ctx.h} nên có giấy khám sức khỏe và trao đổi với HLV trước khi tập ạ. ` +
        `Bên em có Yoga nhẹ + bể bơi 4 mùa rất hợp cho duy trì sức khỏe + giảm áp lực khớp ${ctx.h} nha.`,
      mustInclude: ["bệnh nền", "giấy khám", "Yoga"],
    }),
  },
  {
    id: "ask_rapid_weight_loss",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "rapid_weight_loss",
    },
    render: (ctx) => ({
      id: "ask_rapid_weight_loss",
      template:
        `Dạ ${ctx.h} ơi, giảm cân quá nhanh (vd hơn 4-5kg/tháng) thường không an toàn vì cơ thể dễ bị mất cơ + thiếu chất ${ctx.h} ạ. ` +
        `Bên em khuyến nghị giảm bền vững 2-4kg/tháng kết hợp Gym + Zumba + ăn uống khoa học. ` +
        `${ctx.h} có muốn em hỗ trợ đo InBody miễn phí để HLV thiết kế lộ trình an toàn không ạ.`,
      mustInclude: ["không an toàn", "2-4kg", "InBody"],
    }),
  },
  {
    id: "ask_post_surgery",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "post_surgery",
    },
    guards: (ctx) => {
      const m = (ctx.message || "").toLowerCase();
      const hasSurgeryCue =
        /(phẫu\s*thuật|mổ|đứt\s*dây\s*chằng|gãy\s*xương|tai\s*nạn|chấn\s*thương\s*(cần|phải|đang)|bác\s*sĩ\s*(kêu|bảo|nói|chỉ\s*định))/i.test(m);
      if (!hasSurgeryCue) return { skip: true, reason: "thiếu surgery cue" };
      if (safetyAlreadyCovered(ctx, "post_surgery")) {
        return { skip: true, reason: "đã trấn an post-surgery" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_post_surgery",
      template:
        `Dạ với trường hợp vừa phẫu thuật / chấn thương, ${ctx.h} CẦN có giấy xác nhận của bác sĩ về việc đủ điều kiện vận động ạ. ` +
        `Bên em có HLV chuyên hỗ trợ phục hồi (yoga nhẹ + bơi giảm áp lực khớp + gym phục hồi từng nhóm cơ). ` +
        `${ctx.h} mang giấy của bác sĩ qua để HLV thiết kế lộ trình an toàn nhé.`,
      mustInclude: ["bác sĩ", "phục hồi"],
    }),
  },
  {
    id: "ask_teen_safety",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "safety_concern",
      attribute: "teen",
    },
    guards: (ctx) => {
      if (safetyAlreadyCovered(ctx, "teen")) {
        return { skip: true, reason: "đã trấn an teen" };
      }
      return true;
    },
    render: (ctx) => ({
      id: "ask_teen_safety",
      template:
        `Dạ tuổi này hoàn toàn có thể tập gym ${ctx.h} nha, tuy nhiên giai đoạn đang phát triển nên cần HLV hướng dẫn kỹ thuật + chọn mức tạ phù hợp. ` +
        `Bên em có gói PT 1-1 (20 buổi 6 triệu) sẽ phù hợp cho ${ctx.h} mới tập + đang tuổi phát triển. ` +
        `Nếu có thể, ${ctx.h} nhờ ba mẹ qua cùng buổi đầu để HLV trao đổi nhé.`,
      mustInclude: ["tập gym", "HLV", "kỹ thuật"],
    }),
  },

  // ═══════════ PRICING ═══════════
  {
    id: "price_with_worry",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
      domain: "pricing",
      attribute: "ask_price_with_worry",
    },
    render: (ctx) => ({
      id: "price_with_worry",
      template:
        `Dạ bên em có các gói giá từ 6-12 tháng ${ctx.h} ạ, nếu ${ctx.h} sợ không theo được cứ thử 1 buổi nhé — 90% các bác sau khi thử là nghiện đấy ạ.`,
      mustInclude: ["6-12 tháng", "thử 1 buổi", "nghiện"],
    }),
  },
  {
    id: "ask_combo_pricing",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
      domain: "pricing",
      attribute: "ask_price_combo",
    },
    render: (ctx) => ({
      id: "ask_combo_pricing",
      template:
        `Dạ gói combo đa dịch vụ bên em — thẻ Full bao gồm Gym + Yoga + Zumba + Bơi — chỉ từ 7 triệu/12 tháng ${ctx.h} ạ. ` +
        `Tính ra mỗi bộ môn chỉ ~146k/tháng, rẻ hơn nhiều so với tập riêng từng môn. ` +
        `${ctx.h} có muốn em tư vấn thêm gói ngắn hạn không ạ.`,
      mustInclude: ["thẻ Full", "7 triệu"],
    }),
  },
  {
    id: "ask_pt_pricing",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
      domain: "pricing",
      attribute: "ask_price_pt",
    },
    render: (ctx) => ({
      id: "ask_pt_pricing",
      template:
        `Dạ gói PT 1-1 bên em hiện tại là 20 buổi 6 triệu (tương đương 2 tháng nếu tập 2-3 buổi/tuần) ${ctx.h} ạ. ` +
        `HLV kèm sát từng buổi, xây kỹ thuật + lộ trình riêng theo mục tiêu của ${ctx.h}. ` +
        `${ctx.h} có muốn ghé InBody miễn phí lần đầu để HLV gặp + tư vấn không ạ.`,
      mustInclude: ["PT", "20 buổi", "6 triệu"],
    }),
  },
  {
    id: "ask_hlv_gender",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation", "negotiation"],
      domain: "service_inquiry",
      attribute: "ask_hlv_gender",
    },
    render: (ctx) => ({
      id: "ask_hlv_gender",
      template:
        `Dạ bên em có cả HLV nam và HLV nữ ${ctx.h} ạ, ${ctx.h} có thể yêu cầu để em sắp HLV phù hợp. ` +
        `Với Yoga / Zumba, giáo viên chủ yếu là cô (GV Ấn Độ). Với Gym / PT, có cả nam và nữ. ` +
        `${ctx.h} muốn tập bộ môn nào để em sắp HLV ạ.`,
      mustInclude: ["HLV nam", "HLV nữ"],
    }),
  },
  {
    id: "ask_payment_method",
    match: {
      flow: "fitness",
      stages: ["evaluation", "negotiation", "commitment"],
      domain: "pricing",
      attribute: ["ask_payment_method", "ask_payment_traGop"],
    },
    render: (ctx) => {
      const m = (ctx.message || "").toLowerCase();
      const h = ctx.h;
      if (/trả\s*góp|góp/.test(m)) {
        return {
          id: "ask_payment_traGop",
          template:
            `Dạ bên em hiện chưa có chương trình trả góp 0% ${h} ạ. ` +
            `Tuy nhiên ${h} có thể thanh toán linh hoạt theo gói tháng / quý / 6 tháng / năm tuỳ ngân sách. ` +
            `${h} đang quan tâm gói nào để em tư vấn cụ thể ạ.`,
          mustInclude: ["chưa có", "trả góp"],
        };
      }
      return {
        id: "ask_payment_general",
        template:
          `Dạ bên em hỗ trợ thanh toán tiền mặt và chuyển khoản (có QR) ${h} ạ. ` +
          `Hiện chưa nhận thanh toán bằng thẻ credit. ${h} chốt gói rồi em gửi QR liền nha.`,
        mustInclude: ["tiền mặt", "chuyển khoản"],
      };
    },
  },

  // ═══════════ EDGE ═══════════
  {
    id: "ask_nutrition",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "edge",
      attribute: "nutrition",
    },
    render: (ctx) => ({
      id: "ask_nutrition",
      template:
        `Dạ bên em chưa có dịch vụ tư vấn dinh dưỡng / bán thực phẩm bổ sung riêng ${ctx.h} ạ. ` +
        `Tuy nhiên HLV bên em sẽ hỗ trợ gợi ý chế độ ăn cơ bản theo mục tiêu khi ${ctx.h} tập. ` +
        `${ctx.h} muốn em tư vấn lộ trình tập + ăn uống cơ bản không ạ.`,
      mustInclude: ["chưa có", "chế độ ăn"],
    }),
  },
  {
    id: "ask_corporate",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery", "evaluation"],
      domain: "edge",
      attribute: "corporate",
    },
    render: (ctx) => ({
      id: "ask_corporate",
      template:
        `Dạ với gói doanh nghiệp (10+ nhân viên), bên em hỗ trợ ưu đãi riêng tùy số lượng và lộ trình ${ctx.h} ạ. ` +
        `${ctx.h} cho em xin SĐT + số lượng nhân viên cụ thể, em báo lại phòng kinh doanh để gửi báo giá chi tiết nha.`,
      mustInclude: ["doanh nghiệp", "ưu đãi riêng", "SĐT"],
    }),
  },

  // ═══════════ COMBO SERVICE ═══════════
  {
    id: "combo_service_ask",
    match: {
      flow: "fitness",
      stages: ["discovery", "evaluation", "negotiation"],
      domain: "service_inquiry",
      attribute: "ask_combo_with_other",
    },
    render: (ctx) => ({
      id: "combo_service_ask",
      template:
        `Dạ nếu ${ctx.h} có nhu cầu, em cũng có gói cho mình để tập kết hợp ạ. ` +
        `Thẻ Full bên em dùng chung cho cả 4 dịch vụ (Gym + Yoga + Zumba + Bơi). ${ctx.h} sắp xếp thời gian qua bên em nhé.`,
      mustInclude: ["gói", "kết hợp"],
    }),
  },

  // ═══════════ POOL AUDIENCE ASK ═══════════
  {
    id: "pool_audience_ask",
    match: {
      flow: "fitness",
      stages: ["opening", "discovery"],
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_swim_audience",
    },
    render: (ctx) => {
      const prefix =
        ctx.state.turnCount <= 1
          ? `Dạ em chào ${ctx.h}, `
          : `Dạ vâng ${ctx.h}, `;
      return {
        id: "pool_audience_ask",
        template:
          prefix +
          `không biết ${ctx.h} đang quan tâm học bơi cho người lớn hay trẻ em ạ.`,
        mustInclude: ["người lớn", "trẻ em"],
      };
    },
  },

  // ═══════════ FULL PACKAGE CONFIRM ═══════════
  {
    id: "full_package_confirm",
    match: {
      flow: "fitness",
      stages: ["evaluation", "negotiation", "commitment"],
      domain: "commitment",
      attribute: "full_package_confirm",
    },
    render: (ctx) => {
      // Đã có tên + SĐT → hỏi giờ chốt slot
      if (ctx.state.knownInfo.name && ctx.state.knownInfo.phone) {
        return {
          id: "full_package_ask_time",
          template:
            `Dạ vâng ${ctx.h} ${ctx.state.knownInfo.name}, gói Full rất phù hợp với mình ạ. ` +
            `${ctx.h} muốn đến buổi sáng, chiều hay tối để em giữ slot ạ.`,
          mustInclude: ["sáng", "chiều", "tối"],
        };
      }
      return {
        id: "full_package_confirm",
        template:
          `Dạ vâng ${ctx.h}, gói Full rất phù hợp với mình ạ — mỗi thời điểm mình sẽ có một mục tiêu khác nhau, có đủ 4 dịch vụ thì luân phiên cho linh động, đỡ chán. ` +
          `${ctx.h} cho em xin tên với SĐT để em giữ slot ạ.`,
        mustInclude: ["gói Full"],
      };
    },
  },
];

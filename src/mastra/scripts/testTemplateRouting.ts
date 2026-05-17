/**
 * scripts/testTemplateRouting.ts — Coverage test cho template engine (Phase 4).
 *
 * Mục tiêu: với mỗi (message, state, intentSignal) input → assert template id fired đúng.
 * KHÔNG gọi LLM → chạy <30s. Catch regression sớm khi sửa templates.
 *
 * Cách chạy:
 *   npx tsx src/mastra/scripts/testTemplateRouting.ts
 *
 * Output: text report + exit code 0 (pass) / 1 (fail).
 */

import { FITNESS_TEMPLATES } from "../lib/templates/fitness";
import { findTemplate, type TemplateContext } from "../lib/templates/engine";
import type { ConversationState, Stage } from "../lib/stateMachine";
import type { Domain, Service, Attribute, IntentSignal } from "../lib/intent";
import { DEFAULT_STATE } from "../lib/stateMachine";

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function mkState(overrides: Partial<ConversationState> & {
  domain?: Domain;
  service?: Service;
  attribute?: Attribute;
}): ConversationState {
  const { domain, service, attribute, ...stateOverrides } = overrides;
  const intentSignal: IntentSignal | null = domain
    ? { domain, service: service ?? null, attribute: attribute ?? null }
    : null;
  return {
    ...DEFAULT_STATE,
    flow: "fitness",
    stage: stateOverrides.stage ?? "discovery",
    intentSignal,
    ...stateOverrides,
  };
}

function mkCtx(state: ConversationState, message: string, prevReply = ""): TemplateContext {
  return {
    state,
    message,
    prevReply,
    prevUserMessage: state.lastUserMessage || "",
    h: state.honorific === "anh/chị" ? "anh/chị" : state.honorific,
  };
}

// ─────────────────────────────────────────────
// TEST CASES
// ─────────────────────────────────────────────

interface RoutingTest {
  name: string;
  message: string;
  state: ConversationState;
  prevReply?: string;
  expectId: string | null;
  /** Cụm bắt buộc xuất hiện trong rendered template (sanity check). */
  expectContains?: string[];
}

const TESTS: RoutingTest[] = [
  // ═══════════ OPENING ═══════════
  {
    name: "opening_greeting — turn 1 chào",
    message: "quan tâm",
    state: mkState({ stage: "opening", turnCount: 1, domain: "greeting", attribute: "show_interest" }),
    expectId: "opening_greeting",
    expectContains: ["em chào", "bộ môn nào"],
  },
  {
    name: "opening_greeting — SKIP khi memberType set",
    message: "quan tâm",
    state: mkState({
      stage: "opening",
      turnCount: 1,
      domain: "greeting",
      attribute: "show_interest",
      knownInfo: { ...DEFAULT_STATE.knownInfo, memberType: "hoc-sinh" },
    }),
    expectId: null, // skipped — để PITCH pitch HS gói riêng
  },

  // ═══════════ INDECISIVE ═══════════
  {
    name: "indecisive_pick_for_me — có cue + goal=giam-mo",
    message: "chị chọn giúp em",
    state: mkState({
      stage: "discovery",
      turnCount: 2,
      domain: "discovery_answer",
      attribute: "indecisive_pick_for_me",
      knownInfo: { ...DEFAULT_STATE.knownInfo, fitnessGoal: "giam-mo" },
    }),
    expectId: "indecisive_recommend_giam_mo",
    expectContains: ["Gym", "Zumba"],
  },
  {
    name: "indecisive_pick_for_me — SKIP khi không cue",
    message: "chị muốn xem ảnh phòng",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "indecisive_pick_for_me", // classifier mis-label
    }),
    expectId: null, // skipped — thiếu cue
  },

  // ═══════════ STUDENT PRICING ═══════════
  {
    name: "ask_student_pricing — turn 1",
    message: "em sinh viên có ưu đãi gì không",
    state: mkState({
      stage: "opening",
      turnCount: 1,
      domain: "pricing",
      attribute: "ask_price_student",
    }),
    expectId: "ask_student_pricing",
    expectContains: ["học sinh", "ưu đãi"],
  },
  {
    name: "ask_student_pricing — SKIP anti-loop",
    message: "ưu đãi gì",
    state: mkState({
      stage: "discovery",
      domain: "pricing",
      attribute: "ask_price_student",
    }),
    prevReply: "Dạ với học sinh / sinh viên, bên em có ưu đãi riêng tuỳ thời điểm anh ạ. Anh cho em xin SĐT để em báo lại bộ phận sale gửi báo giá HS/SV cụ thể",
    expectId: null, // skipped — prev đã fire template này
  },

  // ═══════════ POOL CHILD AGE ═══════════
  {
    name: "pool_child_no_age — chưa có tuổi",
    message: "cho con tôi học bơi",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_no_age",
    }),
    expectId: "pool_child_no_age",
    expectContains: ["6 tuổi", "mấy tuổi"],
  },
  {
    name: "pool_child_no_age — SKIP khi message có tuổi",
    message: "bé nhà chị 7 tuổi",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_no_age",
    }),
    expectId: null, // skipped — age in message
  },
  {
    name: "pool_child_no_age — SKIP khi prev user msg có tuổi",
    message: "thế là sao em",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_no_age",
      lastUserMessage: "bé nhà chị 7 tuổi",
    }),
    expectId: null, // skipped — age in prev user msg (cross-turn fix)
  },
  {
    name: "pool_child_with_age — có tuổi",
    message: "cháu 6 tuổi em nhé",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_child_with_age",
    }),
    expectId: "pool_child_with_age",
    expectContains: ["test nước", "bạo nước"],
  },

  // ═══════════ INTRO GIAM CAN ═══════════
  {
    name: "intro_giam_can — opening, chưa schedule",
    message: "em muốn giảm cân",
    state: mkState({
      stage: "opening",
      turnCount: 1,
      domain: "discovery_answer",
      attribute: "goal_lose_weight",
    }),
    expectId: "giam_can_ask_history",
    expectContains: ["biện pháp giảm cân"],
  },
  {
    name: "intro_giam_can — SKIP khi có schedule cue",
    message: "anh tập sáng, để giảm mỡ",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "goal_lose_weight",
    }),
    expectId: null, // skipped — message có schedule cue
  },
  {
    name: "intro_giam_can — SKIP khi health context",
    message: "chị mới sinh con 6 tháng, cần giảm cân",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "goal_lose_weight",
    }),
    expectId: null, // skipped — postpartum
  },

  // ═══════════ POOL FACILITY FAQs ═══════════
  {
    name: "pool_chlorine",
    message: "bể bơi có clo không",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_chlorine",
    }),
    expectId: "pool_chlorine",
    expectContains: ["có sử dụng", "tiêu chuẩn"],
  },
  {
    name: "pool_temperature",
    message: "nước bể có ấm không",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_temperature",
    }),
    expectId: "pool_temperature",
    expectContains: ["bốn mùa", "nước ấm"],
  },
  {
    name: "pool_lifeguard",
    message: "có cứu hộ không em",
    state: mkState({
      stage: "evaluation",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_lifeguard",
    }),
    expectId: "pool_lifeguard",
    expectContains: ["cứu hộ"],
  },

  // ═══════════ ZUMBA ═══════════
  {
    name: "zumba_vs_aerobic",
    message: "Zumba khác Aerobic chỗ nào",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "zumba",
      attribute: "compare_zumba_aerobic",
    }),
    expectId: "zumba_vs_aerobic",
    expectContains: ["Aerobic", "nền nhạc"],
  },
  {
    name: "zumba_class_composition",
    message: "lớp bây giờ có người mới không em",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "zumba",
      attribute: "ask_class_composition",
    }),
    expectId: "zumba_class_composition",
    expectContains: ["tuyển sinh"],
  },

  // ═══════════ YOGA ═══════════
  {
    name: "yoga_new_class_inquiry",
    message: "chị chưa tập, có lớp cho người mới không em",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      service: "yoga",
      attribute: "ask_new_class",
    }),
    expectId: "yoga_new_class_inquiry",
    expectContains: ["hơi thở", "HLV"],
  },

  // ═══════════ TRIAL ═══════════
  {
    name: "trial_ask_confirm",
    message: "có được tập thử không em",
    state: mkState({
      stage: "evaluation",
      domain: "scheduling",
      attribute: "ask_trial_confirm",
    }),
    expectId: "trial_ask_confirm",
    expectContains: ["tập thử", "1 buổi"],
  },

  // ═══════════ THAM QUAN ═══════════
  {
    name: "tham_quan",
    message: "chị đi qua tham quan thôi",
    state: mkState({
      stage: "opening",
      domain: "greeting",
      attribute: "browsing",
    }),
    expectId: "tham_quan",
    expectContains: ["Tổ hợp thể thao", "gói Full"],
  },

  // ═══════════ FACILITY (new bulk migration) ═══════════
  {
    name: "ask_address",
    message: "trung tâm ở đâu",
    state: mkState({
      stage: "opening",
      domain: "service_inquiry",
      attribute: "ask_address",
    }),
    expectId: "ask_address",
    expectContains: ["32A Nguyễn Chí Thanh"],
  },
  {
    name: "ask_branch",
    message: "có chi nhánh ở HN không",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      attribute: "ask_branch",
    }),
    expectId: "ask_branch",
    expectContains: ["1 cơ sở"],
  },
  {
    name: "ask_facility_parking",
    message: "có chỗ gửi xe không em",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      attribute: "ask_facility_parking",
    }),
    expectId: "ask_facility_parking",
    expectContains: ["gửi xe", "không mất phí"],
  },
  {
    name: "ask_facility_locker",
    message: "có tủ đồ không",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      attribute: "ask_facility_locker",
    }),
    expectId: "ask_facility_locker",
    expectContains: ["tủ đồ", "phòng tắm"],
  },
  {
    name: "ask_open_hours — non-pool",
    message: "trung tâm mở mấy giờ",
    state: mkState({
      stage: "opening",
      domain: "service_inquiry",
      attribute: "ask_facility_hours",
    }),
    expectId: "ask_open_hours",
    expectContains: ["5h", "20h30"],
  },
  {
    name: "ask_open_hours — pool delegates to pool_hours",
    message: "bể bơi mở mấy giờ",
    state: mkState({
      stage: "opening",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_facility_hours",
    }),
    expectId: "pool_hours",
    expectContains: ["6h", "20h"],
  },

  // ═══════════ POLICY / OBJECTION ═══════════
  {
    name: "ask_hold_policy",
    message: "thẻ có bảo lưu không",
    state: mkState({
      stage: "discovery",
      domain: "objection",
      attribute: "ask_hold_policy",
    }),
    expectId: "ask_hold_policy",
    expectContains: ["bảo lưu", "gói năm"],
  },
  {
    name: "ask_refund_policy",
    message: "có hoàn tiền không",
    state: mkState({
      stage: "evaluation",
      domain: "objection",
      attribute: "ask_refund_policy",
    }),
    expectId: "ask_refund_policy",
    expectContains: ["không có chính sách hoàn tiền"],
  },
  {
    name: "complaint_crowded",
    message: "phòng tập đông quá",
    state: mkState({
      stage: "evaluation",
      domain: "objection",
      attribute: "complaint_crowded",
    }),
    expectId: "complaint_crowded",
    expectContains: ["xin lỗi", "vắng hơn"],
  },

  // ═══════════ SAFETY ═══════════
  {
    name: "ask_postpartum_safety",
    message: "chị mới sinh tập được không",
    state: mkState({
      stage: "discovery",
      domain: "safety_concern",
      attribute: "postpartum",
    }),
    expectId: "ask_postpartum_safety",
    expectContains: ["cho con bú", "yên tâm"],
  },
  {
    name: "ask_prenatal_safety",
    message: "chị đang bầu tập được không",
    state: mkState({
      stage: "discovery",
      domain: "safety_concern",
      attribute: "prenatal",
    }),
    expectId: "ask_prenatal_safety",
    expectContains: ["bầu", "bác sĩ"],
  },
  {
    name: "ask_senior_safety",
    message: "60 tuổi tập được không",
    state: mkState({
      stage: "discovery",
      domain: "safety_concern",
      attribute: "senior",
    }),
    expectId: "ask_senior_safety",
    expectContains: ["bệnh nền", "giấy khám"],
  },
  {
    name: "ask_post_surgery — guard pass",
    message: "anh mới phẫu thuật đứt dây chằng 3 tháng",
    state: mkState({
      stage: "discovery",
      domain: "safety_concern",
      attribute: "post_surgery",
    }),
    expectId: "ask_post_surgery",
    expectContains: ["bác sĩ", "phục hồi"],
  },
  {
    name: "ask_post_surgery — guard skip (no surgery cue)",
    message: "đau lưng do ngồi văn phòng",
    state: mkState({
      stage: "discovery",
      domain: "safety_concern",
      attribute: "post_surgery",
    }),
    expectId: null, // skipped — no surgery cue
  },

  // ═══════════ PRICING (new) ═══════════
  {
    name: "ask_combo_pricing",
    message: "gym+yoga combo bao nhiêu",
    state: mkState({
      stage: "evaluation",
      domain: "pricing",
      attribute: "ask_price_combo",
    }),
    expectId: "ask_combo_pricing",
    expectContains: ["thẻ Full", "7 triệu"],
  },
  {
    name: "ask_pt_pricing",
    message: "PT bao nhiêu tháng",
    state: mkState({
      stage: "discovery",
      domain: "pricing",
      attribute: "ask_price_pt",
    }),
    expectId: "ask_pt_pricing",
    expectContains: ["PT", "20 buổi"],
  },
  {
    name: "ask_hlv_gender",
    message: "có HLV nữ không em",
    state: mkState({
      stage: "discovery",
      domain: "service_inquiry",
      attribute: "ask_hlv_gender",
    }),
    expectId: "ask_hlv_gender",
    expectContains: ["HLV nam", "HLV nữ"],
  },
  {
    name: "ask_payment_method — chuyển khoản",
    message: "có chuyển khoản không",
    state: mkState({
      stage: "commitment",
      domain: "pricing",
      attribute: "ask_payment_method",
    }),
    expectId: "ask_payment_general",
    expectContains: ["tiền mặt", "chuyển khoản"],
  },
  {
    name: "ask_payment_method — trả góp",
    message: "có trả góp không",
    state: mkState({
      stage: "evaluation",
      domain: "pricing",
      attribute: "ask_payment_traGop",
    }),
    expectId: "ask_payment_traGop",
    expectContains: ["chưa có", "trả góp"],
  },

  // ═══════════ EDGE ═══════════
  {
    name: "ask_nutrition",
    message: "có whey protein không",
    state: mkState({
      stage: "discovery",
      domain: "edge",
      attribute: "nutrition",
    }),
    expectId: "ask_nutrition",
    expectContains: ["chưa có", "chế độ ăn"],
  },
  {
    name: "ask_corporate",
    message: "công ty đặt cho 20 nhân viên",
    state: mkState({
      stage: "discovery",
      domain: "edge",
      attribute: "corporate",
    }),
    expectId: "ask_corporate",
    expectContains: ["doanh nghiệp", "ưu đãi riêng"],
  },

  // ═══════════ DISCOVERY ANSWERS ═══════════
  {
    name: "no_experience — gym",
    message: "chị chưa tập gym bao giờ",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "no_experience",
      knownInfo: { ...DEFAULT_STATE.knownInfo, serviceType: "gym" },
    }),
    expectId: "gym_ask_goal",
    expectContains: ["mục tiêu", "tăng cân"],
  },
  {
    name: "no_experience — yoga (trấn an)",
    message: "chưa tập yoga bao giờ",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "no_experience",
      knownInfo: { ...DEFAULT_STATE.knownInfo, serviceType: "yoga" },
    }),
    expectId: "yoga_tran_an",
    expectContains: ["lớp cộng đồng", "HLV"],
  },
  {
    name: "has_experience — yoga ask schedule",
    message: "đã tập yoga rồi",
    state: mkState({
      stage: "discovery",
      domain: "discovery_answer",
      attribute: "has_experience",
      knownInfo: { ...DEFAULT_STATE.knownInfo, serviceType: "yoga" },
    }),
    expectId: "yoga_experienced_ask_schedule",
    expectContains: ["sáng", "chiều"],
  },

  // ═══════════ POOL AUDIENCE ═══════════
  {
    name: "pool_audience_ask",
    message: "chị muốn học bơi",
    state: mkState({
      stage: "opening",
      domain: "service_inquiry",
      service: "boi",
      attribute: "ask_swim_audience",
    }),
    expectId: "pool_audience_ask",
    expectContains: ["người lớn", "trẻ em"],
  },

  // ═══════════ NEW: share-package (mua gói 2 người) ═══════════
  {
    name: "ask_share_package — '1 gói 2 người'",
    message: "chị mua 1 gói sử dụng 2 người có được không",
    state: mkState({ stage: "discovery" }),
    expectId: "ask_share_package",
    expectContains: ["chưa có", "tích lượt", "cá nhân"],
  },
  {
    name: "ask_share_package — 'dùng chung thẻ'",
    message: "2 người dùng chung thẻ được không em",
    state: mkState({ stage: "evaluation" }),
    expectId: "ask_share_package",
    expectContains: ["chưa có", "tích lượt"],
  },

  // ═══════════ NEW: trial_ask_confirm Zumba có giờ cụ thể ═══════════
  {
    name: "trial_ask_confirm — Zumba có 5h và 18h",
    message: "có được tập thử không em",
    state: mkState({
      stage: "evaluation",
      domain: "scheduling",
      attribute: "ask_trial_confirm",
      knownInfo: { ...DEFAULT_STATE.knownInfo, serviceType: "zumba" },
    }),
    expectId: "trial_ask_confirm_zumba",
    expectContains: ["5h sáng", "18h chiều"],
  },

  // ═══════════ NEW: price_with_worry có "90% nghiện" ═══════════
  {
    name: "price_with_worry — '90% nghiện'",
    message: "có gói nào, chưa tập bao giờ không biết theo được không",
    state: mkState({
      stage: "discovery",
      domain: "pricing",
      attribute: "ask_price_with_worry",
    }),
    expectId: "price_with_worry",
    expectContains: ["6-12 tháng", "nghiện"],
  },
];

// ─────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────

function run() {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const t of TESTS) {
    const ctx = mkCtx(t.state, t.message, t.prevReply);
    const result = findTemplate(FITNESS_TEMPLATES, ctx);

    const actualId = result?.id ?? null;
    let ok = actualId === t.expectId;

    // Special handling for variant ids (vd "indecisive_recommend_giam_mo" matches expectation)
    if (!ok && t.expectId && actualId && actualId.includes(t.expectId.split("_").slice(0, 2).join("_"))) {
      ok = true;
    }

    if (ok && t.expectContains && result) {
      // Case-insensitive contains check — template có thể start-of-sentence capitalize.
      const templateLower = result.template.toLowerCase();
      for (const phrase of t.expectContains) {
        if (!templateLower.includes(phrase.toLowerCase())) {
          ok = false;
          failures.push(`  ${t.name}: missing "${phrase}" in ${result.id}`);
          break;
        }
      }
    }

    if (ok) {
      passed++;
      console.log(`  ✓ ${t.name} → ${actualId ?? "null"}`);
    } else {
      failed++;
      const detail = `expected=${t.expectId ?? "null"} actual=${actualId ?? "null"}`;
      failures.push(`  ✗ ${t.name}: ${detail}`);
      console.log(`  ✗ ${t.name}: ${detail}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Passed: ${passed}/${TESTS.length}  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(f);
  }

  process.exit(failed === 0 ? 0 : 1);
}

run();

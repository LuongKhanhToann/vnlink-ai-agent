/**
 * scripts/runTestScenarios.ts
 *
 * Chạy 1 loạt kịch bản hội thoại giả lập rồi lưu kết quả vào file JSON.
 *
 * Cách chạy:
 *   npm run test:scenarios
 *
 * Output: test-results/run-{ISO}.json
 *
 * MỖI scenario dùng threadId riêng → state độc lập, không lẫn nhau.
 * threadId có prefix "test-{ts}-" để dễ dò trong DB nếu cần cleanup.
 */

import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Force LibSQL in-memory cho test, tránh đụng Postgres production
// (vốn đang bị limit 25 connections từ Supabase pooler).
// PHẢI set TRƯỚC khi dynamic-import index.ts.
process.env.STORAGE_BACKEND = "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");
const { gradeScenario } = await import("./grader");
type TurnSnapshotType = import("./grader").TurnSnapshot;
type ScenarioScoreType = import("./grader").ScenarioScore;

// ─────────────────────────────────────────────
// SCENARIOS
// ─────────────────────────────────────────────

interface Scenario {
  name: string;
  description: string;
  messages: string[];
}

const SCENARIOS: Scenario[] = [
  // ═══════════ FITNESS — happy paths ═══════════
  {
    name: "fitness_happy_path",
    description: "Fitness điển hình: chào → gym + giảm mỡ → schedule → InBody → tên/SĐT/giờ.",
    messages: [
      "chào shop",
      "anh muốn đăng ký gym để giảm mỡ",
      "anh thường tập tối, khoảng 3 buổi mỗi tuần",
      "ok thử 1 buổi xem sao",
      "tên anh là Trung, sđt 0987654321, anh đến tối mai 7h",
    ],
  },
  {
    name: "fitness_compare_first",
    description: "Hỏi giá ngay (intent=compare). Bot phải answer first rồi thu info.",
    messages: [
      "chị cho hỏi thẻ tháng bao nhiêu",
      "chị muốn tập gym + bơi luôn",
      "tập sáng được không",
    ],
  },
  {
    name: "fitness_ask_media",
    description:
      "T1: khách hỏi học bơi (chưa xin xem ảnh — bot KHÔNG cần gửi media, chỉ pitch học bơi). T2: khách XIN xem ảnh bể bơi → bot phải gọi tool get-media gửi ảnh thật.",
    messages: [
      "chị muốn học bơi",
      "cho chị xem hình bể bơi luôn nha",
    ],
  },
  // ═══════════ FITNESS — objections + edge ═══════════
  {
    name: "fitness_objection_price",
    description: "Khách phản đối giá: 'đắt quá, có giảm không'. Bot phải reframe, không hạ giá.",
    messages: [
      "có gói gym giảm mỡ không",
      "anh tập 3 buổi/tuần thôi",
      "5tr cho 12 tháng đắt quá em ơi",
      "có giảm giá gì không",
    ],
  },
  {
    name: "fitness_student",
    description: "Sinh viên hỏi ưu đãi → bot phải đẩy gói HS/SV.",
    messages: [
      "em sinh viên có ưu đãi gì không ạ",
      "em tập gym + bơi cả 2",
      "em tập 6 tháng được không",
    ],
  },
  {
    name: "fitness_family",
    description: "Vợ chồng đăng ký cùng → bot pitch gói gia đình.",
    messages: [
      "vợ chồng anh muốn đăng ký cùng có gì hot không",
      "2 vợ chồng và 1 bé 10 tuổi",
      "ưu tiên bơi vì cu cậu thích",
    ],
  },
  {
    name: "fitness_pt_request",
    description: "Khách muốn HLV 1-1 cho gym tăng cơ.",
    messages: [
      "chị muốn có HLV riêng để tăng cơ",
      "chị mới tập, sợ sai tư thế",
      "chị tập 3 buổi/tuần, sáng được",
    ],
  },
  {
    name: "fitness_yoga_only",
    description: "Khách chỉ muốn yoga — bot không nên ép sang gói Full.",
    messages: [
      "chị chỉ tập yoga thôi, không cần gym",
      "chị tập để thư giãn, lưng hay đau",
      "ngày 1 buổi, chiều tối",
    ],
  },
  {
    name: "fitness_hold_policy",
    description: "Hỏi chính sách bảo lưu — bot phải nhắc đúng (gói năm có bảo lưu).",
    messages: [
      "chị hay đi công tác, có bảo lưu được không",
      "thường vắng 1-2 tuần",
      "vậy chị xem gói năm",
    ],
  },
  // ═══════════ GIẢI CƠ — happy paths ═══════════
  {
    name: "giaico_happy_path",
    description: "Giải cơ điển hình: vai gáy → painSpread → pastMethod → 1 buổi → chốt.",
    messages: [
      "anh đau vai gáy mấy hôm nay",
      "đau cố định 1 chỗ thôi, không lan",
      "đã đi massage 2 lần mà không đỡ",
      "ok anh thử 1 buổi, sáng mai 9h",
      "anh tên Hùng, sđt 0912345678",
    ],
  },
  {
    name: "giaico_direct_booking",
    description: "Khách chốt nhanh tin đầu — multi-step jump.",
    messages: [
      "anh muốn đặt lịch giải cơ vai gáy chiều mai 4h, anh tên Phong, sđt 0901234567",
    ],
  },
  {
    name: "giaico_ask_deposit",
    description: "Hỏi cọc trước sau khi đã chốt → bot gọi get-qr.",
    messages: [
      "chị đau lưng cả tuần rồi",
      "đau cứng cả lưng, mà cả tuần luôn",
      "chị có uống thuốc giảm đau",
      "ok chị thử buổi sáng thứ 7 9h",
      "chị tên Lan, sđt 0934567890",
      "có cọc trước được không em",
    ],
  },
  // ═══════════ GIẢI CƠ — đặc thù ═══════════
  {
    name: "giaico_chronic",
    description: "Đau lưng 3 tháng, đã đi khám — khách nghi ngờ, bot cần build trust.",
    messages: [
      "anh đau lưng dưới 3 tháng rồi",
      "đã đi khám, bác sĩ kêu cơ co cứng",
      "uống thuốc với dán cao mà không đỡ",
      "vậy giá bao nhiêu",
    ],
  },
  {
    name: "giaico_acute",
    description: "Tập gym sai tư thế đau cấp 2 hôm — bot phải warning đúng (không xử lý cấp tính ngay).",
    messages: [
      "anh tập gym sai tư thế hôm qua, giờ đau lưng quá",
      "đau ngay sau lưng, không nhúc nhích nổi",
      "vẫn nóng và sưng",
    ],
  },
  {
    name: "giaico_disc_concern",
    description: "Khách có thoát vị đĩa đệm — bot xử lý đúng theo objection script.",
    messages: [
      "chị bị thoát vị đĩa đệm L4-L5 có làm giải cơ được không",
      "đau vùng thắt lưng, lan xuống mông",
      "bị 6 tháng rồi, đã châm cứu",
    ],
  },
  {
    name: "giaico_female_concern",
    description: "Khách nữ ngại — hỏi có KTV nữ không.",
    messages: [
      "có KTV nữ không em, chị ngại",
      "chị đau cổ vai gáy",
      "tuần này chị tiện chiều",
    ],
  },
  // ═══════════ EDGE / ROBUSTNESS ═══════════
  {
    name: "changing_time",
    description: "Đổi ý giờ giữa chừng — preferredTime override đúng.",
    messages: [
      "anh muốn đặt lịch giải cơ thứ 7 9h sáng",
      "anh đau cổ vai 2 tuần rồi",
      "thôi sáng mai luôn nha",
    ],
  },
  {
    name: "edge_short_messages",
    description: "Reply ngắn ('ok'/'ừ') 3 lần — bot phải đổi tone, không lặp.",
    messages: ["có gì", "ừ", "ok"],
  },
  {
    name: "flow_switch",
    description: "Bắt đầu fitness → chuyển sang giải cơ giữa chừng.",
    messages: [
      "chị muốn tập yoga",
      "à mà chị đang đau lưng, có giải cơ không",
    ],
  },
  {
    name: "cold_lead_drop",
    description: "Khách lạnh đột ngột giữa chừng — 'để chị tham khảo thêm'.",
    messages: [
      "anh muốn tập gym tăng cơ",
      "anh tập 4 buổi/tuần, tối",
      "thôi để anh tham khảo thêm đã",
    ],
  },
  {
    name: "typo_lowercase_no_diacritics",
    description: "Tin nhắn không dấu, viết tắt — bot vẫn hiểu được.",
    messages: [
      "co tap gym de giam mo k a",
      "minh tap toi 3b/tuan",
    ],
  },

  // ═══════════ REAL-CASE REPLICATION (Messenger screenshots) ═══════════
  // Mô phỏng pattern thực tế khách production. Focus vào bugs đã thấy:
  // - Bot lặp hỏi service type dù khách đã trả lời/đã được recommend
  // - Bot không nhận khách đã chốt time → vẫn hỏi service thay vì xin tên/SĐT
  // - Bot không show pricing dù khách explicit "báo giá"
  // - Khách indecisive ("chưa biết tập gì") → bot phải recommend dứt khoát theo goal
  {
    name: "real_giam_can_open_vague",
    description:
      "Replicate screenshot: 'quan tâm' → 'giảm cân + báo chi phí' → rảnh sáng → 'chưa biết tập gì' → đắt → 'qua thời điểm nào' → 'sáng mai qua'. Bot KHÔNG được lặp hỏi gym/yoga/zumba sau khi đã chốt time.",
    messages: [
      "quan tâm",
      "Mình muốn giảm cân tư vấn mình dịch vụ phù hợp và báo các chi phí",
      "Mình rảnh vào buổi sáng hàng ngày",
      "Mình chưa biết tập gì, tư vấn cho mình",
      "Chi phí cao quá",
      "Mình có thể qua thời điểm nào",
      "Vậy sáng mai mình sẽ qua",
    ],
  },
  {
    name: "real_tang_co_bao_gia_ngay",
    description:
      "Khách hỏi pricing thẳng turn 1 cho mục tiêu tăng cơ — bot phải show pricing trong 1-2 turn đầu, không loop hỏi info.",
    messages: [
      "shop ơi tăng cơ thì gói nào báo giá luôn",
      "anh mới tập, chưa có nền",
      "anh tập 4 buổi/tuần, tối 7-9h",
      "ok cho anh xem hình phòng gym với",
    ],
  },
  {
    name: "real_indecisive_recommend",
    description:
      "Khách lười nghĩ — chỉ nói goal rồi 'chọn giúp em'. Bot phải recommend rõ + lý do, không hỏi lại.",
    messages: [
      "em muốn giảm cân với giảm stress",
      "em chưa biết môn nào, chị chọn giúp em",
      "vậy giá bao nhiêu chị",
    ],
  },
  {
    name: "real_chot_time_phai_xin_info",
    description:
      "Khách chốt time sớm — bot phải xin tên/SĐT để giữ slot, KHÔNG hỏi lại nhu cầu/bộ môn.",
    messages: [
      "có gói gym không",
      "anh tập sáng, để giảm mỡ",
      "ok mai 6h sáng anh qua",
    ],
  },
  {
    name: "real_so_sanh_2_dich_vu",
    description:
      "Khách so sánh 2 môn — bot phải tư vấn dứt khoát recommend môn phù hợp goal, không neutral.",
    messages: [
      "gym với yoga cái nào giảm cân tốt hơn",
      "chị mới sinh con 6 tháng, cần lấy lại dáng",
      "tập sáng hoặc tối tùy",
    ],
  },
  {
    name: "real_yoga_thu_gian_ngu",
    description:
      "Khách stress công việc, mất ngủ → yoga thư giãn. Bot pitch đúng yoga + lịch GV Ấn Độ.",
    messages: [
      "chị stress công việc, mất ngủ mấy tuần",
      "muốn tập yoga để thư giãn",
      "chị tập tối được, sau giờ làm",
      "1 tháng bao nhiêu chị",
    ],
  },
  {
    name: "real_boi_cho_con_hoc",
    description:
      "Khách đăng ký học bơi cho con — bot pitch học bơi 1-1 cam kết biết bơi, hỏi tuổi để chọn gói.",
    messages: [
      "shop có dạy bơi cho trẻ con không",
      "bé nhà chị 7 tuổi, chưa biết bơi tí nào",
      "muốn học 1-1 cho an toàn",
      "1 khóa hết bao nhiêu",
    ],
  },
  {
    name: "real_pilates_dau_lung",
    description:
      "Khách đau lưng do ngồi văn phòng → pilates. Bot recommend pilates máy phù hợp + giá.",
    messages: [
      "chị đau lưng do ngồi văn phòng nhiều",
      "có pilates không em",
      "muốn tập máy có HLV hướng dẫn",
      "lịch sao em báo chị",
    ],
  },
  {
    name: "real_zumba_giam_can_vui",
    description:
      "Khách trẻ thích zumba để vui + giảm cân. Bot pitch zumba GV Ấn Độ.",
    messages: [
      "em muốn tập gì vui vui mà giảm cân",
      "em hay buồn ngủ khi tập gym",
      "zumba thế nào",
      "có ca tối không",
    ],
  },
  {
    name: "real_giaico_ngoi_lau_dau_co",
    description:
      "Replicate Hoa Sen real case: nhân viên VP đau cổ vai gáy do ngồi máy tính.",
    messages: [
      "anh ngồi máy tính cả ngày, cổ vai gáy đau cứng",
      "nhiều tháng rồi, đi massage không đỡ",
      "có liệu trình gì không em",
      "ok cho anh thử 1 buổi sáng mai 10h",
    ],
  },
  {
    name: "real_giaico_lien_he_full",
    description:
      "Khách hỏi giải cơ + spa cùng lúc — bot pitch combo, không tách rời.",
    messages: [
      "bên em có giải cơ với spa massage không",
      "chị muốn vừa giải cơ vai gáy vừa thư giãn",
      "1 buổi tổng bao nhiêu thời gian, giá bao nhiêu",
    ],
  },
  {
    name: "real_xin_xem_truoc_roi_chot",
    description:
      "Khách kỹ tính: xin xem ảnh phòng tập trước → hài lòng mới chốt. Test gửi media + chuyển commitment.",
    messages: [
      "cho chị xem ảnh phòng tập gym với",
      "ok nhìn ổn, gói full 12 tháng nhiêu chị",
      "chị tên Hà, sđt 0911222333, chị qua chiều mai 5h",
    ],
  },
];

// ─────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────

interface TurnResult {
  turn: number;
  input: string;
  output: {
    reply: string | null;
    mediaUrls: string[] | null;
    qrUrl: string | null;
    nextStep: string | null;
  } | null;
  state: {
    flow: string;
    stage: string;
    intent: string;
    emotion: string;
    temperature: string;
    honorific: string;
    knownInfo: Record<string, unknown>;
    qrShown: boolean;
    mediaShown: boolean;
    sheetsWritten: boolean;
    turnCount: number;
  };
  duration_ms: number;
  workflow_status: string;
  error?: string;
}

interface ScenarioResult extends Scenario {
  threadId: string;
  startedAt: string;
  finishedAt: string;
  total_duration_ms: number;
  turns: TurnResult[];
  score?: ScenarioScoreType;
  error?: string;
}

async function runScenario(scenario: Scenario, runId: string): Promise<ScenarioResult> {
  const threadId = `test-${runId}-${scenario.name}`;
  const resourceId = "scenario-runner";
  const turns: TurnResult[] = [];
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();

  console.log(`\n===== ${scenario.name} =====`);
  console.log(`📝 ${scenario.description}`);
  console.log(`🧵 threadId=${threadId}`);

  for (let i = 0; i < scenario.messages.length; i++) {
    const msg = scenario.messages[i];
    const turnStart = Date.now();
    let workflowStatus = "unknown";
    let output: TurnResult["output"] = null;
    let turnError: string | undefined;

    try {
      const run = await routerWorkflow.createRun();
      const result = await run.start({
        inputData: { message: msg, threadId, resourceId },
      });
      workflowStatus = String((result as any).status ?? "unknown");

      const steps = (result as any).steps ?? {};
      const out =
        steps["call-fitness"]?.output ??
        steps["call-giai-co"]?.output ??
        steps["fallback"]?.output ??
        null;

      if (out) {
        output = {
          reply: out.reply ?? null,
          mediaUrls: out.mediaUrls ?? null,
          qrUrl: out.qrUrl ?? null,
          nextStep: out.nextStep ?? null,
        };
      }
    } catch (e) {
      turnError = String(e);
      console.error(`  ❌ turn ${i + 1} error:`, e);
    }

    const state = await loadState(mastra, threadId, resourceId);
    const duration = Date.now() - turnStart;

    const turnResult: TurnResult = {
      turn: i + 1,
      input: msg,
      output,
      state: {
        flow: state.flow,
        stage: state.stage,
        intent: state.intent,
        emotion: state.emotion,
        temperature: state.temperature,
        honorific: state.honorific,
        knownInfo: { ...state.knownInfo },
        qrShown: state.qrShown,
        mediaShown: state.mediaShown,
        sheetsWritten: state.sheetsWritten,
        turnCount: state.turnCount,
      },
      duration_ms: duration,
      workflow_status: workflowStatus,
      ...(turnError ? { error: turnError } : {}),
    };
    turns.push(turnResult);

    // Console summary
    const replyPreview =
      (output?.reply ?? "").slice(0, 80).replace(/\n/g, " ") || "(no reply)";
    const mediaCount = output?.mediaUrls?.length ?? 0;
    const qrFlag = output?.qrUrl ? "QR" : "  ";
    console.log(
      `  ${String(i + 1).padStart(2)}. [${state.stage.padEnd(11)} ${state.intent.padEnd(9)} ${qrFlag} M:${mediaCount}] ${duration}ms`,
    );
    console.log(`      KH: ${msg}`);
    console.log(`      BOT: ${replyPreview}${(output?.reply?.length ?? 0) > 80 ? "..." : ""}`);
  }

  const finishedAt = new Date().toISOString();

  // ─── Grade scenario ───
  const snapshots: TurnSnapshotType[] = turns.map((t) => ({
    turn: t.turn,
    input: t.input,
    reply: t.output?.reply ?? "",
    mediaCount: t.output?.mediaUrls?.length ?? 0,
    hasQR: !!t.output?.qrUrl,
    state: {
      flow: t.state.flow,
      stage: t.state.stage,
      intent: t.state.intent,
      knownInfo: t.state.knownInfo,
    },
  }));

  console.log(`  🧮 grading...`);
  const score = await gradeScenario(scenario.name, scenario.description, snapshots);
  console.log(
    `  📊 avg=${score.avg_score.toFixed(2)}/10 min=${score.min_turn_score}/10`,
  );
  if (score.total_issues.length > 0) {
    console.log(`  ⚠️  issues:`);
    for (const iss of score.total_issues.slice(0, 5)) {
      console.log(`     - ${iss}`);
    }
  }

  return {
    ...scenario,
    threadId,
    startedAt,
    finishedAt,
    total_duration_ms: Date.now() - overallStart,
    turns,
    score,
  };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  // Filter scenarios qua env SCENARIOS=name1,name2,... (substring match)
  // → Dùng khi iter fix nhanh, không muốn chạy full 33 scenarios.
  const filter = process.env.SCENARIOS?.trim();
  const selected = filter
    ? SCENARIOS.filter((s) =>
        filter.split(",").some((f) => s.name.includes(f.trim())),
      )
    : SCENARIOS;

  console.log(`\n🏃 Run ID: ${runId}`);
  console.log(`📦 Scenarios: ${selected.length}${filter ? ` (filter="${filter}")` : ""}`);

  const overallStart = Date.now();
  const scenarios: ScenarioResult[] = [];

  for (const s of selected) {
    try {
      const result = await runScenario(s, runId);
      scenarios.push(result);
    } catch (e) {
      console.error(`[${s.name}] fatal:`, e);
      scenarios.push({
        ...s,
        threadId: `test-${runId}-${s.name}`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        total_duration_ms: 0,
        turns: [],
        error: String(e),
      });
    }
  }

  // Aggregate scoring
  const scored = scenarios.filter((s) => s.score);
  const allAvgs = scored.map((s) => s.score!.avg_score);
  const overallAvg =
    allAvgs.length > 0 ? allAvgs.reduce((a, b) => a + b, 0) / allAvgs.length : 0;
  const minAvg = allAvgs.length > 0 ? Math.min(...allAvgs) : 0;

  const summary = {
    runId,
    startedAt: new Date(Date.now() - (Date.now() - overallStart)).toISOString(),
    finishedAt: new Date().toISOString(),
    total_duration_ms: Date.now() - overallStart,
    total_scenarios: scenarios.length,
    total_turns: scenarios.reduce((acc, s) => acc + s.turns.length, 0),
    failed_scenarios: scenarios.filter((s) => s.error).length,
    overall_avg_score: Math.round(overallAvg * 100) / 100,
    min_scenario_avg: Math.round(minAvg * 100) / 100,
    target_min: 9.0,
    passed: minAvg >= 9.0,
    scenarios,
  };

  const outDir = resolve(process.cwd(), "test-results");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `run-${runId}.json`);
  writeFileSync(outFile, JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n${"=".repeat(70)}`);
  console.log(`✓ Done. Saved: ${outFile}`);
  console.log(`  Scenarios: ${summary.total_scenarios} (failed: ${summary.failed_scenarios})`);
  console.log(`  Turns: ${summary.total_turns}`);
  console.log(`  Total time: ${(summary.total_duration_ms / 1000).toFixed(1)}s`);
  console.log(`\n📊 SCORE: avg=${overallAvg.toFixed(2)}/10  min=${minAvg.toFixed(2)}/10  ${summary.passed ? "✅ PASS" : "❌ FAIL (target ≥ 9.0)"}`);

  // Sort scenarios theo điểm tăng dần để dễ thấy chỗ thấp nhất
  const ranked = [...scored].sort((a, b) => a.score!.avg_score - b.score!.avg_score);
  console.log(`\nScenario ranking (thấp → cao):`);
  for (const s of ranked) {
    const sc = s.score!;
    const flag = sc.avg_score >= 9.0 ? "✅" : sc.avg_score >= 7.5 ? "⚠️ " : "❌";
    console.log(
      `  ${flag} ${sc.avg_score.toFixed(2)} (min ${sc.min_turn_score})  ${s.name.padEnd(30)} ${sc.total_issues.length} issues`,
    );
  }

  // Buộc exit vì Mastra giữ Postgres pool mở
  process.exit(summary.passed ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

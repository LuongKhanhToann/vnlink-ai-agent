/**
 * Test FULL kịch bản KH gửi (Fami).
 * Mỗi scenario replicate EXACTLY câu KH trong tài liệu để verify bot match tone.
 *
 * Run: npx tsx src/mastra/scripts/testFamiFull.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");

const SCENARIOS = [
  // ═══ CƠ BẢN ═══
  {
    name: "1_quan_tam",
    messages: ["Quan tâm"],
  },
  {
    name: "2_tap_trai_nghiem",
    messages: ["Tôi muốn tập trải nghiệm"],
  },
  {
    name: "3_giam_can",
    messages: ["Tôi muốn tập giảm cân"],
  },
  {
    name: "4_chuong_trinh_tap",
    messages: ["Tư vấn cho tôi về chương trình tập luyện"],
  },
  {
    name: "5_uu_dai",
    messages: ["có chương trình ưu đãi nào không?"],
  },

  // ═══ HỌC BƠI ═══
  {
    name: "6_hoc_boi_tre_em_full",
    messages: [
      "Quan tâm học bơi",
      "Quan tâm học bơi cho trẻ em",
      "cháu 6 tuổi em nhé",
      "ở nhà bé chỉ dám tắm vòi sen, chưa biết ngụp nước",
    ],
  },

  // ═══ GYM ═══
  {
    name: "7_gym_full",
    messages: [
      "Tôi quan tâm đến tập gym",
      "chưa, tôi chưa tập bao giờ",
      "muốn giảm cân",
      "Tập gym bao nhiêu tiền/tháng?",
    ],
  },

  // ═══ YOGA ═══
  {
    name: "8_yoga_full",
    messages: [
      "Quan tâm Yoga",
      "chị chưa tập, có lớp cho người mới không em?",
      "Bao nhiêu tiền/tháng em?",
      "ĐK trải nghiệm như thế nào?",
    ],
  },

  // ═══ ZUMBA ═══
  {
    name: "9_zumba_full",
    messages: [
      "Quan tâm zumba",
      "chị chưa tập, có lớp cho người mới không em?",
      "Tập Zumba có giảm cân không?",
      "Ừ, chị đang có nhu cầu Giảm cân, chị thấy mọi người bảo giảm cân nên tập Aerobic",
      "Có được tập thử không?",
      "Chị đi được, thế có những gói giá nào thế em? chị chưa tập bao giờ",
    ],
  },

  // ═══ BƠI FAQ ═══
  {
    name: "10_boi_faq",
    messages: [
      "Bể bơi mở cửa mấy giờ?",
      "Nước bể có ấm không em? Bể trong nhà hay ngoài trời?",
      "Có nhất thiết phải mặc đồ bơi không?",
      "Bể bơi có clo không?",
    ],
  },

  // ═══ FULL DỊCH VỤ ═══
  {
    name: "11_full_chua_biet",
    messages: [
      "Em ơi chị đang chưa biết tập gì, em cho chị tham khảo",
      "Chị không, chị đi qua tham quan thôi. Em hỗ trợ các gói cho chị",
      "Chị đang béo quá, muốn giảm cân",
      "Thế nếu sau khi giảm cân rồi, muốn tập duy trì thì sao? Thỉnh thoảng chị cũng hay mất ngủ",
      "Chị chưa tập gì đâu, nên cho chị hỏi có ai hướng dẫn không?",
      "Thế này chị đăng kí gói Full nhỉ?",
    ],
  },
];

const filter = process.env.SCENARIOS?.trim();
const selected = filter
  ? SCENARIOS.filter((s) => filter.split(",").some((f) => s.name.includes(f.trim())))
  : SCENARIOS;

async function run() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  for (const s of selected) {
    const threadId = `test-fami-full-${runId}-${s.name}`;
    const resourceId = "fami-full-tester";

    console.log(`\n${"═".repeat(78)}`);
    console.log(`▶  ${s.name}`);
    console.log(`${"═".repeat(78)}`);

    for (let i = 0; i < s.messages.length; i++) {
      const msg = s.messages[i];
      try {
        const run = await routerWorkflow.createRun();
        const result = await run.start({
          inputData: { message: msg, threadId, resourceId },
        });
        const steps = (result as any).steps ?? {};
        const out =
          steps["call-fitness"]?.output ??
          steps["call-giai-co"]?.output ??
          steps["fallback"]?.output ??
          null;

        const state = await loadState(mastra, threadId, resourceId);
        const reply = (out?.reply ?? "(no reply)").trim();

        console.log(`\n[${i + 1}] KH: ${msg}`);
        console.log(
          `    state: stage=${state.stage} intent=${state.intent} goal=${state.knownInfo.fitnessGoal ?? "-"} svc=${state.knownInfo.serviceType ?? "-"} mt=${state.knownInfo.memberType ?? "-"}`,
        );
        console.log(`    BOT: ${reply.replace(/\n/g, "\n         ")}`);
      } catch (e) {
        console.error(`[${i + 1}] ❌ error:`, e);
      }
    }
  }

  process.exit(0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

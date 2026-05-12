/**
 * Test scenario theo TÀI LIỆU FAMI thực tế.
 * Verify bot bắt chước đúng tone: greeting "cảm ơn anh/chị đã quan tâm",
 * discovery deep từng câu, trial-first close, storytelling.
 *
 * Run: npx tsx src/mastra/scripts/testFamiTone.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");

const SCENARIOS = [
  {
    name: "fami_quan_tam",
    description: "KH chỉ nhắn 'quan tâm' — kiểm greeting Fami",
    messages: ["quan tâm"],
  },
  {
    name: "fami_gym_discovery",
    description: "KH muốn tập gym — kiểm discovery deep (đã tập chưa → mục tiêu)",
    messages: [
      "tôi quan tâm đến tập gym",
      "tôi chưa tập bao giờ",
      "muốn giảm cân",
    ],
  },
  {
    name: "fami_yoga_new",
    description: "KH chưa từng tập yoga — kiểm trấn an + trial close",
    messages: [
      "quan tâm yoga",
      "chị chưa tập, có lớp cho người mới không em",
      "bao nhiêu tiền/tháng em",
    ],
  },
  {
    name: "fami_boi_tre_em",
    description: "KH hỏi học bơi cho con — kiểm hỏi tuổi + test bạo nước",
    messages: [
      "shop có dạy bơi cho trẻ con không",
      "bé nhà chị 6 tuổi",
      "ở nhà bé chỉ dám tắm vòi sen thôi, chưa biết ngụp nước",
    ],
  },
  {
    name: "fami_uu_dai",
    description: "KH hỏi ưu đãi — kiểm trial-first close, không bung gói ngay",
    messages: [
      "có chương trình ưu đãi nào không",
    ],
  },
];

async function run() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  for (const s of SCENARIOS) {
    const threadId = `test-fami-${runId}-${s.name}`;
    const resourceId = "fami-tester";

    console.log(`\n${"═".repeat(72)}`);
    console.log(`▶  ${s.name}`);
    console.log(`   ${s.description}`);
    console.log(`${"═".repeat(72)}`);

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
          `    state: stage=${state.stage} intent=${state.intent} goal=${state.knownInfo.fitnessGoal ?? "-"} svc=${state.knownInfo.serviceType ?? "-"}`,
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

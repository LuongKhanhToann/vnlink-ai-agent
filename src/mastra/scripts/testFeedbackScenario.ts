/**
 * scripts/testFeedbackScenario.ts
 *
 * Replicate đoạn chat KH feedback để verify thay đổi A + D + G:
 *   - A: temperature 0.85
 *   - G: ACK variation pool
 *   - D: compress bloated GATEs
 *
 * Run: npx tsx src/mastra/scripts/testFeedbackScenario.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");

const SCENARIOS = [
  {
    name: "feedback_v2_boi_giam_can",
    description: "KH feedback v2 screenshot: hỏi bơi + giảm cân ngắn. Kiểm naturalness.",
    messages: [
      "alo",
      "mình muốn hỏi dịch vụ bơi và muốn hỏi giảm cân",
      "tư vấn mình chương trình giảm cân và chi phí phù hợp nhất",
      "mình đang hỏi giảm cân thôi",
    ],
  },
  {
    name: "feedback_short_replies",
    description: "KH reply ngắn liên tục — kiểm ACK luân phiên",
    messages: [
      "có gì mới không em",
      "ờ",
      "tư vấn gói giảm cân đi",
      "3 buổi/tuần",
      "sáng",
      "ok thử 1 buổi",
    ],
  },
  {
    name: "feedback_pt_request",
    description: "KH cần PT — kiểm pitch PT trực tiếp",
    messages: [
      "anh muốn có HLV riêng để tăng cơ",
      "anh mới tập, sợ sai tư thế",
      "3 buổi/tuần, sáng",
    ],
  },
];

async function run() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");

  for (const s of SCENARIOS) {
    const threadId = `test-feedback-${runId}-${s.name}`;
    const resourceId = "feedback-tester";

    console.log(`\n${"═".repeat(70)}`);
    console.log(`▶  ${s.name}`);
    console.log(`   ${s.description}`);
    console.log(`${"═".repeat(70)}`);

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
          `    state: stage=${state.stage} intent=${state.intent} ` +
            `goal=${state.knownInfo.fitnessGoal ?? "-"} ` +
            `svc=${state.knownInfo.serviceType ?? "-"}`,
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

/**
 * scripts/testFeedbackScenario.ts
 *
 * Replicate đoạn chat từ screenshot KH feedback để verify fix:
 *   - Phân biệt dịch vụ vs giải pháp
 *   - Lock vào giải pháp khi đã biết goal
 *   - Không trả giá khi KH hỏi LỊCH lớp
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
    name: "feedback_giam_can_boi",
    description:
      "KH feedback screenshot: hỏi học bơi + giảm cân, sau đó lặp lại 'mình hỏi giảm cân', rồi hỏi lịch lớp. Kiểm: (1) không list lại 4 dịch vụ khi đã có goal; (2) không lặp combo gym+bơi 3 lần; (3) không trả giá khi hỏi lịch lớp.",
    messages: [
      "alo",
      "Mình muốn hỏi dịch vụ học bơi",
      "Và mình muốn giảm cân",
      "Tư vấn cho mình chương trình tập giảm cân và chi phí phù hợp nhất",
      "Mình đang hỏi về chương trình giảm cân",
      "đo inbody là gì?",
      "Cho mình xin lịch hoạt động của trung tâm",
      "Lịch học lớp học bơi và lịch học các bộ môn khác",
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
    console.log(`   threadId=${threadId}`);
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

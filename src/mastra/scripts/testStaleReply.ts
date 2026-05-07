/**
 * Test isolated cho stale-drop pattern.
 * Không gọi LLM thật — mock workflow bằng setTimeout.
 *
 * Run: npx tsx src/mastra/scripts/testStaleReply.ts
 */

const seq = new Map<string, number>();
const sentReplies: Array<{ senderId: string; text: string; ts: number }> = [];

function enqueue(senderId: string) {
  seq.set(senderId, (seq.get(senderId) ?? 0) + 1);
}

async function handle(senderId: string, text: string, llmDelayMs: number) {
  const mySeq = seq.get(senderId) ?? 0;
  const isStale = () => (seq.get(senderId) ?? 0) !== mySeq;

  console.log(`  [handle] start "${text}" mySeq=${mySeq}`);
  await new Promise((r) => setTimeout(r, llmDelayMs)); // mock LLM call

  if (isStale()) {
    console.log(
      `  [handle] DROP "${text}" — stale (mySeq=${mySeq}, latest=${seq.get(senderId)})`,
    );
    return;
  }

  console.log(`  [handle] SEND "${text}"`);
  sentReplies.push({ senderId, text, ts: Date.now() });
}

async function scenarioA() {
  console.log("\n═══ Scenario A: KH gõ 1 tin, không có race ═══");
  seq.clear();
  sentReplies.length = 0;

  enqueue("user1");
  await handle("user1", "tin 1", 100);

  console.log(`  → Sent: ${sentReplies.length} reply (expect 1)`);
  console.log(
    `  → ${sentReplies.length === 1 ? "✅ PASS" : "❌ FAIL"} expected 1 reply`,
  );
}

async function scenarioB() {
  console.log("\n═══ Scenario B: KH gõ tin 2 lúc bot đang xử lý tin 1 ═══");
  seq.clear();
  sentReplies.length = 0;

  enqueue("user1");
  const promise1 = handle("user1", "tin 1 (LLM 500ms)", 500);

  // Sau 100ms, KH gõ tin 2 (lúc bot đang chạy LLM cho tin 1)
  setTimeout(() => {
    console.log(`  [event] KH gõ tin 2 lúc bot đang xử lý tin 1`);
    enqueue("user1");
    void handle("user1", "tin 2 (LLM 200ms)", 200);
  }, 100);

  await promise1;
  await new Promise((r) => setTimeout(r, 600)); // wait for tin 2 finish

  console.log(`  → Sent: ${sentReplies.length} reply (expect 1)`);
  console.log(
    `  → ${sentReplies.length === 1 ? "✅ PASS" : "❌ FAIL"} expected 1 reply (tin 2 only)`,
  );
  if (sentReplies.length === 1) {
    console.log(`     Reply gửi: "${sentReplies[0].text}"`);
    console.log(
      `     ${sentReplies[0].text.startsWith("tin 2") ? "✅" : "❌"} expected "tin 2"`,
    );
  }
}

async function scenarioC() {
  console.log("\n═══ Scenario C: KH gõ 3 tin liên tiếp ═══");
  seq.clear();
  sentReplies.length = 0;

  enqueue("user1");
  void handle("user1", "tin 1", 400);

  setTimeout(() => {
    enqueue("user1");
    void handle("user1", "tin 2", 400);
  }, 50);

  setTimeout(() => {
    enqueue("user1");
    void handle("user1", "tin 3", 200);
  }, 100);

  await new Promise((r) => setTimeout(r, 700));
  console.log(`  → Sent: ${sentReplies.length} reply (expect 1)`);
  console.log(
    `  → ${sentReplies.length === 1 ? "✅ PASS" : "❌ FAIL"} expected 1 reply (tin 3 only)`,
  );
  if (sentReplies.length === 1) {
    console.log(
      `     ${sentReplies[0].text === "tin 3" ? "✅" : "❌"} expected "tin 3", got "${sentReplies[0].text}"`,
    );
  }
}

async function scenarioD() {
  console.log("\n═══ Scenario D: 2 user khác nhau (không can thiệp lẫn nhau) ═══");
  seq.clear();
  sentReplies.length = 0;

  enqueue("userA");
  void handle("userA", "userA tin 1", 200);

  enqueue("userB");
  void handle("userB", "userB tin 1", 200);

  await new Promise((r) => setTimeout(r, 400));
  console.log(`  → Sent: ${sentReplies.length} replies (expect 2)`);
  console.log(
    `  → ${sentReplies.length === 2 ? "✅ PASS" : "❌ FAIL"} expected 2 replies (userA + userB không can thiệp nhau)`,
  );
}

async function main() {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  console.log("\n═══ Done ═══");
  process.exit(0);
}

main();

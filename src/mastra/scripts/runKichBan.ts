/**
 * runKichBan.ts — runner cho KỊCH BẢN test luồng lớn (xem scenarios.ts).
 *
 * Mỗi scenario chạy trên 1 threadId MỚI (tự "reset" — không dính state cũ),
 * bơm từng turn qua routerWorkflow, in reply + state để soi funnel mắt thường.
 *
 * Chạy:
 *   npm run test:kichban             # liệt kê id rồi thoát
 *   npm run test:kichban -- L1       # 1 luồng
 *   npm run test:kichban -- L3 E1    # nhiều luồng
 *   npm run test:kichban -- all      # tất cả (tốn token!)
 *
 * (hoặc trực tiếp: STORAGE_BACKEND=libsql npx tsx src/mastra/scripts/runKichBan.ts L3)
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");
const { SCENARIOS, getScenario } = await import("./scenarios");
type Scenario = import("./scenarios").Scenario;

const SEP = "═".repeat(82);
const SUB = "─".repeat(82);

const { checkInvariants } = await import("../lib/invariants");

function printList(): void {
  console.log(`\n${SEP}`);
  console.log("KỊCH BẢN có sẵn — chạy:  npm run test:kichban -- <id> [<id>…]  |  all");
  console.log(SEP);
  for (const s of SCENARIOS) {
    console.log(`  ${s.id.padEnd(4)} ${s.title}`);
    console.log(`       ${s.goal}`);
  }
  console.log("");
}

/** Một dòng state gọn, hiện slot của CẢ 2 flow (chỉ in field có giá trị). */
function stateLine(state: any): string {
  const k = state.knownInfo ?? {};
  const parts: string[] = [
    `flow=${state.flow}`,
    `stage=${state.stage}`,
    `intent=${state.intent}`,
  ];
  const slots: Array<[string, any]> = [
    ["goal", k.fitnessGoal],
    ["svc", k.serviceType],
    ["mt", k.memberType],
    ["pain", k.painArea],
    ["spread", k.painSpread],
    ["dur", k.painDuration],
    ["past", k.pastMethod],
    ["pkg", k.sessionPackage],
    ["time", k.preferredTime],
    ["name", k.name],
    ["phone", k.phone],
  ];
  for (const [label, val] of slots) {
    if (val) parts.push(`${label}=${val}`);
  }
  return parts.join(" ");
}

/** Vi phạm invariant gom lại (in ở summary cuối). */
interface Violation {
  scenario: string;
  turn: number;
  msg: string;
  reason: string;
}

async function runScenario(
  scn: Scenario,
  idx: number,
  total: number,
  violations: Violation[],
): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const threadId = `test-${scn.id.toLowerCase()}-${runId}`;
  const resourceId = `kichban-tester-${scn.id.toLowerCase()}`;

  console.log(`\n${SEP}`);
  console.log(`[${idx + 1}/${total}] ${scn.title}`);
  console.log(`   🎯 ${scn.goal}`);
  console.log(`   thread=${threadId}`);
  console.log(SEP);

  for (let i = 0; i < scn.turns.length; i++) {
    const { msg, expect } = scn.turns[i];
    try {
      const r = await routerWorkflow.createRun();
      const result = await r.start({ inputData: { message: msg, threadId, resourceId } });
      const steps = (result as any).steps ?? {};
      const out =
        steps["call-fitness"]?.output ??
        steps["call-giai-co"]?.output ??
        steps["fallback"]?.output ??
        null;

      const state = await loadState(mastra, threadId, resourceId);
      const reply = (out?.reply ?? "(no reply)").trim();
      const media = out?.mediaUrls ?? null;
      const qr = out?.qrUrl ?? null;

      console.log(`\n${SUB}`);
      console.log(`[${i + 1}] KH: ${msg}`);
      console.log(`    › kỳ vọng: ${expect}`);
      console.log(`    state: ${stateLine(state)}`);
      if (media && (Array.isArray(media) ? media.length : true)) {
        console.log(`    📎 MEDIA: ${JSON.stringify(media)}`);
      }
      if (qr) console.log(`    🔳 QR: ${qr}`);
      console.log(`    BOT: ${reply.replace(/\n/g, "\n         ")}`);

      // Lưới gác TẤT ĐỊNH — vi phạm in ngay + gom vào summary.
      const turnViolations = checkInvariants({ state, out, reply });
      for (const reason of turnViolations) {
        console.log(`    ❌ ${reason}`);
        violations.push({ scenario: scn.id, turn: i + 1, msg, reason });
      }
    } catch (e) {
      console.error(`[${i + 1}] ❌ error:`, e);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter(Boolean);

  if (argv.length === 0) {
    printList();
    process.exit(0);
  }

  let selected: Scenario[];
  if (argv.length === 1 && argv[0].toLowerCase() === "all") {
    selected = SCENARIOS;
  } else {
    selected = [];
    for (const id of argv) {
      const scn = getScenario(id);
      if (!scn) {
        console.error(`⚠ không tìm thấy kịch bản id="${id}" — bỏ qua. (chạy không tham số để xem danh sách)`);
        continue;
      }
      selected.push(scn);
    }
  }

  if (selected.length === 0) {
    console.error("Không có kịch bản hợp lệ để chạy.");
    printList();
    process.exit(1);
  }

  const violations: Violation[] = [];
  for (let i = 0; i < selected.length; i++) {
    await runScenario(selected[i], i, selected.length, violations);
  }

  console.log(`\n${SEP}`);
  if (violations.length === 0) {
    console.log(`✅ Xong ${selected.length} kịch bản — 0 vi phạm invariant.`);
    console.log(SEP);
    process.exit(0);
  }
  console.log(`❌ Xong ${selected.length} kịch bản — ${violations.length} VI PHẠM INVARIANT:`);
  for (const x of violations) {
    console.log(`   [${x.scenario} T${x.turn}] ${x.reason}  ← KH: "${x.msg}"`);
  }
  console.log(SEP);
  process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * scripts/ingestScenarios.ts — Nạp 50 kịch bản (Mục V, nguyên văn) vào bảng scenario_playbook.
 *
 * Nguồn: src/mastra/data/scenarios.json (đã chắt từ tài liệu khách, byte-for-byte). Idempotent
 * (upsert theo id). Chạy: npx -y tsx src/mastra/scripts/ingestScenarios.ts
 */

import { readFileSync } from "node:fs";
import "dotenv/config";
import { upsertScenario, countScenarios, type ScenarioRecord } from "../engine/scenarios";
import { isObjectionCode, isServiceCode, type ObjectionCode, type ServiceCode } from "../engine/taxonomy";

interface RawScenario {
  id: string;
  service: string;
  segment: string;
  objections: string[];
  portrait: string;
  script: string;
  knowledge_hooks: string[];
  source_heading: string;
  prices_found: string[];
  truncated?: boolean;
}

async function main() {
  const path = new URL("../data/scenarios.json", import.meta.url);
  const rows = JSON.parse(readFileSync(path, "utf8")) as RawScenario[];
  console.log(`[ingestScenarios] đọc ${rows.length} kịch bản từ data/scenarios.json`);

  let ok = 0;
  const problems: string[] = [];
  for (const r of rows) {
    if (!isServiceCode(r.service)) {
      problems.push(`${r.id}: service lạ (${r.service})`);
      continue;
    }
    const objections = (r.objections || []).filter(isObjectionCode) as ObjectionCode[];
    if (!objections.length) problems.push(`${r.id}: không có objection hợp lệ`);
    const rec: ScenarioRecord = {
      id: r.id,
      service: r.service as ServiceCode,
      segment: r.segment || "khac",
      objections,
      portrait: r.portrait || "",
      script: r.script || "",
      knowledgeHooks: r.knowledge_hooks || [],
      sourceHeading: r.source_heading || "",
      pricesFound: r.prices_found || [],
    };
    try {
      await upsertScenario(rec); // tuần tự (concurrency=1)
      ok++;
    } catch (e) {
      problems.push(`${r.id}: upsert lỗi — ${(e as Error).message}`);
    }
  }

  const total = await countScenarios();
  console.log(`[ingestScenarios] upsert OK ${ok}/${rows.length}; tổng trong bảng: ${total}`);
  if (problems.length) console.warn(`[ingestScenarios] lưu ý:\n - ${problems.join("\n - ")}`);
  process.exit(problems.some((p) => p.includes("lỗi") || p.includes("lạ")) ? 1 : 0);
}

main().catch((e) => {
  console.error("[ingestScenarios] FAILED:", e);
  process.exit(1);
});

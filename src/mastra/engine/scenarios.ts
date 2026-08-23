/**
 * engine/scenarios.ts — L3: Kho kịch bản (Mục V, 50 tình huống). Lưu NGUYÊN VĂN P.A.E.S.C của tài
 * liệu; chọn theo PHÂN LOẠI (service + objection), KHÔNG vector, KHÔNG cache. Mỗi lượt chỉ kéo các
 * bản ghi thuộc đúng service rồi xếp hạng trong RAM (≤ 10 dòng/service) — nhẹ, luôn tươi, admin sửa
 * được. Con số giá trong kịch bản chỉ là minh hoạ; giá thật do L4 (RAG) quyết (xem L0 + L6).
 */

import { Pool } from "pg";
import "dotenv/config";
import type { ObjectionCode, ServiceCode, StageCode } from "./taxonomy";
import type { TurnClassification } from "./classifier";

export interface ScenarioRecord {
  id: string;
  service: ServiceCode;
  segment: string;
  objections: ObjectionCode[];
  portrait: string;
  script: string;
  knowledgeHooks: string[];
  sourceHeading: string;
  pricesFound: string[];
}

const THETA_BIND = (() => {
  const v = Number(process.env.THETA_BIND);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
})();
const TOP_K = 2;

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
      max: 4,
    });
    pool.on("error", (e) => console.error("[scenarios] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS scenario_playbook (
           id             TEXT PRIMARY KEY,
           service        TEXT   NOT NULL,
           segment        TEXT   NOT NULL DEFAULT 'khac',
           objections     TEXT[] NOT NULL DEFAULT '{}',
           portrait       TEXT   NOT NULL DEFAULT '',
           script         TEXT   NOT NULL DEFAULT '',
           knowledge_hooks TEXT[] NOT NULL DEFAULT '{}',
           source_heading TEXT   NOT NULL DEFAULT '',
           prices_found   TEXT[] NOT NULL DEFAULT '{}',
           updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(async () => {
        await getPool().query(
          `CREATE INDEX IF NOT EXISTS scenario_playbook_service ON scenario_playbook(service)`,
        );
      })
      .catch((e) => {
        console.error("[scenarios] ensureSchema failed:", e);
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

function rowToRecord(r: any): ScenarioRecord {
  return {
    id: String(r.id),
    service: r.service as ServiceCode,
    segment: String(r.segment ?? "khac"),
    objections: (r.objections ?? []) as ObjectionCode[],
    portrait: String(r.portrait ?? ""),
    script: String(r.script ?? ""),
    knowledgeHooks: (r.knowledge_hooks ?? []) as string[],
    sourceHeading: String(r.source_heading ?? ""),
    pricesFound: (r.prices_found ?? []) as string[],
  };
}

async function loadByService(service: ServiceCode): Promise<ScenarioRecord[]> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT * FROM scenario_playbook WHERE service = $1`, [service]);
  return rows.map(rowToRecord);
}

/**
 * Chọn kịch bản (Mục 6 SDD). Binding TĂNG DẦN: chưa rõ service, hoặc chưa có objection đủ tin cậy
 * (< θ_bind) → [] (để L2 needs-map dẫn dắt). Đủ tin cậy → xếp theo (#objection trùng, khớp segment,
 * tổng confidence), lấy top-K. FAIL-OPEN: lỗi bất kỳ → [].
 */
export async function selectScenarios(cls: TurnClassification): Promise<ScenarioRecord[]> {
  try {
    if (!cls.service) return [];
    const maxConf = cls.objections.length ? Math.max(...cls.objections.map((o) => o.confidence)) : 0;
    if (!cls.objections.length || maxConf < THETA_BIND) return [];

    const classified = new Set<string>(cls.objections.map((o) => o.code));
    const confOf = new Map<string, number>(cls.objections.map((o) => [o.code, o.confidence]));
    const cands = await loadByService(cls.service);

    const scored = cands
      .map((rec) => {
        const overlap = rec.objections.filter((o) => classified.has(o));
        if (!overlap.length) return null;
        const overlapConf = overlap.reduce((s, o) => s + (confOf.get(o) ?? 0), 0);
        const segMatch = cls.segment && rec.segment === cls.segment ? 1 : 0;
        // Ưu tiên: nhiều objection trùng > khớp segment > tổng confidence.
        const rank = overlap.length * 100 + segMatch * 10 + overlapConf;
        return { rec, rank };
      })
      .filter((x): x is { rec: ScenarioRecord; rank: number } => x !== null)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, TOP_K);

    return scored.map((x) => x.rec);
  } catch (e) {
    console.error("[scenarios] selectScenarios fail-open []:", (e as Error).message);
    return [];
  }
}

/** Khối [KỊCH BẢN MẪU] bơm vào prompt (nguyên văn, tối đa TOP_K). "" nếu rỗng. */
export function scenarioBlock(records: ScenarioRecord[]): string {
  if (!records.length) return "";
  const body = records
    .map((r, i) => {
      const portrait = r.portrait.trim() ? `Chân dung & nhu cầu:\n${r.portrait.trim()}\n\n` : "";
      return `--- Kịch bản mẫu ${i + 1} (${r.sourceHeading || r.id}) ---\n${portrait}Văn mẫu tư vấn (diễn lại theo văn phong này, KHÔNG chép nguyên si, số giá lấy theo [TÀI LIỆU THAM KHẢO]):\n${r.script.trim()}`;
    })
    .join("\n\n");
  return `═══ KỊCH BẢN MẪU (tình huống khớp với khách lúc này — bám ý & văn phong, diễn lại tự nhiên) ═══
${body}`;
}

// ── Dùng cho ingest / smoke ──
export async function upsertScenario(rec: ScenarioRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO scenario_playbook (id, service, segment, objections, portrait, script, knowledge_hooks, source_heading, prices_found, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (id) DO UPDATE SET
       service=EXCLUDED.service, segment=EXCLUDED.segment, objections=EXCLUDED.objections,
       portrait=EXCLUDED.portrait, script=EXCLUDED.script, knowledge_hooks=EXCLUDED.knowledge_hooks,
       source_heading=EXCLUDED.source_heading, prices_found=EXCLUDED.prices_found, updated_at=NOW()`,
    [
      rec.id,
      rec.service,
      rec.segment,
      rec.objections,
      rec.portrait,
      rec.script,
      rec.knowledgeHooks,
      rec.sourceHeading,
      rec.pricesFound,
    ],
  );
}

export async function countScenarios(): Promise<number> {
  await ensureSchema();
  const { rows } = await getPool().query(`SELECT COUNT(*)::int AS n FROM scenario_playbook`);
  return rows[0]?.n ?? 0;
}

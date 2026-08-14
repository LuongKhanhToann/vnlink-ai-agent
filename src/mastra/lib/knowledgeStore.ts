/**
 * knowledgeStore.ts
 *
 * Kho KIẾN THỨC ĐỘNG mà web admin cho khách sửa, đọc THẲNG từ Postgres MỖI request (không cache).
 * Gồm 2 phần:
 *   1. Các CỤC PROMPT (văn phong, ranh giới, thân bài fitness/giải cơ, chốt lịch…) — xem
 *      `PROMPT_BLOCKS` trong engine/gemma/prompt.ts. Lưu mỗi cục 1 dòng key=value (text).
 *   2. BẢNG GIÁ có cấu trúc — lưu 1 dòng key="prices", value = JSON của PriceData
 *      (engine/gemma/pricing.ts). Merge lên DEFAULT_PRICE_DATA nên field nào chưa sửa vẫn đúng.
 *
 * Nguyên tắc (giống botControl.ts):
 *   - Pool riêng, CÙNG credentials Supabase. Connection pooling ≠ cache dữ liệu.
 *   - Đọc mỗi lượt: sửa trên admin → có hiệu lực ngay ở tin kế tiếp, KHÔNG cần deploy.
 *   - FAIL-OPEN: DB lỗi → trả về mặc định (blocks rỗng + giá default) để bot KHÔNG câm.
 *   - Chưa cấu hình gì (bảng trống) → mọi thứ = bản đang chạy live (default), hành vi KHÔNG đổi.
 */

import { Pool } from "pg";
import "dotenv/config";
import { PROMPT_BLOCKS, type PromptOverrides } from "../engine/gemma/prompt";
import { DEFAULT_PRICE_DATA, type PriceData, type Card } from "../engine/gemma/pricing";

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
      max: 2,
    });
    pool.on("error", (e) => console.error("[knowledgeStore] pool error:", e));
  }
  return pool;
}

/** Key đặc biệt lưu toàn bộ bảng giá (JSON) — tách khỏi các key cục prompt (text thuần). */
const PRICE_KEY = "prices";
/** Tập key hợp lệ của cục prompt (chặn ghi rác vào bảng). */
const BLOCK_KEYS = new Set(PROMPT_BLOCKS.map((b) => b.key));

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS bot_content (
           key        TEXT PRIMARY KEY,
           value      TEXT        NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         );
         CREATE TABLE IF NOT EXISTS promotions (
           id         BIGSERIAL PRIMARY KEY,
           title      TEXT        NOT NULL,
           content    TEXT        NOT NULL,
           start_date DATE,
           end_date   DATE,
           active     BOOLEAN     NOT NULL DEFAULT TRUE,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(() => {
        console.log("[knowledgeStore] schema ready");
      })
      .catch((e) => {
        console.error("[knowledgeStore] ensureSchema failed:", e);
        schemaReady = null; // cho retry
        throw e;
      });
  }
  return schemaReady;
}

/** Kiến thức động đã trộn với mặc định — thứ pipeline dùng để lắp prompt + báo giá. */
export interface Knowledge {
  /** Chỉ chứa cục khách ĐÃ sửa (key→text); cục thiếu → buildSystemPrompt tự dùng default. */
  blocks: PromptOverrides;
  /** Bảng giá đã merge lên default (luôn đầy đủ field). */
  prices: PriceData;
  /**
   * Khối CHƯƠNG TRÌNH ƯU ĐÃI đang trong hạn (admin cấu hình) — đã format sẵn để nhét vào
   * system prompt. RỖNG khi không có đợt nào đang chạy → prompt không đổi (hành vi mặc định).
   */
  promos: string;
}

const DEFAULT_KNOWLEDGE: Knowledge = { blocks: {}, prices: DEFAULT_PRICE_DATA, promos: "" };

const asStr = (v: unknown, fb: string): string =>
  typeof v === "string" && v.length ? v : fb;

/** Nhận diện 1 card hợp lệ: có ten (chuỗi) + moc là mảng cặp [nhãn, giá]. */
function validCard(c: unknown): c is Card {
  if (!c || typeof c !== "object") return false;
  const x = c as any;
  return (
    typeof x.ten === "string" &&
    Array.isArray(x.moc) &&
    x.moc.every((m: unknown) => Array.isArray(m) && m.length === 2 && typeof m[0] === "string" && typeof m[1] === "string")
  );
}

/**
 * Trộn JSON đã lưu lên DEFAULT_PRICE_DATA — field/card nào sai kiểu hoặc thiếu thì GIỮ default.
 * Không bao giờ ném lỗi (giá là nghiệp vụ sống còn — thà dùng default còn hơn crash lượt trả lời).
 */
function mergePrices(raw: unknown): PriceData {
  const d = DEFAULT_PRICE_DATA;
  if (!raw || typeof raw !== "object") return d;
  const r = raw as any;

  const cards = { ...d.cards };
  if (r.cards && typeof r.cards === "object") {
    for (const k of Object.keys(d.cards) as (keyof typeof d.cards)[]) {
      if (validCard(r.cards[k])) cards[k] = { ten: r.cards[k].ten, moc: r.cards[k].moc };
    }
  }
  const bangKhac = { ...d.bangKhac };
  if (r.bangKhac && typeof r.bangKhac === "object") {
    for (const k of Object.keys(d.bangKhac) as (keyof typeof d.bangKhac)[]) {
      if (typeof r.bangKhac[k] === "string" && r.bangKhac[k].length) bangKhac[k] = r.bangKhac[k];
    }
  }
  return {
    cards,
    bangKhac,
    giaDinh: asStr(r.giaDinh, d.giaDinh),
    giaiCoLe: asStr(r.giaiCoLe, d.giaiCoLe),
    giaiCoLieuTrinh: asStr(r.giaiCoLieuTrinh, d.giaiCoLieuTrinh),
    gymTapThua: asStr(r.gymTapThua, d.gymTapThua),
    giamCanGoi: asStr(r.giamCanGoi, d.giamCanGoi),
  };
}

/** Ghép danh sách ưu đãi đang chạy thành khối nhét prompt. Rỗng vào → chuỗi rỗng (prompt không đổi). */
function formatPromoBlock(promos: { title: string; content: string }[]): string {
  if (!promos.length) return "";
  const lines = promos.map((p) => `- ${p.title}: ${p.content}`.trim()).join("\n");
  return `═══ CHƯƠNG TRÌNH ƯU ĐÃI ĐANG ÁP DỤNG (admin cấu hình — CÓ THẬT, em ĐƯỢC PHÉP nói cho khách) ═══
${lines}
⚠ Chỉ nêu khi khách hỏi ưu đãi/khuyến mãi hoặc khi thật sự phù hợp; giá gói vẫn theo BẢNG GIÁ. Ngoài các ưu đãi liệt kê ở đây (và các ưu đãi cố định: gói dài đơn giá tốt hơn, đi nhóm/gia đình, quà kèm theo mốc gói, khoá học bơi tặng 2 tháng), TUYỆT ĐỐI KHÔNG tự bịa thêm quà/giá/chương trình nào khác.`;
}

/**
 * Nạp TOÀN BỘ kiến thức động (cục prompt + bảng giá + ưu đãi đang hạn). FAIL-OPEN: lỗi DB → mặc định.
 * Gọi 1 lần/lượt ở đầu pipeline rồi truyền xuống buildSystemPrompt/buildPriceDirective.
 * Lọc ưu đãi theo CURRENT_DATE ngay trong SQL → đợt hết hạn tự biến mất, không cần tắt tay.
 */
export async function loadKnowledge(): Promise<Knowledge> {
  try {
    await ensureSchema();
    const [content, promoRows] = await Promise.all([
      getPool().query(`SELECT key, value FROM bot_content`),
      getPool().query(
        `SELECT title, content FROM promotions
          WHERE active
            AND (start_date IS NULL OR start_date <= CURRENT_DATE)
            AND (end_date   IS NULL OR end_date   >= CURRENT_DATE)
          ORDER BY updated_at`,
      ),
    ]);
    const blocks: PromptOverrides = {};
    let prices = DEFAULT_PRICE_DATA;
    for (const { key, value } of content.rows as { key: string; value: string }[]) {
      if (key === PRICE_KEY) {
        try {
          prices = mergePrices(JSON.parse(value));
        } catch (e) {
          console.error("[knowledgeStore] parse prices JSON failed → dùng default:", (e as Error).message);
        }
      } else if (BLOCK_KEYS.has(key) && typeof value === "string" && value.trim()) {
        blocks[key] = value;
      }
    }
    const promos = formatPromoBlock(promoRows.rows as { title: string; content: string }[]);
    return { blocks, prices, promos };
  } catch (e) {
    console.error("[knowledgeStore] loadKnowledge failed → fail-open (default):", (e as Error).message);
    return DEFAULT_KNOWLEDGE;
  }
}

/** 1 cục prompt như admin nhìn thấy: nội dung ĐANG DÙNG (override nếu có, không thì default). */
export interface AdminBlock {
  key: string;
  label: string;
  group: string;
  value: string;
  /** Gợi ý ngắn cho admin cục này dạy bot gì (nếu có). */
  desc?: string;
  /** true = khách đã sửa khác mặc định; false = đang dùng mặc định. */
  overridden: boolean;
}

/** Ảnh chụp cho trang admin: cục prompt (giá trị đang dùng) + bảng giá đang dùng + bảng giá mặc định. */
export async function adminSnapshot(): Promise<{
  blocks: AdminBlock[];
  prices: PriceData;
  defaultPrices: PriceData;
}> {
  const k = await loadKnowledge();
  const blocks: AdminBlock[] = PROMPT_BLOCKS.map((b) => ({
    key: b.key,
    label: b.label,
    group: b.group,
    value: k.blocks[b.key] ?? b.default,
    desc: b.desc,
    overridden: typeof k.blocks[b.key] === "string",
  }));
  return { blocks, prices: k.prices, defaultPrices: DEFAULT_PRICE_DATA };
}

/** Toàn bộ dòng thô key→value (cho admin hiển thị/sửa). Lỗi DB → object rỗng. */
export async function listContent(): Promise<Record<string, string>> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(`SELECT key, value FROM bot_content`);
    const out: Record<string, string> = {};
    for (const { key, value } of rows as { key: string; value: string }[]) out[key] = value;
    return out;
  } catch (e) {
    console.error("[knowledgeStore] listContent failed:", (e as Error).message);
    return {};
  }
}

/** Ghi/đè 1 cục prompt (text). Chỉ nhận key nằm trong PROMPT_BLOCKS. */
export async function setBlock(key: string, value: string): Promise<void> {
  if (!BLOCK_KEYS.has(key)) throw new Error(`key cục prompt không hợp lệ: ${key}`);
  await upsert(key, value);
}

/** Ghi/đè toàn bộ bảng giá (nhận PriceData, lưu JSON). Validate qua mergePrices trước khi lưu. */
export async function setPrices(data: unknown): Promise<void> {
  const clean = mergePrices(data); // loại field rác, đảm bảo đủ field
  await upsert(PRICE_KEY, JSON.stringify(clean));
}

/** Đưa 1 cục về mặc định = xoá dòng override (buildSystemPrompt sẽ tự rơi về default). */
export async function resetKey(key: string): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM bot_content WHERE key = $1`, [key]);
}

async function upsert(key: string, value: string): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO bot_content (key, value, updated_at)
       VALUES ($1, $2, NOW())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

// ─────────────────────────────────────────────────────────────
// KHUYẾN MÃI THEO ĐỢT (bảng promotions) — admin CRUD
// ─────────────────────────────────────────────────────────────

/** 1 đợt ưu đãi như admin quản lý. date là chuỗi "YYYY-MM-DD" hoặc null (không giới hạn đầu/cuối). */
export interface Promo {
  id: number;
  title: string;
  content: string;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  /** true = HÔM NAY nằm trong hạn + đang bật → bot đang thực sự dùng đợt này (admin thấy nhãn "đang chạy"). */
  live: boolean;
}

/** Chuẩn hoá ngày người dùng nhập: "" / rác → null; "YYYY-MM-DD" hợp lệ → giữ; khác → null. */
function normDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Chuẩn `Date`→"YYYY-MM-DD" (pg trả DATE thành Date object). Null-safe. */
function dateStr(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Toàn bộ đợt ưu đãi (kể cả hết hạn / đang tắt) cho admin quản lý. Lỗi DB → mảng rỗng. */
export async function listPromos(): Promise<Promo[]> {
  try {
    await ensureSchema();
    const { rows } = await getPool().query(
      `SELECT id, title, content, start_date, end_date, active,
              (active
                AND (start_date IS NULL OR start_date <= CURRENT_DATE)
                AND (end_date   IS NULL OR end_date   >= CURRENT_DATE)) AS live
         FROM promotions
        ORDER BY updated_at DESC`,
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      title: String(r.title ?? ""),
      content: String(r.content ?? ""),
      start_date: dateStr(r.start_date),
      end_date: dateStr(r.end_date),
      active: !!r.active,
      live: !!r.live,
    }));
  } catch (e) {
    console.error("[knowledgeStore] listPromos failed:", (e as Error).message);
    return [];
  }
}

/** Thêm mới (id rỗng) hoặc sửa (có id) 1 đợt ưu đãi. Trả về id. Ném lỗi nếu thiếu title/content. */
export async function savePromo(p: {
  id?: number | null;
  title: string;
  content: string;
  start_date?: string | null;
  end_date?: string | null;
  active?: boolean;
}): Promise<number> {
  const title = (p.title ?? "").trim();
  const content = (p.content ?? "").trim();
  if (!title) throw new Error("Thiếu tiêu đề ưu đãi");
  if (!content) throw new Error("Thiếu nội dung ưu đãi");
  const start = normDate(p.start_date);
  const end = normDate(p.end_date);
  const active = p.active !== false; // mặc định bật
  await ensureSchema();
  if (p.id) {
    await getPool().query(
      `UPDATE promotions
          SET title=$2, content=$3, start_date=$4, end_date=$5, active=$6, updated_at=NOW()
        WHERE id=$1`,
      [p.id, title, content, start, end, active],
    );
    return Number(p.id);
  }
  const { rows } = await getPool().query(
    `INSERT INTO promotions (title, content, start_date, end_date, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [title, content, start, end, active],
  );
  return Number(rows[0].id);
}

/** Xoá hẳn 1 đợt ưu đãi. */
export async function deletePromo(id: number): Promise<void> {
  await ensureSchema();
  await getPool().query(`DELETE FROM promotions WHERE id=$1`, [id]);
}

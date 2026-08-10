/**
 * routes/admin.ts
 *
 * Mini webadmin GẮN THẲNG vào server bot (Hono) — không cần Vercel/host riêng.
 * Chạy chung domain với bot:  https://<domain-bot>/admin
 *
 *   GET  /admin               → trang HTML (login + bảng user, tự chứa, không build).
 *   POST /admin/api/login     → so tài khoản/mật khẩu env → set cookie ký HMAC.
 *   POST /admin/api/logout    → xoá cookie.
 *   GET  /admin/api/users     → danh sách user (cần đăng nhập).
 *   POST /admin/api/users     → bật/tắt AI cho 1 user (cần đăng nhập).
 *   GET  /admin/api/global    → trạng thái công tắc tổng (cần đăng nhập).
 *   POST /admin/api/global    → bật/tắt AI cho TẤT CẢ user nhắn đến (cần đăng nhập).
 *
 * ENV cần thêm: ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET (chuỗi ngẫu nhiên dài).
 * Dùng lại PG_* sẵn có (qua botControl.ts) — không cần biến DB mới.
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  listUsers,
  setBotEnabled,
  deleteBotUser,
  getGlobalEnabled,
  setGlobalEnabled,
} from "../lib/botControl";
import { cancelFollowup } from "../lib/followup";
import { adminSnapshot, setBlock, setPrices, resetKey, listPromos, savePromo, deletePromo } from "../lib/knowledgeStore";
import { listDocs, ingestDoc, deleteDoc } from "../lib/docStore";
import { parseUpload } from "../lib/parseUpload";
import {
  MEDIA_CATEGORIES,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  isValidBase,
  listCategoryMedia,
  uploadMedia,
  deleteMedia,
} from "../lib/cloudinaryAdmin";

const COOKIE_NAME = "vnlink_admin";
const TTL_SEC = 60 * 60 * 24 * 7; // 7 ngày

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const AUTH_SECRET = process.env.AUTH_SECRET ?? "";

function sign(data: string): string {
  return createHmac("sha256", AUTH_SECRET).update(data).digest("base64url");
}

function createToken(): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token || !AUTH_SECRET) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [sub, expStr, sig] = parts;
  if (sub !== "admin") return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(`admin.${expStr}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthed(c: any): boolean {
  return verifyToken(getCookie(c, COOKIE_NAME));
}

export const adminWebhook = new Hono();

// ── Trang HTML (tự chứa, không cần build) ──
adminWebhook.get("/admin", (c) => c.html(PAGE_HTML));

// ── Đăng nhập ──
adminWebhook.post("/admin/api/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const okUser = body.username === ADMIN_USERNAME && ADMIN_USERNAME !== "";
  const okPass = body.password === ADMIN_PASSWORD && ADMIN_PASSWORD !== "";
  if (!okUser || !okPass) {
    return c.json({ error: "Sai tài khoản hoặc mật khẩu" }, 401);
  }
  setCookie(c, COOKIE_NAME, createToken(), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: TTL_SEC,
  });
  return c.json({ ok: true });
});

adminWebhook.post("/admin/api/logout", (c) => {
  setCookie(c, COOKIE_NAME, "", { path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

// Cặp tin nhắn gần nhất của 1 user — đọc bản SẠCH từ FSM state (lastUserMessage/lastBotReply),
// KHÔNG đọc memory thô (memory lưu cả prefix [HON...] + JSON {"text":...}). Best-effort.
async function lastPair(senderId: string): Promise<{ user: string | null; bot: string | null }> {
  try {
    const { mastra } = await import("../index");
    const { loadState } = await import("../lib/stateStore");
    const st: any = await loadState(mastra, senderId, senderId);
    const user = (st?.lastUserMessage ?? "").trim() || null;
    const bot = (st?.lastBotReply ?? "").trim() || null;
    return { user, bot };
  } catch (e) {
    console.error(`[admin] lastPair failed for ${senderId}:`, e);
    return { user: null, bot: null };
  }
}

// ── Danh sách user ──
adminWebhook.get("/admin/api/users", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const users = await listUsers();
    // Đính cặp tin nhắn gần nhất (giới hạn 80 user mới nhất để khỏi quá tải DB).
    const withMsgs = await Promise.all(
      users.map(async (u, i) =>
        i < 80 ? { ...u, lastPair: await lastPair(u.sender_id) } : { ...u, lastPair: null },
      ),
    );
    return c.json({ users: withMsgs });
  } catch (e) {
    console.error("[admin] list users failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// ── Bật/tắt AI cho user ──
adminWebhook.post("/admin/api/users", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { senderId, enabled } = await c.req.json();
    if (typeof senderId !== "string" || typeof enabled !== "boolean") {
      return c.json({ error: "bad_request" }, 400);
    }
    await setBotEnabled(senderId, enabled);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] toggle failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// ── CÔNG TẮC TỔNG: bật/tắt AI tự động trả lời cho TẤT CẢ user nhắn đến ──
// Tắt = bot im với mọi người (kể cả khách mới chưa từng nhắn), nhưng vẫn lưu memory +
// chạy classifier âm thầm như khi tắt lẻ 1 user. KHÔNG ghi đè cờ riêng của từng user:
// bật lại thì ai đang bị tắt lẻ vẫn tắt, ai bật vẫn bật.
adminWebhook.get("/admin/api/global", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ enabled: await getGlobalEnabled() });
  } catch (e) {
    console.error("[admin] read global flag failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

adminWebhook.post("/admin/api/global", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { enabled } = await c.req.json();
    if (typeof enabled !== "boolean") return c.json({ error: "bad_request" }, 400);
    await setGlobalEnabled(enabled);
    return c.json({ ok: true, enabled });
  } catch (e) {
    console.error("[admin] toggle global failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// ── Xoá TOÀN BỘ dữ liệu chat của 1 user ──
// Quét mọi nơi lưu dữ liệu theo PSID (= threadId = resourceId), THỨ TỰ QUAN TRỌNG:
//   (1) Cache RAM TRƯỚC: fb session + followup timer + classify queue — chặn tái tạo sau khi xoá.
//   (2) Mastra memory: tin nhắn + FSM state + vector semantic-recall  (stateStore)
//   (3) Postgres purge TRIỆT ĐỂ: bot_controls + mastra_workflow_snapshot (bảng Mastra memory API
//       KHÔNG đụng → hay sót, gây "cache") + memory_messages(vector) + mastra_messages/threads
//       (belt-and-suspenders) + working-memory mastra_resources  (botControl.deleteBotUser)
// KHÔNG đụng Google Sheets (sổ booking) — theo lựa chọn admin.
adminWebhook.post("/admin/api/users/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  let senderId: unknown;
  try {
    ({ senderId } = await c.req.json());
  } catch {
    return c.json({ error: "bad_request" }, 400);
  }
  if (typeof senderId !== "string" || !senderId.trim()) {
    return c.json({ error: "bad_request" }, 400);
  }

  const warnings: string[] = [];

  // (1) CẮT RAM TRƯỚC TIÊN — mọi tiến trình còn treo có thể GHI LẠI dữ liệu sau khi xoá:
  //     followup (nhắc khi khách im) đang hẹn giờ sẽ fire và tái tạo thread/state; fb session +
  //     classify queue giữ ngữ cảnh. Nếu xoá DB trước rồi mới cắt, followup fire NGAY sau đó =
  //     khách "sống lại" y như cache. Cắt RAM trước = chặn nguồn tái tạo trước khi dọn DB.
  try {
    const fb = await import("./facebook");
    fb.purgeFbSessionState(senderId);
  } catch (e) {
    warnings.push(`fb-cache: ${(e as Error).message}`);
  }
  try {
    cancelFollowup(senderId);
  } catch (e) {
    warnings.push(`followup: ${(e as Error).message}`);
  }
  try {
    const sc = await import("../lib/silentClassify");
    sc.cancelClassifyChain(senderId);
  } catch (e) {
    warnings.push(`classify: ${(e as Error).message}`);
  }

  // (2) Mastra memory (tin nhắn + FSM state + vector) qua memory API.
  try {
    const { mastra } = await import("../index");
    const { deleteConversationData } = await import("../lib/stateStore");
    const r = await deleteConversationData(mastra, senderId);
    warnings.push(...r.errors);
  } catch (e) {
    warnings.push(`memory: ${(e as Error).message}`);
  }

  // (3) Postgres purge TRIỆT ĐỂ (bao gồm workflow_snapshot). Lỗi ở đây đáng kể → trả 500.
  try {
    await deleteBotUser(senderId);
  } catch (e) {
    console.error(`[admin] delete bot_controls failed for ${senderId}:`, e);
    return c.json({ error: "db_error", warnings }, 500);
  }

  if (warnings.length) console.warn(`[admin] delete ${senderId} hoàn tất kèm cảnh báo:`, warnings);
  return c.json({ ok: true, warnings });
});

// ── Thư viện media: liệt kê ảnh/video theo danh mục Cloudinary ──
adminWebhook.get("/admin/api/media", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const categories = await Promise.all(
      MEDIA_CATEGORIES.map(async (cat) => {
        const { images, videos } = await listCategoryMedia(cat.base);
        return { base: cat.base, label: cat.label, images, videos };
      }),
    );
    return c.json({
      categories,
      limits: { image: IMAGE_MAX_BYTES, video: VIDEO_MAX_BYTES },
    });
  } catch (e) {
    console.error("[admin] list media failed:", e);
    return c.json({ error: "cloud_error" }, 500);
  }
});

// ── Upload media mới (multipart: base, kind, file) ──
adminWebhook.post("/admin/api/media/upload", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const body = await c.req.parseBody();
    const base = String(body.base ?? "");
    const kind = String(body.kind ?? "");
    const file = body.file;
    if (!isValidBase(base) || (kind !== "img" && kind !== "video")) {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!(file instanceof File)) {
      return c.json({ error: "no_file" }, 400);
    }
    const max = kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
    if (file.size > max) {
      return c.json({ error: "too_large", max }, 413);
    }
    // Tách bỏ phần đuôi mở rộng để Cloudinary tự gắn theo định dạng thật.
    const rawName = file.name || "upload";
    const dot = rawName.lastIndexOf(".");
    const filename = dot > 0 ? rawName.slice(0, dot) : rawName;

    const buffer = Buffer.from(await file.arrayBuffer());
    const item = await uploadMedia({ base, kind: kind as "img" | "video", buffer, filename });
    return c.json({ ok: true, item });
  } catch (e) {
    console.error("[admin] media upload failed:", e);
    return c.json({ error: "upload_error" }, 500);
  }
});

// ── Xoá media ──
adminWebhook.post("/admin/api/media/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { public_id, resource_type } = await c.req.json();
    if (
      typeof public_id !== "string" ||
      (resource_type !== "image" && resource_type !== "video")
    ) {
      return c.json({ error: "bad_request" }, 400);
    }
    const ok = await deleteMedia(public_id, resource_type);
    return c.json({ ok });
  } catch (e) {
    console.error("[admin] media delete failed:", e);
    return c.json({ error: "delete_error" }, 500);
  }
});

// ── Kiến thức: cục prompt (kịch bản) + bảng giá có cấu trúc ──
adminWebhook.get("/admin/api/knowledge", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json(await adminSnapshot());
  } catch (e) {
    console.error("[admin] knowledge snapshot failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// Lưu 1 cục prompt (text). value rỗng → coi như đưa về mặc định (xoá override).
adminWebhook.post("/admin/api/knowledge/block", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { key, value } = await c.req.json();
    if (typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: "bad_request" }, 400);
    }
    if (value.trim()) await setBlock(key, value);
    else await resetKey(key);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] save block failed:", e);
    return c.json({ error: (e as Error).message || "save_error" }, 400);
  }
});

// Đưa 1 cục prompt về mặc định (xoá override).
adminWebhook.post("/admin/api/knowledge/block/reset", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { key } = await c.req.json();
    if (typeof key !== "string") return c.json({ error: "bad_request" }, 400);
    await resetKey(key);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] reset block failed:", e);
    return c.json({ error: "reset_error" }, 500);
  }
});

// Lưu toàn bộ bảng giá (JSON PriceData). Store tự validate + merge lên default.
adminWebhook.post("/admin/api/knowledge/prices", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const body = await c.req.json();
    await setPrices(body.prices ?? body);
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] save prices failed:", e);
    return c.json({ error: "save_error" }, 500);
  }
});

// Đưa bảng giá về mặc định.
adminWebhook.post("/admin/api/knowledge/prices/reset", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    await resetKey("prices");
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] reset prices failed:", e);
    return c.json({ error: "reset_error" }, 500);
  }
});

// ── Khuyến mãi theo đợt (promotions) ──
// Danh sách toàn bộ đợt (kể cả hết hạn/tắt) — kèm cờ live để admin biết đợt nào bot đang dùng.
adminWebhook.get("/admin/api/promos", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ promos: await listPromos() });
  } catch (e) {
    console.error("[admin] list promos failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// Thêm mới (không id) hoặc sửa (có id) 1 đợt ưu đãi.
adminWebhook.post("/admin/api/promos/save", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const b = await c.req.json();
    const id = await savePromo({
      id: b.id ?? null,
      title: b.title,
      content: b.content,
      start_date: b.start_date ?? null,
      end_date: b.end_date ?? null,
      active: b.active !== false,
    });
    return c.json({ ok: true, id });
  } catch (e) {
    console.error("[admin] save promo failed:", e);
    return c.json({ error: (e as Error).message || "save_error" }, 400);
  }
});

// Xoá hẳn 1 đợt ưu đãi.
adminWebhook.post("/admin/api/promos/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { id } = await c.req.json();
    if (!id) return c.json({ error: "bad_request" }, 400);
    await deletePromo(Number(id));
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] delete promo failed:", e);
    return c.json({ error: "delete_error" }, 500);
  }
});

// ── Tài liệu tham khảo (RAG) ──
const DOC_MAX_BYTES = 15 * 1024 * 1024; // 15MB/file

// Danh sách tài liệu đã nạp.
adminWebhook.get("/admin/api/docs", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ docs: await listDocs() });
  } catch (e) {
    console.error("[admin] list docs failed:", e);
    return c.json({ error: "db_error" }, 500);
  }
});

// Nạp tài liệu: hoặc upload file (PDF/Word/text) qua multipart, hoặc dán text trực tiếp (JSON).
adminWebhook.post("/admin/api/docs/upload", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const ct = c.req.header("content-type") || "";
    let title = "";
    let category = "chung";
    let text = "";

    if (ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      category = typeof body.category === "string" ? body.category : "chung";
      const file = body.file;
      if (file instanceof File) {
        if (file.size > DOC_MAX_BYTES) return c.json({ error: "Tệp quá lớn (tối đa 15MB)" }, 400);
        const buf = Buffer.from(await file.arrayBuffer());
        const parsed = await parseUpload(buf, file.name, file.type);
        text = parsed.text;
        title = typeof body.title === "string" && body.title.trim() ? body.title : file.name;
      } else {
        // dán text qua form
        text = typeof body.text === "string" ? body.text : "";
        title = typeof body.title === "string" ? body.title : "";
      }
    } else {
      const b = await c.req.json();
      title = b.title ?? "";
      category = b.category ?? "chung";
      text = b.text ?? "";
    }

    const r = await ingestDoc({ title, category, text });
    return c.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) {
    console.error("[admin] upload doc failed:", e);
    return c.json({ error: (e as Error).message || "upload_error" }, 400);
  }
});

// Xoá 1 tài liệu (kèm mọi chunk).
adminWebhook.post("/admin/api/docs/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const { id } = await c.req.json();
    if (!id) return c.json({ error: "bad_request" }, 400);
    await deleteDoc(Number(id));
    return c.json({ ok: true });
  } catch (e) {
    console.error("[admin] delete doc failed:", e);
    return c.json({ error: "delete_error" }, 500);
  }
});

// ─────────────────────────────────────────────
// Trang HTML — login + dashboard trong 1 file, gọi các API ở trên.
// Hỗ trợ sáng/tối (CSS variables, lưu localStorage). Không backtick bên trong.
// ─────────────────────────────────────────────
const PAGE_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VNLink Admin</title>
<script>(function(){var t=localStorage.getItem("theme");if(!t){t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";}document.documentElement.setAttribute("data-theme",t);})();</script>
<style>
:root{
  --radius:10px;
  --shadow:0 1px 3px rgba(0,0,0,.18);
}
[data-theme="dark"]{
  --bg:#0f1115; --surface:#161922; --field:#1a1d24; --border:#262b36;
  --text:#e6e8ec; --muted:#8b93a1; --mono:#9aa3b2;
  --accent:#3b82f6; --accent-h:#2563eb; --accent-text:#fff;
  --btn:#1f232c; --btn-border:#2f3540; --btn-h:#272c37;
  --on-bg:#14331f; --on-text:#4ade80; --off-bg:#3a1414; --off-text:#f87171;
  --sw-off:#4b5563; --sw-on:#22c55e;
}
[data-theme="light"]{
  --bg:#f4f6f9; --surface:#ffffff; --field:#ffffff; --border:#e3e7ed;
  --text:#1b2430; --muted:#67707d; --mono:#67707d;
  --accent:#2563eb; --accent-h:#1d4ed8; --accent-text:#fff;
  --btn:#ffffff; --btn-border:#d8dde4; --btn-h:#eef1f5;
  --on-bg:#dcfce7; --on-text:#15803d; --off-bg:#fee2e2; --off-text:#b91c1c;
  --sw-off:#cbd5e1; --sw-on:#16a34a;
}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);transition:background .2s,color .2s}
.wrap{max-width:920px;margin:0 auto;padding:28px 16px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.topbar h1{font-size:20px;font-weight:650;margin:0}
.subtitle{color:var(--muted);font-size:14px;margin:0 0 20px}
.actions{display:flex;gap:8px}
.btn{background:var(--btn);color:var(--text);border:1px solid var(--btn-border);border-radius:var(--radius);padding:8px 14px;cursor:pointer;font-size:14px;transition:background .15s}
.btn:hover{background:var(--btn-h)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);width:100%;padding:11px}
.btn-primary:hover{background:var(--accent-h)}
.input{width:100%;padding:11px 13px;margin-top:6px;background:var(--field);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:14px;outline:none}
.input:focus{border-color:var(--accent)}
.search{max-width:340px;margin-bottom:16px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:13px 16px;border-bottom:1px solid var(--border)}
tbody tr:last-child td{border-bottom:none}
th{color:var(--muted);font-weight:600;font-size:12px;letter-spacing:.03em;text-transform:uppercase}
.name{font-weight:550}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;color:var(--mono);font-size:12px;margin-top:2px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}
.badge.on{background:var(--on-bg);color:var(--on-text)}
.badge.off{background:var(--off-bg);color:var(--off-text)}
.switch{position:relative;display:inline-block;width:46px;height:26px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;cursor:pointer;background:var(--sw-off);border-radius:999px;transition:.2s}
.slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
input:checked + .slider{background:var(--sw-on)}
input:checked + .slider:before{transform:translateX(20px)}
.master{display:flex;align-items:center;justify-content:space-between;gap:18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:15px 18px;margin-bottom:18px;box-shadow:var(--shadow)}
.master.off{border-color:var(--off-text)}
.master h2{font-size:15px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:9px}
.master-desc{color:var(--muted);font-size:13px;margin:0;line-height:1.45}
.dimmed{opacity:.5;transition:opacity .15s}
.card{max-width:370px;margin:9vh auto;background:var(--surface);padding:30px;border-radius:16px;border:1px solid var(--border);box-shadow:var(--shadow)}
.card h1{font-size:21px;margin:0 0 4px}
.card .subtitle{margin:0 0 20px}
.label{font-size:13px;color:var(--muted)}
.error{color:var(--off-text);font-size:13px;margin-top:12px;min-height:16px}
.muted{color:var(--muted);font-size:13px}
.msgcol{max-width:380px}
.msg-pair{display:flex;flex-direction:column;gap:4px}
.msg-line{font-size:13px;line-height:1.4;color:var(--text);overflow-wrap:anywhere}
.msg-who{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;margin-right:6px;vertical-align:1px}
.msg-who.user{background:var(--off-bg);color:var(--off-text)}
.msg-who.bot{background:var(--on-bg);color:var(--on-text)}
.note{color:var(--muted);font-size:13px;margin-top:16px;line-height:1.5}
.pager{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:16px}
.pager .btn:disabled{opacity:.45;cursor:default}
.pager .pageinfo{color:var(--muted);font-size:13px}
.hidden{display:none}
.right{text-align:right}
.tabs{display:flex;gap:4px;margin-bottom:18px;border-bottom:1px solid var(--border)}
.tab{background:none;border:none;color:var(--muted);padding:10px 14px;cursor:pointer;font-size:14px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.btn-sm{padding:6px 10px;font-size:13px}
.cat{margin-bottom:26px}
.cat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.cat-head h2{font-size:16px;margin:0;font-weight:600}
.cat-count{color:var(--muted);font-size:13px;font-weight:400;margin-left:8px}
.up-actions{display:flex;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}
.mcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.mthumb{display:block;position:relative;aspect-ratio:1;background:var(--field)}
.mthumb img{width:100%;height:100%;object-fit:cover;display:block}
.mthumb .play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:30px;color:#fff;background:rgba(0,0,0,.32)}
.mmeta{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;gap:6px}
.mfmt{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.del{background:var(--off-bg);color:var(--off-text);border:none;border-radius:6px;width:24px;height:24px;cursor:pointer;font-size:13px;flex:none;line-height:1}
.del:hover{opacity:.85}
.del:disabled{opacity:.5;cursor:default}
.empty{color:var(--muted);font-size:13px;padding:6px 0}
.uploading{opacity:.6;pointer-events:none}
.toast-wrap{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:60}
.toast{background:var(--surface);color:var(--text);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:11px 16px;font-size:14px;box-shadow:var(--shadow);max-width:90vw}
.toast.ok{border-left-color:var(--sw-on)}
.toast.err{border-left-color:var(--off-text)}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:70;padding:16px}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;max-width:340px;width:100%;box-shadow:var(--shadow)}
.modal p{margin:0 0 18px;font-size:15px;line-height:1.5}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal-actions .btn{width:auto}
.btn-danger{background:var(--off-bg);border-color:var(--off-bg);color:var(--off-text)}
.know-sub{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:4px 0 16px}
.kgroup{font-size:14px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin:22px 0 10px}
.kcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:12px}
.khead{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:14px}
.ktext{width:100%;min-height:180px;background:var(--field);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5;resize:vertical}
.ktext-sm{min-height:90px}
.kacts{display:flex;gap:8px;margin-top:10px}
.kbtn{width:auto}
.ptable-wrap{overflow-x:auto}
.ptable{border-collapse:collapse;width:100%;font-size:13px}
.ptable th,.ptable td{border:1px solid var(--border);padding:6px 8px;text-align:left}
.ptable th{color:var(--muted);font-weight:600;white-space:nowrap}
.ptable .pname{font-weight:600;min-width:150px}
.pinp{width:110px;padding:6px 8px;font-size:13px}
.plbl{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
.prow{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-top:4px}
.pdate{width:auto}
.pchk{display:flex;align-items:center;gap:6px;font-size:13px;padding-bottom:8px}
</style>
</head>
<body>
<div id="login" class="card hidden">
  <h1>VNLink Admin</h1>
  <p class="subtitle">Đăng nhập để quản lý trợ lý AI</p>
  <label class="label">Tài khoản</label>
  <input id="u" class="input" autofocus />
  <div style="height:14px"></div>
  <label class="label">Mật khẩu</label>
  <input id="p" class="input" type="password" onkeydown="if(event.key==='Enter')doLogin()" />
  <div style="height:22px"></div>
  <button class="btn btn-primary" onclick="doLogin()">Đăng nhập</button>
  <div id="loginErr" class="error"></div>
</div>

<div id="app" class="wrap hidden">
  <div class="topbar">
    <h1>VNLink Admin</h1>
    <div class="actions">
      <button id="themeBtn" class="btn" onclick="toggleTheme()"></button>
      <button class="btn" onclick="doLogout()">Đăng xuất</button>
    </div>
  </div>

  <div class="tabs">
    <button id="tab-users" class="tab active" onclick="switchTab('users')">Người dùng</button>
    <button id="tab-knowledge" class="tab" onclick="switchTab('knowledge')">Kịch bản &amp; Giá</button>
    <button id="tab-docs" class="tab" onclick="switchTab('docs')">Tài liệu</button>
    <button id="tab-media" class="tab" onclick="switchTab('media')">Thư viện ảnh/video</button>
  </div>

  <div id="view-users">
    <div id="master" class="master">
      <div>
        <h2>Trợ lý AI tự động <span id="masterBadge" class="badge on">Đang bật</span></h2>
        <p id="masterDesc" class="master-desc"></p>
      </div>
      <label class="switch"><input id="masterSw" type="checkbox" onchange="toggleGlobal(this)" /><span class="slider"></span></label>
    </div>

    <div id="usersWrap">
      <p class="subtitle">Bật hoặc tắt việc trợ lý AI tự động trả lời từng người.</p>
      <input id="q" class="input search" placeholder="Tìm theo tên hoặc ID…" oninput="render()" />
      <div id="list"></div>
      <p id="userNote" class="note">Khi tắt, trợ lý AI sẽ ngừng trả lời người này. Thay đổi có hiệu lực ngay ở tin nhắn tiếp theo.</p>
    </div>
  </div>

  <div id="view-knowledge" class="hidden">
    <p class="subtitle">Sửa nội dung trợ lý AI dùng để tư vấn. Lưu xong có hiệu lực ngay ở tin kế tiếp, không cần deploy.</p>
    <div class="know-sub">
      <button id="ksub-blocks" class="tab active" onclick="switchKnow('blocks')">Kịch bản (cục nội dung)</button>
      <button id="ksub-prices" class="tab" onclick="switchKnow('prices')">Bảng giá</button>
      <button id="ksub-promos" class="tab" onclick="switchKnow('promos')">Khuyến mãi theo đợt</button>
    </div>
    <div id="know-blocks"><p class="muted">Đang tải…</p></div>
    <div id="know-prices" class="hidden"><p class="muted">Đang tải…</p></div>
    <div id="know-promos" class="hidden"><p class="muted">Đang tải…</p></div>
  </div>

  <div id="view-docs" class="hidden">
    <p class="subtitle">Kiến thức chung (fitness, tăng giảm cân, dinh dưỡng, trị liệu…). Bot tự đọc và dùng khi khách hỏi tới. Nạp PDF, Word (.docx), text/.md — hoặc dán nội dung trực tiếp.</p>
    <div class="kcard">
      <div class="khead"><b>Nạp tài liệu mới</b></div>
      <label class="plbl">Chủ đề</label>
      <select id="doc-cat" class="input pdate">
        <option value="fitness">Kiến thức về fitness</option>
        <option value="tang-giam-can">Kiến thức tăng giảm cân</option>
        <option value="dinh-duong">Kiến thức về dinh dưỡng</option>
        <option value="tri-lieu">Kiến thức về trị liệu</option>
        <option value="sale">Cách sale</option>
        <option value="chung" selected>Chung</option>
      </select>
      <label class="plbl">Tên tài liệu (để trống sẽ lấy tên file)</label>
      <input id="doc-title" class="input" placeholder="VD: Hướng dẫn dinh dưỡng tăng cân"/>
      <label class="plbl">Cách 1 — Chọn file (PDF / Word / text)</label>
      <input id="doc-file" type="file" accept=".pdf,.docx,.txt,.md,.markdown" class="input pdate"/>
      <label class="plbl">Cách 2 — Hoặc dán nội dung text</label>
      <textarea id="doc-text" class="ktext ktext-sm" placeholder="Dán nội dung tài liệu vào đây nếu không có file."></textarea>
      <div class="kacts"><button id="doc-up-btn" class="btn btn-primary" onclick="uploadDoc()">Nạp tài liệu</button></div>
      <p class="note">Nạp xong bot dùng được ngay ở tin kế tiếp. File scan (ảnh) không đọc được chữ — hãy dán text.</p>
    </div>
    <h3 class="kgroup">Tài liệu đã nạp</h3>
    <div id="docList"><p class="muted">Đang tải…</p></div>
  </div>

  <div id="view-media" class="hidden">
    <p class="subtitle">Ảnh/video gửi cho khách qua Facebook. Giới hạn: ảnh ≤ 8MB, video ≤ 25MB.</p>
    <div id="mediaList"><p class="muted">Đang tải…</p></div>
  </div>
</div>

<input id="fileInput" type="file" class="hidden" />
<div id="toasts" class="toast-wrap"></div>

<script>
var USERS = [];
var GLOBAL_ON = true;   // công tắc tổng — tắt thì AI im với tất cả, kể cả khách mới
var PAGE = 1;
var PAGE_SIZE = 20;
var LAST_Q = null;

function show(id){ document.getElementById(id).classList.remove("hidden"); }
function hide(id){ document.getElementById(id).classList.add("hidden"); }

function toggleTheme(){
  var cur = document.documentElement.getAttribute("data-theme");
  var next = cur === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeBtn();
}
function updateThemeBtn(){
  var cur = document.documentElement.getAttribute("data-theme");
  var b = document.getElementById("themeBtn");
  if(b) b.textContent = cur === "light" ? "Chế độ tối" : "Chế độ sáng";
}

function fmt(iso){ try { return new Date(iso).toLocaleString("vi-VN",{hour12:false}); } catch(e){ return iso; } }
function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];}); }
function cut(s,n){ s=(s==null?"":String(s)); return s.length>n ? s.slice(0,n)+"…" : s; }

async function doLogin(){
  document.getElementById("loginErr").textContent = "";
  var r = await fetch("/admin/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({username:document.getElementById("u").value, password:document.getElementById("p").value})});
  if(r.ok){ hide("login"); boot(); }
  else { var d = await r.json().catch(function(){return {};}); document.getElementById("loginErr").textContent = d.error || "Đăng nhập thất bại"; }
}

async function doLogout(){ await fetch("/admin/api/logout",{method:"POST"}); location.reload(); }

// Đưa về màn đăng nhập một cách an toàn (dọn modal đang mở, không để trang trắng).
function forceLogin(msg){
  hide("app");
  var bgs = document.querySelectorAll(".modal-bg");
  bgs.forEach(function(b){ b.remove(); });
  show("login");
  var le = document.getElementById("loginErr");
  if(le) le.textContent = msg || "";
}
// Bất kỳ response 401 nào → rớt về login (phiên hết hạn). Trả true nếu đã xử lý.
function handle401(r){
  if(r && r.status===401){ forceLogin("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại."); return true; }
  return false;
}

async function boot(){
  updateThemeBtn();
  try {
    var rs = await Promise.all([
      fetch("/admin/api/users",{cache:"no-store"}),
      fetch("/admin/api/global",{cache:"no-store"})
    ]);
    var r = rs[0], rg = rs[1];
    if(r.status===401){ forceLogin(); return; }
    if(!r.ok){ forceLogin("Không kết nối được máy chủ, vui lòng đăng nhập lại."); return; }
    var d = await r.json(); USERS = d.users || [];
    // Cờ tổng đọc lỗi → coi như đang bật (khớp fail-open phía bot), không chặn cả trang.
    if(rg.ok){ var dg = await rg.json(); GLOBAL_ON = dg.enabled !== false; }
    hide("login"); show("app"); updateThemeBtn(); renderGlobal(); render();
  } catch(e){
    forceLogin("Có lỗi xảy ra, vui lòng đăng nhập lại.");
  }
}

// ── Công tắc tổng ──
function renderGlobal(){
  var on = GLOBAL_ON;
  document.getElementById("masterSw").checked = on;
  document.getElementById("master").className = "master" + (on ? "" : " off");
  var b = document.getElementById("masterBadge");
  b.className = "badge " + (on ? "on" : "off");
  b.textContent = on ? "Đang bật" : "Đã tắt";
  document.getElementById("masterDesc").textContent = on
    ? "AI đang tự động trả lời mọi người nhắn đến — trừ những người bạn tắt riêng ở bảng dưới."
    : "AI đang TẮT với tất cả mọi người, kể cả khách mới. Tin nhắn khách vẫn được lưu, bật lại là bot có đủ ngữ cảnh.";
  // Tắt tổng → công tắc từng người tạm thời vô hiệu (vẫn sửa được, chỉ chưa có tác dụng).
  document.getElementById("usersWrap").className = on ? "" : "dimmed";
  document.getElementById("userNote").textContent = on
    ? "Khi tắt, trợ lý AI sẽ ngừng trả lời người này. Thay đổi có hiệu lực ngay ở tin nhắn tiếp theo."
    : "Công tắc tổng đang TẮT nên AI không trả lời ai. Cài đặt riêng từng người dưới đây vẫn được giữ và sẽ có hiệu lực lại khi bật tổng.";
}

async function toggleGlobal(el){
  var next = el.checked;
  if(!next){
    var yes = await askConfirm("Tắt trợ lý AI với TẤT CẢ mọi người? Bot sẽ ngừng tự động trả lời mọi khách nhắn đến cho tới khi bạn bật lại.", "Tắt tất cả", true);
    if(!yes){ el.checked = true; return; }
  }
  el.disabled = true;
  var r = await fetch("/admin/api/global",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({enabled:next})});
  el.disabled = false;
  if(handle401(r)){ el.checked = !next; return; }
  if(r.ok){
    GLOBAL_ON = next; renderGlobal();
    toast(next ? "Đã bật AI cho tất cả mọi người." : "Đã tắt AI với tất cả mọi người.", "ok");
  } else {
    el.checked = !next;
    toast("Cập nhật thất bại, thử lại.", "err");
  }
}

function changePage(delta){ PAGE += delta; render(); }

function render(){
  var q = (document.getElementById("q").value||"").trim().toLowerCase();
  // Đổi từ khoá tìm → về trang 1 (khỏi kẹt ở trang trống của kết quả cũ).
  if(q !== LAST_Q){ PAGE = 1; LAST_Q = q; }
  var rows = USERS.filter(function(u){
    if(!q) return true;
    return (u.name||"").toLowerCase().indexOf(q)>=0 || String(u.sender_id).indexOf(q)>=0;
  });
  if(rows.length===0){ document.getElementById("list").innerHTML = '<p class="muted">Chưa có người dùng nào.</p>'; return; }
  var total = rows.length;
  var pages = Math.ceil(total / PAGE_SIZE);
  if(PAGE > pages) PAGE = pages;
  if(PAGE < 1) PAGE = 1;
  var start = (PAGE - 1) * PAGE_SIZE;
  var pageRows = rows.slice(start, start + PAGE_SIZE);
  var html = '<div class="panel"><table><thead><tr><th>Người dùng</th><th>Tin nhắn gần nhất</th><th>Hoạt động gần nhất</th><th>Trạng thái</th><th class="right">Trợ lý AI</th><th class="right">Xoá</th></tr></thead><tbody>';
  pageRows.forEach(function(u){
    var p = u.lastPair || {};
    var pairHtml = (!p.user && !p.bot)
      ? '<span class="muted">—</span>'
      : '<div class="msg-pair">'
          + (p.user ? '<div class="msg-line"><span class="msg-who user">Khách</span> ' + esc(cut(p.user,140)) + '</div>' : '')
          + (p.bot  ? '<div class="msg-line"><span class="msg-who bot">Bot</span> '   + esc(cut(p.bot,140))  + '</div>' : '')
        + '</div>';
    html += '<tr>'
      + '<td><div class="name">' + esc(u.name || "(chưa rõ tên)") + '</div><div class="mono">' + esc(u.sender_id) + '</div></td>'
      + '<td class="msgcol">' + pairHtml + '</td>'
      + '<td class="muted">' + fmt(u.last_active) + '</td>'
      + '<td><span class="badge ' + (u.enabled?"on":"off") + '">' + (u.enabled?"Đang bật":"Đã tắt") + '</span></td>'
      + '<td class="right"><label class="switch"><input type="checkbox" ' + (u.enabled?"checked":"")
      + ' onchange="toggle(\\'' + esc(u.sender_id) + '\\', this)"><span class="slider"></span></label></td>'
      + '<td class="right"><button class="del" title="Xoá dữ liệu chat" onclick="delUser(\\'' + esc(u.sender_id) + '\\', this)">✕</button></td>'
      + '</tr>';
  });
  html += '</tbody></table></div>';
  if(pages > 1){
    var from = start + 1, to = start + pageRows.length;
    html += '<div class="pager">'
      + '<button class="btn" onclick="changePage(-1)"' + (PAGE<=1?" disabled":"") + '>‹ Trước</button>'
      + '<span class="pageinfo">' + from + '–' + to + ' / ' + total + ' &nbsp;·&nbsp; Trang ' + PAGE + '/' + pages + '</span>'
      + '<button class="btn" onclick="changePage(1)"' + (PAGE>=pages?" disabled":"") + '>Sau ›</button>'
      + '</div>';
  }
  document.getElementById("list").innerHTML = html;
}

async function toggle(senderId, el){
  el.disabled = true;
  var next = el.checked;
  var r = await fetch("/admin/api/users",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({senderId:senderId, enabled:next})});
  el.disabled = false;
  if(handle401(r)){ el.checked = !next; return; }
  if(r.ok){ var u = USERS.find(function(x){return x.sender_id===senderId;}); if(u) u.enabled = next; render(); }
  else { el.checked = !next; toast("Cập nhật thất bại, thử lại.", "err"); }
}

async function delUser(senderId, btn){
  var yes = await askConfirm("Xoá toàn bộ dữ liệu chat của người này? Gồm tin nhắn, hồ sơ ghi nhớ và lịch sử hội thoại — KHÔNG thể hoàn tác. (Sổ booking trên Google Sheets vẫn giữ nguyên.)", "Xoá", true);
  if(!yes) return;
  if(btn) btn.disabled = true;
  var r = await fetch("/admin/api/users/delete",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({senderId:senderId})});
  if(handle401(r)){ if(btn) btn.disabled = false; return; }
  if(r.ok){
    USERS = USERS.filter(function(x){ return x.sender_id !== senderId; });
    render();
    toast("Đã xoá dữ liệu chat.", "ok");
  } else {
    if(btn) btn.disabled = false;
    toast("Xoá thất bại, thử lại.", "err");
  }
}

// ── Toast + hộp xác nhận tuỳ biến (thay alert/confirm mặc định) ──
function toast(msg, kind){
  var wrap = document.getElementById("toasts");
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3000);
}
function askConfirm(msg, okLabel, danger){
  return new Promise(function(resolve){
    var bg = document.createElement("div"); bg.className = "modal-bg";
    var box = document.createElement("div"); box.className = "modal";
    var p = document.createElement("p"); p.textContent = msg; box.appendChild(p);
    var acts = document.createElement("div"); acts.className = "modal-actions";
    var cancel = document.createElement("button"); cancel.className = "btn"; cancel.textContent = "Huỷ";
    var ok = document.createElement("button"); ok.className = "btn " + (danger ? "btn-danger" : "btn-primary"); ok.textContent = okLabel || "Đồng ý";
    acts.appendChild(cancel); acts.appendChild(ok); box.appendChild(acts); bg.appendChild(box);
    document.body.appendChild(bg);
    function done(v){ bg.remove(); resolve(v); }
    cancel.onclick = function(){ done(false); };
    ok.onclick = function(){ done(true); };
    bg.onclick = function(e){ if(e.target === bg) done(false); };
  });
}

// ── Thư viện ảnh/video ──
var MEDIA = null;            // null = chưa nạp
var LIMITS = { image: 8388608, video: 26214400 };
var DELITEMS = [];          // map index → {public_id, resource_type} cho nút xoá

// ── Kịch bản & Giá ──
var KNOW = null;            // {blocks:[...], prices, defaultPrices}; null = chưa nạp
var CARD_ORDER = ["FULL","GYM","YOGA","ZUMBA","BOI_LON","BOI_BE","ECO","FULL_HSSV","FULL_GV"];

function switchKnow(sub){
  ["blocks","prices","promos"].forEach(function(s){
    document.getElementById("ksub-"+s).classList.toggle("active", s===sub);
    document.getElementById("know-"+s).classList.toggle("hidden", s!==sub);
  });
  if(sub==="promos") loadPromos();
}

async function loadKnow(){
  var b = document.getElementById("know-blocks");
  var r;
  try { r = await fetch("/admin/api/knowledge",{cache:"no-store"}); }
  catch(e){ b.innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; return; }
  if(handle401(r)) return;
  if(!r.ok){ b.innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
  KNOW = await r.json();
  renderBlocks();
  renderPrices();
}

function renderBlocks(){
  var box = document.getElementById("know-blocks");
  var groups = {};
  KNOW.blocks.forEach(function(bk){ (groups[bk.group]=groups[bk.group]||[]).push(bk); });
  var html = "";
  Object.keys(groups).forEach(function(g){
    html += '<h3 class="kgroup">'+esc(g)+'</h3>';
    groups[g].forEach(function(bk){
      var badge = bk.overridden ? '<span class="badge on">Đã sửa</span>' : '<span class="badge">Mặc định</span>';
      html += '<div class="kcard"><div class="khead"><b>'+esc(bk.label)+'</b> '+badge+'</div>'
        + '<textarea id="blk-'+esc(bk.key)+'" class="ktext">'+esc(bk.value)+'</textarea>'
        + '<div class="kacts"><button class="btn btn-primary kbtn" onclick="saveBlock(\\''+esc(bk.key)+'\\')">Lưu</button>'
        + '<button class="btn kbtn" onclick="resetBlock(\\''+esc(bk.key)+'\\')">Về mặc định</button></div></div>';
    });
  });
  box.innerHTML = html;
}

async function saveBlock(key){
  var ta = document.getElementById("blk-"+key);
  var val = ta.value;
  var r = await fetch("/admin/api/knowledge/block",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key,value:val})});
  if(handle401(r)) return;
  var d = await r.json().catch(function(){return {};});
  if(r.ok){
    var bk = KNOW.blocks.find(function(x){return x.key===key;});
    if(bk){ bk.value = val; bk.overridden = !!val.trim(); }
    renderBlocks();
    toast("Đã lưu và áp dụng ngay","ok");
  } else { toast(d.error || "Lưu thất bại","err"); }
}

async function resetBlock(key){
  if(!(await askConfirm("Đưa cục này về nội dung mặc định?","Về mặc định"))) return;
  var r = await fetch("/admin/api/knowledge/block/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key})});
  if(handle401(r)) return;
  if(r.ok){ toast("Đã về mặc định","ok"); KNOW=null; loadKnow(); }
  else { toast("Thất bại","err"); }
}

function pinp(id,val){ return '<input id="'+id+'" class="input pinp" value="'+esc(val)+'"/>'; }
function ptaCard(id,label,val){ return '<div class="kcard"><div class="khead"><b>'+esc(label)+'</b></div><textarea id="'+id+'" class="ktext ktext-sm">'+esc(val)+'</textarea></div>'; }

function renderPrices(){
  var box = document.getElementById("know-prices");
  var p = KNOW.prices;
  var html = '<p class="note">Sửa số tiền rồi bấm “Lưu bảng giá”. Viết đầy đủ chữ: “4.5 triệu”, “500 nghìn” (đừng viết tắt “4.5tr”, “500k”).</p>';
  html += '<h3 class="kgroup">Thẻ hội viên theo tháng</h3><div class="ptable-wrap"><table class="ptable"><tr><th>Gói</th>';
  p.cards.FULL.moc.forEach(function(m){ html += '<th>'+esc(m[0])+'</th>'; });
  html += '</tr>';
  CARD_ORDER.forEach(function(k){
    var c = p.cards[k];
    html += '<tr><td class="pname">'+esc(c.ten)+'</td>';
    c.moc.forEach(function(m,i){ html += '<td>'+pinp("pc-"+k+"-"+i, m[1])+'</td>'; });
    html += '</tr>';
  });
  html += '</table></div>';
  html += '<h3 class="kgroup">Các bảng giá khác (giữ nguyên định dạng: mỗi mức 1 dòng)</h3>';
  html += ptaCard("pbk-pt-1-1","PT 1 kèm 1", p.bangKhac["pt-1-1"]);
  html += ptaCard("pbk-hoc-boi","Học bơi", p.bangKhac["hoc-boi"]);
  html += ptaCard("pbk-ve-boi-le","Vé bơi lẻ", p.bangKhac["ve-boi-le"]);
  html += ptaCard("pbk-pilates","Pilates", p.bangKhac["pilates"]);
  html += ptaCard("pbk-thue-hlv","Thuê HLV theo giờ", p.bangKhac["thue-hlv"]);
  html += ptaCard("pgiadinh","Gói gia đình", p.giaDinh);
  html += ptaCard("pgymthua","Gym tập thưa (theo buổi/tuần)", p.gymTapThua);
  html += ptaCard("pgcle","Giải cơ — buổi lẻ", p.giaiCoLe);
  html += ptaCard("pgclt","Giải cơ — liệu trình", p.giaiCoLieuTrinh);
  html += '<div class="kacts"><button class="btn btn-primary" onclick="savePrices()">Lưu bảng giá</button><button class="btn" onclick="resetPrices()">Về mặc định</button></div>';
  box.innerHTML = html;
}

function collectPrices(){
  var src = KNOW.prices;
  var cards = {};
  CARD_ORDER.forEach(function(k){
    var c = src.cards[k];
    cards[k] = { ten: c.ten, moc: c.moc.map(function(m,i){ return [m[0], document.getElementById("pc-"+k+"-"+i).value]; }) };
  });
  return {
    cards: cards,
    bangKhac: {
      "pt-1-1": document.getElementById("pbk-pt-1-1").value,
      "hoc-boi": document.getElementById("pbk-hoc-boi").value,
      "ve-boi-le": document.getElementById("pbk-ve-boi-le").value,
      "pilates": document.getElementById("pbk-pilates").value,
      "thue-hlv": document.getElementById("pbk-thue-hlv").value
    },
    giaDinh: document.getElementById("pgiadinh").value,
    gymTapThua: document.getElementById("pgymthua").value,
    giaiCoLe: document.getElementById("pgcle").value,
    giaiCoLieuTrinh: document.getElementById("pgclt").value
  };
}

async function savePrices(){
  var prices = collectPrices();
  var r = await fetch("/admin/api/knowledge/prices",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prices:prices})});
  if(handle401(r)) return;
  if(r.ok){ toast("Đã lưu bảng giá, áp dụng ngay","ok"); KNOW=null; loadKnow(); }
  else { toast("Lưu thất bại","err"); }
}

async function resetPrices(){
  if(!(await askConfirm("Đưa toàn bộ bảng giá về mặc định?","Về mặc định",true))) return;
  var r = await fetch("/admin/api/knowledge/prices/reset",{method:"POST"});
  if(handle401(r)) return;
  if(r.ok){ toast("Đã về mặc định","ok"); KNOW=null; loadKnow(); }
  else { toast("Thất bại","err"); }
}

// ── Khuyến mãi theo đợt ──
var PROMOS = [];

async function loadPromos(){
  var box = document.getElementById("know-promos");
  var r;
  try { r = await fetch("/admin/api/promos",{cache:"no-store"}); }
  catch(e){ box.innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; return; }
  if(handle401(r)) return;
  if(!r.ok){ box.innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
  var d = await r.json();
  PROMOS = d.promos || [];
  renderPromos();
}

function promoRow(p){
  var isNew = !p.id;
  var pid = isNew ? "new" : String(p.id);
  var badge = isNew ? '' :
    (p.live ? '<span class="badge on">Đang chạy</span>'
            : (p.active ? '<span class="badge">Chưa tới/đã hết hạn</span>' : '<span class="badge">Đang tắt</span>'));
  var h = '<div class="kcard"><div class="khead"><b>'+(isNew?'Thêm đợt ưu đãi mới':esc(p.title||'(chưa đặt tên)'))+'</b> '+badge+'</div>';
  h += '<label class="plbl">Tiêu đề</label>'+'<input id="pm-title-'+pid+'" class="input" value="'+esc(p.title||'')+'" placeholder="VD: Ưu đãi khai xuân"/>';
  h += '<label class="plbl">Nội dung (bot sẽ nói cho khách)</label><textarea id="pm-content-'+pid+'" class="ktext ktext-sm" placeholder="VD: Đăng ký gói năm trong tháng này tặng thêm 1 tháng tập.">'+esc(p.content||'')+'</textarea>';
  h += '<div class="prow">';
  h += '<span><label class="plbl">Từ ngày</label><input id="pm-start-'+pid+'" type="date" class="input pdate" value="'+esc(p.start_date||'')+'"/></span>';
  h += '<span><label class="plbl">Đến ngày</label><input id="pm-end-'+pid+'" type="date" class="input pdate" value="'+esc(p.end_date||'')+'"/></span>';
  h += '<label class="pchk"><input id="pm-active-'+pid+'" type="checkbox" '+(isNew||p.active?'checked':'')+'/> Bật</label>';
  h += '</div>';
  h += '<p class="note">Để trống ngày = không giới hạn. Đợt chỉ được bot dùng khi Bật + hôm nay nằm trong khoảng ngày.</p>';
  h += '<div class="kacts"><button class="btn btn-primary kbtn" onclick="savePromo(\\''+pid+'\\')">'+(isNew?'Thêm':'Lưu')+'</button>';
  if(!isNew) h += '<button class="btn kbtn" onclick="delPromo('+p.id+')">Xoá</button>';
  h += '</div></div>';
  return h;
}

function renderPromos(){
  var box = document.getElementById("know-promos");
  var html = '<p class="note">Chương trình khuyến mãi theo đợt. Bot chỉ nói ưu đãi khi đợt đang chạy (Bật + trong hạn); hết hạn tự ẩn, không cần tắt tay.</p>';
  html += promoRow({});
  if(PROMOS.length){ html += '<h3 class="kgroup">Các đợt đã tạo</h3>'; PROMOS.forEach(function(p){ html += promoRow(p); }); }
  box.innerHTML = html;
}

async function savePromo(pid){
  var g = function(k){ var el = document.getElementById("pm-"+k+"-"+pid); return el ? el.value : ""; };
  var body = {
    title: g("title"), content: g("content"),
    start_date: g("start"), end_date: g("end"),
    active: document.getElementById("pm-active-"+pid).checked
  };
  if(pid !== "new") body.id = Number(pid);
  if(!body.title.trim() || !body.content.trim()){ toast("Cần nhập tiêu đề và nội dung","err"); return; }
  var r = await fetch("/admin/api/promos/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(handle401(r)) return;
  var d = await r.json().catch(function(){return {};});
  if(r.ok){ toast("Đã lưu, áp dụng ngay","ok"); loadPromos(); }
  else { toast(d.error || "Lưu thất bại","err"); }
}

async function delPromo(id){
  if(!(await askConfirm("Xoá hẳn đợt ưu đãi này?","Xoá",true))) return;
  var r = await fetch("/admin/api/promos/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});
  if(handle401(r)) return;
  if(r.ok){ toast("Đã xoá","ok"); loadPromos(); }
  else { toast("Xoá thất bại","err"); }
}

// ── Tài liệu tham khảo (RAG) ──
var CAT_LABEL = {"fitness":"Kiến thức về fitness","tang-giam-can":"Kiến thức tăng giảm cân","dinh-duong":"Kiến thức về dinh dưỡng","tri-lieu":"Kiến thức về trị liệu","sale":"Cách sale","chung":"Chung"};

async function loadDocs(){
  var box = document.getElementById("docList");
  var r;
  try { r = await fetch("/admin/api/docs",{cache:"no-store"}); }
  catch(e){ box.innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; return; }
  if(handle401(r)) return;
  if(!r.ok){ box.innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
  var d = await r.json();
  renderDocs(d.docs || []);
}

function renderDocs(docs){
  var box = document.getElementById("docList");
  if(!docs.length){ box.innerHTML = '<p class="muted">Chưa có tài liệu nào.</p>'; return; }
  var html = '';
  docs.forEach(function(d){
    var cat = CAT_LABEL[d.category] || d.category;
    var when = (d.created_at||"").slice(0,10);
    html += '<div class="kcard"><div class="khead"><b>'+esc(d.title)+'</b> <span class="badge">'+esc(cat)+'</span>'
      + '<span class="muted" style="margin-left:auto">'+d.chunk_count+' đoạn · '+esc(when)+'</span></div>'
      + '<div class="kacts"><button class="btn kbtn" onclick="delDoc('+d.id+')">Xoá</button></div></div>';
  });
  box.innerHTML = html;
}

async function uploadDoc(){
  var btn = document.getElementById("doc-up-btn");
  var cat = document.getElementById("doc-cat").value;
  var title = document.getElementById("doc-title").value;
  var fileEl = document.getElementById("doc-file");
  var text = document.getElementById("doc-text").value;
  var hasFile = fileEl.files && fileEl.files.length;
  if(!hasFile && !text.trim()){ toast("Chọn file hoặc dán nội dung","err"); return; }

  btn.disabled = true; btn.textContent = "Đang xử lý…";
  var r;
  try {
    if(hasFile){
      var fd = new FormData();
      fd.append("file", fileEl.files[0]);
      fd.append("category", cat);
      fd.append("title", title);
      r = await fetch("/admin/api/docs/upload",{method:"POST",body:fd});
    } else {
      r = await fetch("/admin/api/docs/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:title,category:cat,text:text})});
    }
  } catch(e){ toast("Tải lên lỗi","err"); btn.disabled=false; btn.textContent="Nạp tài liệu"; return; }
  btn.disabled = false; btn.textContent = "Nạp tài liệu";
  if(handle401(r)) return;
  var d = await r.json().catch(function(){return {};});
  if(r.ok){
    toast("Đã nạp tài liệu ("+d.chunks+" đoạn), bot dùng được ngay","ok");
    document.getElementById("doc-title").value=""; fileEl.value=""; document.getElementById("doc-text").value="";
    loadDocs();
  } else { toast(d.error || "Nạp thất bại","err"); }
}

async function delDoc(id){
  if(!(await askConfirm("Xoá hẳn tài liệu này khỏi kiến thức bot?","Xoá",true))) return;
  var r = await fetch("/admin/api/docs/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});
  if(handle401(r)) return;
  if(r.ok){ toast("Đã xoá","ok"); loadDocs(); }
  else { toast("Xoá thất bại","err"); }
}

function switchTab(name){
  var tabs = ["users","knowledge","docs","media"];
  tabs.forEach(function(t){
    var tb = document.getElementById("tab-"+t); if(tb) tb.classList.toggle("active", t===name);
    var vw = document.getElementById("view-"+t); if(vw) vw.classList.toggle("hidden", t!==name);
  });
  if(name==="media" && MEDIA === null) loadMedia();
  if(name==="knowledge" && KNOW === null) loadKnow();
  if(name==="docs") loadDocs();
}

function fmtBytes(n){
  if(!n) return "0 B";
  var u = ["B","KB","MB","GB"];
  var i = Math.floor(Math.log(n)/Math.log(1024));
  return (n/Math.pow(1024,i)).toFixed(i?1:0) + " " + u[i];
}
function imgThumb(url){
  return url.indexOf("/upload/")>=0 ? url.replace("/upload/","/upload/c_fill,w_260,h_260,q_auto,f_auto/") : url;
}
function videoPoster(url){
  var u = url.indexOf("/upload/")>=0 ? url.replace("/upload/","/upload/so_0,c_fill,w_260,h_260/") : url;
  var dot = u.lastIndexOf(".");
  return dot>=0 ? u.slice(0,dot) + ".jpg" : u;
}

async function loadMedia(){
  var box = document.getElementById("mediaList");
  box.innerHTML = '<p class="muted">Đang tải…</p>';
  var r;
  try { r = await fetch("/admin/api/media",{cache:"no-store"}); }
  catch(e){ box.innerHTML = '<p class="muted">Không tải được thư viện. Thử lại sau.</p>'; return; }
  if(handle401(r)) return;
  if(!r.ok){ box.innerHTML = '<p class="muted">Không tải được thư viện. Thử lại sau.</p>'; return; }
  var d = await r.json();
  MEDIA = d.categories || [];
  if(d.limits) LIMITS = d.limits;
  renderMedia();
}

function renderMedia(){
  DELITEMS = [];
  var box = document.getElementById("mediaList");
  var html = "";
  MEDIA.forEach(function(cat){
    var items = (cat.images||[]).concat(cat.videos||[]);
    html += '<div class="cat">';
    html += '<div class="cat-head"><h2>' + esc(cat.label)
      + '<span class="cat-count">' + (cat.images||[]).length + ' ảnh · ' + (cat.videos||[]).length + ' video</span></h2>';
    html += '<div class="up-actions">'
      + '<button class="btn btn-sm up" data-base="' + esc(cat.base) + '" data-kind="img">+ Ảnh</button>'
      + '<button class="btn btn-sm up" data-base="' + esc(cat.base) + '" data-kind="video">+ Video</button>'
      + '</div></div>';
    if(items.length===0){
      html += '<p class="empty">Chưa có ảnh/video nào.</p>';
    } else {
      html += '<div class="grid">';
      items.forEach(function(it){
        var idx = DELITEMS.length;
        DELITEMS.push({ public_id: it.public_id, resource_type: it.resource_type });
        var isVideo = it.resource_type === "video";
        var thumb = isVideo
          ? '<img src="' + esc(videoPoster(it.url)) + '" onerror="this.remove()"/><span class="play">▶</span>'
          : '<img src="' + esc(imgThumb(it.url)) + '" loading="lazy"/>';
        html += '<div class="mcard">'
          + '<a class="mthumb" href="' + esc(it.url) + '" target="_blank" rel="noopener">' + thumb + '</a>'
          + '<div class="mmeta"><span class="mfmt">' + esc((it.format||"").toUpperCase()) + ' · ' + fmtBytes(it.bytes) + '</span>'
          + '<button class="del" data-i="' + idx + '" title="Xoá">✕</button></div>'
          + '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  });
  box.innerHTML = html;
  box.querySelectorAll(".up").forEach(function(b){
    b.addEventListener("click", function(){ pickFile(b.getAttribute("data-base"), b.getAttribute("data-kind")); });
  });
  box.querySelectorAll(".del").forEach(function(b){
    b.addEventListener("click", function(){ var t = DELITEMS[+b.getAttribute("data-i")]; if(t) deleteItem(t, b); });
  });
}

function pickFile(base, kind){
  var inp = document.getElementById("fileInput");
  inp.accept = kind === "video" ? "video/*" : "image/*";
  inp.onchange = function(){
    if(inp.files && inp.files[0]) uploadFile(base, kind, inp.files[0]);
    inp.value = "";
  };
  inp.click();
}

async function uploadFile(base, kind, f){
  var max = kind === "video" ? LIMITS.video : LIMITS.image;
  if(f.size > max){
    toast("File quá lớn (" + fmtBytes(f.size) + "). Tối đa " + fmtBytes(max) + " theo giới hạn Facebook.", "err");
    return;
  }
  var yes = await askConfirm("Tải " + (kind === "video" ? "video" : "ảnh") + " '" + f.name + "' (" + fmtBytes(f.size) + ") lên mục này?", "Tải lên");
  if(!yes) return;
  var box = document.getElementById("mediaList");
  box.classList.add("uploading");
  var fd = new FormData();
  fd.append("base", base); fd.append("kind", kind); fd.append("file", f);
  var r = await fetch("/admin/api/media/upload",{ method:"POST", body: fd });
  box.classList.remove("uploading");
  if(handle401(r)) return;
  if(r.ok){ toast("Đã tải lên.", "ok"); await loadMedia(); }
  else {
    var d = await r.json().catch(function(){ return {}; });
    toast(d.error === "too_large" ? "File vượt giới hạn của Facebook." : "Tải lên thất bại, thử lại.", "err");
  }
}

async function deleteItem(t, btn){
  var yes = await askConfirm("Xoá vĩnh viễn file này khỏi Cloudinary? Không thể hoàn tác.", "Xoá", true);
  if(!yes) return;
  if(btn) btn.disabled = true;
  var r = await fetch("/admin/api/media/delete",{ method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ public_id: t.public_id, resource_type: t.resource_type }) });
  if(handle401(r)){ if(btn) btn.disabled = false; return; }
  if(r.ok){ var d = await r.json().catch(function(){return {};}); if(d.ok){ toast("Đã xoá.", "ok"); await loadMedia(); return; } }
  if(btn) btn.disabled = false;
  toast("Xoá thất bại, thử lại.", "err");
}

boot();
</script>
</body>
</html>`;

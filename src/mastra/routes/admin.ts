/**
 * routes/admin.ts — Webadmin luồng mới (basic), 3 trang dạng tab client-side:
 *   1) Khách hàng   — danh sách user + tin nhắn gần nhất + bật/tắt AI (lẻ/tổng) + xoá (lib/botControl).
 *   2) Tài liệu     — danh sách tài liệu RAG + upload (PDF/Word/text) + XEM/SỬA trực tiếp + xoá.
 *   3) Ảnh/Video    — thư viện Cloudinary theo danh mục + upload (kèm dung lượng/giới hạn) + xoá.
 *
 * Giao diện + chức năng bám sát webadmin cũ (dark/light, bảng khách có cột tin nhắn, media hiện
 * dung lượng file + giới hạn), màu dịu.
 *
 * Auth: cookie ký HMAC bằng AUTH_SECRET, so username/password với ADMIN_USERNAME/ADMIN_PASSWORD.
 * Mọi API /admin/api/* đều qua isAuthed → 401 nếu chưa đăng nhập.
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import "dotenv/config";

import { listUsers, setBotEnabled, setGlobalEnabled, getGlobalEnabled, deleteBotUser } from "../lib/botControl";
import { clearHistory, lastPairsBatch } from "../lib/history";
import { listDocs, ingestDoc, deleteDoc, getDoc, updateDoc } from "../rag/store";
import { parseUpload } from "../lib/parseUpload";
import { loadConfig, saveConfig } from "../lib/settings";
import { monthlyCost, costByPurpose, loadPricing } from "../lib/costLog";
import {
  MEDIA_CATEGORIES,
  listCategoryMedia,
  uploadMedia,
  deleteMedia,
  isValidBase,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  type MediaKind,
} from "../lib/cloudinaryAdmin";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "fami@2026";
const AUTH_SECRET = process.env.AUTH_SECRET || "change-me-fami-secret";
const COOKIE = "admin_auth";

// ── Auth ──
function makeToken(): string {
  return createHmac("sha256", AUTH_SECRET).update(`ok:${ADMIN_USERNAME}`).digest("hex");
}
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
function isAuthed(c: any): boolean {
  const tok = getCookie(c, COOKIE);
  return !!tok && safeEq(tok, makeToken());
}

export const adminWebhook = new Hono();

adminWebhook.get("/admin", (c) => c.html(PAGE_HTML));

adminWebhook.post("/admin/api/login", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (safeEq(String(b.username ?? ""), ADMIN_USERNAME) && safeEq(String(b.password ?? ""), ADMIN_PASSWORD)) {
    setCookie(c, COOKIE, makeToken(), { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: "Sai tài khoản hoặc mật khẩu" }, 401);
});

adminWebhook.post("/admin/api/logout", (c) => {
  setCookie(c, COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return c.json({ ok: true });
});

adminWebhook.get("/admin/api/me", (c) => c.json({ authed: isAuthed(c) }));

// ── 1) Khách hàng ──
adminWebhook.get("/admin/api/users", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const [users, global] = await Promise.all([listUsers(), getGlobalEnabled()]);
    // Đính cặp tin nhắn gần nhất — lấy 1 lượt (2 query) cho 80 user mới nhất để khỏi N+1 chậm.
    const ids = users.slice(0, 80).map((u) => u.sender_id);
    const pairs = await lastPairsBatch(ids);
    const withMsgs = users.map((u, i) =>
      i < 80 ? { ...u, lastPair: pairs.get(u.sender_id) ?? { user: null, bot: null } } : { ...u, lastPair: null },
    );
    return c.json({ users: withMsgs, global });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

adminWebhook.post("/admin/api/users/toggle", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  await setBotEnabled(String(b.senderId), b.enabled === true);
  return c.json({ ok: true });
});

adminWebhook.post("/admin/api/global", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  await setGlobalEnabled(b.enabled === true);
  return c.json({ ok: true });
});

adminWebhook.post("/admin/api/users/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  const senderId = String(b.senderId ?? "");
  if (!senderId) return c.json({ error: "thiếu senderId" }, 400);
  await deleteBotUser(senderId);
  await clearHistory(senderId).catch(() => {});
  return c.json({ ok: true });
});

// ── 2) Tài liệu (RAG) ──
adminWebhook.get("/admin/api/docs", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json({ docs: await listDocs() });
});

adminWebhook.post("/admin/api/docs/upload", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const ct = c.req.header("content-type") || "";
    let title = "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form["file"] as File | undefined;
      title = String(form["title"] ?? "").trim();
      if (file && typeof (file as any).arrayBuffer === "function") {
        const buf = Buffer.from(await file.arrayBuffer());
        const parsed = await parseUpload(buf, file.name, (file as any).type || "");
        text = parsed.text;
        if (!title) title = file.name.replace(/\.[^.]+$/, "");
      } else {
        text = String(form["text"] ?? "");
      }
    } else {
      const b = await c.req.json().catch(() => ({}));
      title = String(b.title ?? "").trim();
      text = String(b.text ?? "");
    }
    if (!title) return c.json({ error: "Thiếu tên tài liệu" }, 400);
    const r = await ingestDoc({ title, text });
    return c.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

adminWebhook.post("/admin/api/docs/get", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  const doc = await getDoc(Number(b.id));
  if (!doc) return c.json({ error: "Không tìm thấy tài liệu" }, 404);
  return c.json({ doc });
});

adminWebhook.post("/admin/api/docs/update", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const b = await c.req.json().catch(() => ({}));
    const id = Number(b.id);
    if (!id) return c.json({ error: "Thiếu id tài liệu" }, 400);
    const r = await updateDoc(id, { title: String(b.title ?? ""), text: String(b.text ?? "") });
    return c.json({ ok: true, chunks: r.chunks });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

adminWebhook.post("/admin/api/docs/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  await deleteDoc(Number(b.id));
  return c.json({ ok: true });
});

// ── 3) Ảnh/Video (Cloudinary) ──
adminWebhook.get("/admin/api/media", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const cats = await Promise.all(
    MEDIA_CATEGORIES.map(async (cat) => ({ ...cat, ...(await listCategoryMedia(cat.base)) })),
  );
  return c.json({ categories: cats, limits: { image: IMAGE_MAX_BYTES, video: VIDEO_MAX_BYTES } });
});

adminWebhook.post("/admin/api/media/upload", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const form = await c.req.parseBody();
    const base = String(form["base"] ?? "");
    const kind = String(form["kind"] ?? "img") as MediaKind;
    const file = form["file"] as File | undefined;
    if (!isValidBase(base)) return c.json({ error: "Danh mục không hợp lệ" }, 400);
    if (!file || typeof (file as any).arrayBuffer !== "function") return c.json({ error: "Thiếu file" }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const max = kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
    if (buf.length > max) return c.json({ error: `File vượt giới hạn ${Math.round(max / 1024 / 1024)}MB` }, 400);
    const item = await uploadMedia({ base, kind, buffer: buf, filename: file.name });
    return c.json({ ok: true, item });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

adminWebhook.post("/admin/api/media/delete", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json().catch(() => ({}));
  const ok = await deleteMedia(String(b.publicId ?? ""), b.resourceType === "video" ? "video" : "image");
  return c.json({ ok });
});

// ── 4) Cấu hình runtime (giờ nghỉ đêm / kíp trực / nhịp gõ tin) ──
adminWebhook.get("/admin/api/config", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ config: await loadConfig() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

adminWebhook.post("/admin/api/config/save", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const b = await c.req.json().catch(() => ({}));
    const config = await saveConfig(b); // sanitize bên trong
    return c.json({ ok: true, config });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// ── 5) Chi phí AI (nhật ký gọi model phát sinh phí) ──
adminWebhook.get("/admin/api/cost", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json(await monthlyCost());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

adminWebhook.get("/admin/api/cost/detail", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const month = String(c.req.query("month") ?? "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: "tháng không hợp lệ" }, 400);
    return c.json({ rows: await costByPurpose(month) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

adminWebhook.get("/admin/api/pricing", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    return c.json({ pricing: await loadPricing() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ── UI (single page, 3 tab). Không dùng ${...} / backtick trong <script> (đang nằm trong template literal). ──
const PAGE_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Fami Fitness — Admin</title>
<script>(function(){var t=localStorage.getItem("theme");if(!t){t=(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches)?"light":"dark";}document.documentElement.setAttribute("data-theme",t);})();</script>
<style>
:root{--radius:10px;--shadow:0 1px 3px rgba(0,0,0,.14)}
[data-theme="dark"]{
  --bg:#13161d; --surface:#1a1e27; --field:#1e222c; --border:#2a2f3a;
  --text:#e3e6ec; --muted:#8b93a1; --mono:#98a1b0;
  --accent:#4f7cc9; --accent-h:#4571be; --accent-text:#fff;
  --btn:#232833; --btn-border:#333a47; --btn-h:#2b313d;
  --on-bg:#193626; --on-text:#5fd493; --off-bg:#3a1e1e; --off-text:#ec8a8a;
  --sw-off:#4b5563; --sw-on:#3fb56f;
}
[data-theme="light"]{
  --bg:#f5f7fa; --surface:#ffffff; --field:#fbfcfe; --border:#e6eaf0;
  --text:#2a3441; --muted:#6b7480; --mono:#6b7480;
  --accent:#4a72c0; --accent-h:#3f63ac; --accent-text:#fff;
  --btn:#ffffff; --btn-border:#dde2e9; --btn-h:#f0f3f7;
  --on-bg:#e3f5ea; --on-text:#2f9d63; --off-bg:#fdeaea; --off-text:#c85a5a;
  --sw-off:#cdd5df; --sw-on:#3fb56f;
}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);transition:background .2s,color .2s}
.wrap{max-width:920px;margin:0 auto;padding:28px 16px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.topbar h1{font-size:20px;font-weight:650;margin:0}
.subtitle{color:var(--muted);font-size:14px;margin:0 0 20px;line-height:1.5}
.actions{display:flex;gap:8px}
.btn{background:var(--btn);color:var(--text);border:1px solid var(--btn-border);border-radius:var(--radius);padding:8px 14px;cursor:pointer;font-size:14px;transition:background .15s}
.btn:hover{background:var(--btn-h)}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.btn-primary:hover{background:var(--accent-h)}
.btn-danger{background:var(--off-bg);border-color:var(--off-bg);color:var(--off-text)}
.btn-sm{padding:6px 10px;font-size:13px}
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
.badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--field);color:var(--muted)}
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
.tabs{display:flex;gap:4px;margin-bottom:18px;border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{background:none;border:none;color:var(--muted);padding:10px 14px;cursor:pointer;font-size:14px;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.kgroup{font-size:14px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin:22px 0 10px}
.kcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:12px;box-shadow:var(--shadow)}
.khead{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:14px}
.plbl{display:block;font-size:12px;color:var(--muted);margin:8px 0 4px}
.ktext{width:100%;min-height:180px;background:var(--field);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.5;resize:vertical}
.ktext-sm{min-height:90px}
.kacts{display:flex;gap:8px;margin-top:10px}
.kbtn{width:auto}
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
.del{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:13px;flex:none;line-height:1;transition:background .15s,color .15s,border-color .15s}
.del:hover{background:var(--off-bg);color:var(--off-text);border-color:var(--off-bg)}
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
.cfg-row{display:flex;gap:12px;flex-wrap:wrap}
.cfg-row > div{flex:1;min-width:120px}
.shift-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.shift-row .input{margin-top:0}
.shift-row .sh-name{max-width:130px}
.shift-row .sh-label{max-width:160px}
.shift-row .sh-start,.shift-row .sh-end{max-width:78px}
.shift-hd{display:flex;gap:8px;margin-bottom:6px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.shift-hd span:nth-child(1){min-width:130px}
.shift-hd span:nth-child(2){min-width:160px}
.shift-hd span:nth-child(3),.shift-hd span:nth-child(4){min-width:78px}
@media (max-width:640px){
  .wrap{padding:20px 12px}
  .master{flex-wrap:wrap}
  #list .panel{border:none;background:transparent;box-shadow:none;border-radius:0;overflow:visible}
  #list table,#list tbody{display:block;width:100%}
  #list thead{display:none}
  #list tbody tr{display:block;background:var(--surface);border:1px solid var(--border);border-radius:14px;margin-bottom:12px;box-shadow:var(--shadow);padding:4px 0}
  #list tbody td{display:block;border-bottom:none;padding:6px 16px}
  #list td.c-user{padding-top:12px}
  #list td.c-user .name{font-size:15px}
  #list td.c-msg{padding-bottom:11px;border-bottom:1px solid var(--border)}
  #list td.msgcol{max-width:none}
  #list td.c-act,#list td.c-ai,#list td.c-del{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left}
  #list td.c-act::before{content:"Hoạt động gần nhất"}
  #list td.c-ai::before{content:"Trợ lý AI"}
  #list td.c-del::before{content:"Xoá dữ liệu chat"}
  #list td.c-act::before,#list td.c-ai::before,#list td.c-del::before{color:var(--muted);font-size:13px;font-weight:600}
  #list td.c-del{padding-bottom:14px}
}
</style>
</head>
<body>
<div id="login" class="card hidden">
  <h1>Fami Fitness — Admin</h1>
  <p class="subtitle">Đăng nhập để quản lý trợ lý AI</p>
  <label class="label">Tài khoản</label>
  <input id="u" class="input" autofocus/>
  <div style="height:14px"></div>
  <label class="label">Mật khẩu</label>
  <input id="p" class="input" type="password" onkeydown="if(event.key==='Enter')doLogin()"/>
  <div style="height:22px"></div>
  <button class="btn btn-primary" style="width:100%;padding:11px" onclick="doLogin()">Đăng nhập</button>
  <div id="loginErr" class="error"></div>
</div>

<div id="app" class="wrap hidden">
  <div class="topbar">
    <h1>Fami Fitness — Admin</h1>
    <div class="actions">
      <button id="themeBtn" class="btn" onclick="toggleTheme()"></button>
      <button class="btn" onclick="doLogout()">Đăng xuất</button>
    </div>
  </div>

  <div class="tabs">
    <button id="tab-users" class="tab active" onclick="switchTab('users')">Khách hàng</button>
    <button id="tab-docs" class="tab" onclick="switchTab('docs')">Tài liệu</button>
    <button id="tab-media" class="tab" onclick="switchTab('media')">Ảnh / Video</button>
    <button id="tab-config" class="tab" onclick="switchTab('config')">Cấu hình</button>
    <button id="tab-cost" class="tab" onclick="switchTab('cost')">Chi phí AI</button>
  </div>

  <div id="view-users">
    <div id="master" class="master">
      <div>
        <h2>Trợ lý AI tự động <span id="masterBadge" class="badge on">Đang bật</span></h2>
        <p id="masterDesc" class="master-desc"></p>
      </div>
      <label class="switch"><input id="masterSw" type="checkbox" onchange="toggleGlobal(this)"/><span class="slider"></span></label>
    </div>
    <div id="usersWrap">
      <p class="subtitle">Bật hoặc tắt việc trợ lý AI tự động trả lời từng người.</p>
      <input id="q" class="input search" placeholder="Tìm theo tên hoặc ID…" oninput="render()"/>
      <div id="list"></div>
      <p id="userNote" class="note">Khi tắt, trợ lý AI sẽ ngừng trả lời người này. Thay đổi có hiệu lực ngay ở tin nhắn tiếp theo.</p>
    </div>
  </div>

  <div id="view-docs" class="hidden">
    <p class="subtitle">Tài liệu bot đọc để tư vấn (RAG). Nạp PDF, Word (.docx), text/.md — hoặc dán nội dung trực tiếp. Nạp/sửa xong bot dùng được ngay ở tin kế tiếp.</p>
    <div class="kcard">
      <div class="khead"><b>Nạp tài liệu mới</b></div>
      <label class="plbl">Tên tài liệu (để trống sẽ lấy tên file)</label>
      <input id="doc-title" class="input" placeholder="VD: Bảng giá Fami"/>
      <label class="plbl">Cách 1 — Chọn file (PDF / Word / text)</label>
      <input id="doc-file" type="file" accept=".pdf,.doc,.docx,.txt,.md,.markdown" class="input"/>
      <label class="plbl">Cách 2 — Hoặc dán nội dung text</label>
      <textarea id="doc-text" class="ktext ktext-sm" placeholder="Dán nội dung tài liệu vào đây nếu không có file."></textarea>
      <div class="kacts"><button id="doc-up-btn" class="btn btn-primary kbtn" onclick="uploadDoc()">Nạp tài liệu</button></div>
      <p class="note">File scan (ảnh) không đọc được chữ — hãy dán text.</p>
    </div>
    <h3 class="kgroup">Tài liệu hiện có</h3>
    <div id="docList"><p class="muted">Đang tải…</p></div>
  </div>

  <div id="view-media" class="hidden">
    <p class="subtitle" id="mediaSub">Ảnh/video gửi cho khách qua Facebook. Giới hạn: ảnh ≤ 8MB, video ≤ 25MB.</p>
    <div id="mediaList"><p class="muted">Đang tải…</p></div>
  </div>

  <div id="view-config" class="hidden">
    <p class="subtitle">Cấu hình bối cảnh "người thật" của bot: giờ nghỉ đêm, kíp trực (tên nhân viên theo ca) và nhịp gõ giữa các tin. Lưu xong áp dụng ngay ở tin kế tiếp — không cần cài lại.</p>

    <div class="kcard">
      <div class="khead"><b>Giờ nghỉ đêm</b></div>
      <p class="note" style="margin-top:0">Trong khung giờ này bot sẽ nhẹ nhàng giục khách đi ngủ, hẹn mai, không cố bán thêm. </p>
      <div class="cfg-row">
        <div><label class="plbl">Bắt đầu (giờ, 0–23)</label><input id="cfg-ln-start" type="number" min="0" max="23" class="input"/></div>
        <div><label class="plbl">Kết thúc (giờ sáng, 0–23)</label><input id="cfg-ln-end" type="number" min="0" max="23" class="input"/></div>
      </div>
    </div>

    <div class="kcard">
      <div class="khead"><b>Nhịp gõ giữa các tin nhắn con</b></div>
      <p class="note" style="margin-top:0">Bot tách câu trả lời dài thành nhiều tin; đây là khoảng chờ NGẪU NHIÊN giữa 2 tin để giống người thật đang gõ. Đặt bằng nhau nếu muốn cố định.</p>
      <div class="cfg-row">
        <div><label class="plbl">Tối thiểu (giây)</label><input id="cfg-delay-min" type="number" min="0" max="120" step="0.5" class="input"/></div>
        <div><label class="plbl">Tối đa (giây)</label><input id="cfg-delay-max" type="number" min="0" max="120" step="0.5" class="input"/></div>
      </div>
    </div>

    <div class="kcard">
      <div class="khead"><b>Kíp trực — tên nhân viên theo ca</b></div>
      <p class="note" style="margin-top:0">Theo giờ Việt Nam, bot xưng tên nhân viên đang trực ca đó (nếu khách hỏi tên). Ca qua đêm để giờ bắt đầu lớn hơn giờ kết thúc (VD 22 → 6). Các ca nên phủ kín 24 giờ và không chồng lấn.</p>
      <div class="shift-hd"><span>Tên</span><span>Tên ca</span><span>Từ giờ</span><span>Đến giờ</span><span></span></div>
      <div id="shiftRows"></div>
      <div class="kacts"><button class="btn btn-sm" onclick="addShift()">+ Thêm ca</button></div>
    </div>

    <div class="kacts"><button id="cfg-save-btn" class="btn btn-primary kbtn" onclick="saveConfigTab()">Lưu cấu hình</button></div>
  </div>

  <div id="view-cost" class="hidden">
    <p class="subtitle">Nhật ký các lần bot gọi AI có phát sinh phí, gom theo tháng. Mỗi lượt khách chat, bot gọi model vài lần (trả lời khách + viết lại câu hỏi + xếp hạng tài liệu). Tiền được tính theo bảng giá bên dưới (mặc định model <b>gemini-3.6-flash</b>).</p>

    <div id="costMonths"><p class="muted">Đang tải…</p></div>

    <div id="costDetail" class="hidden">
      <h3 class="kgroup">Chi tiết tháng <span id="costDetailMonth"></span></h3>
      <div id="costDetailBody"><p class="muted">Đang tải…</p></div>
    </div>

    <h3 class="kgroup">Bảng giá (USD cho mỗi 1 triệu token)</h3>
    <div class="kcard">
      <p class="note" style="margin-top:0">Toàn bộ chi phí tính theo gemini-3.6-flash. Giá giới thiệu tới 31/12/2026: 0,75 vào / 3,75 ra; từ 01/01/2027 Google dự kiến tăng.</p>
      <div id="priceView"></div>
    </div>
  </div>
</div>

<input id="fileInput" type="file" class="hidden"/>
<div id="toasts" class="toast-wrap"></div>

<script>
var USERS = [];
var GLOBAL_ON = true;
var PAGE = 1;
var PAGE_SIZE = 20;
var LAST_Q = null;
var MEDIA = null;
var LIMITS = { image: 8388608, video: 26214400 };
var DELITEMS = [];
var CONFIG = {};
var PRICING = null;

function show(id){ document.getElementById(id).classList.remove("hidden"); }
function hide(id){ document.getElementById(id).classList.add("hidden"); }
function val(id){ var el=document.getElementById(id); return el ? el.value : ""; }
function setVal(id,v){ var el=document.getElementById(id); if(el) el.value = (v==null?"":v); }
function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];}); }
function cut(s,n){ s=(s==null?"":String(s)); return s.length>n ? s.slice(0,n)+"…" : s; }
function fmt(iso){ try { return new Date(iso).toLocaleString("vi-VN",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit",year:"numeric",hour12:false}); } catch(e){ return iso; } }
function fmtBytes(n){ if(!n) return "0 B"; var u=["B","KB","MB","GB"]; var i=Math.floor(Math.log(n)/Math.log(1024)); return (n/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i]; }

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

async function doLogin(){
  document.getElementById("loginErr").textContent = "";
  var r = await fetch("/admin/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({username:document.getElementById("u").value, password:document.getElementById("p").value})});
  if(r.ok){ hide("login"); boot(); }
  else { var d = await r.json().catch(function(){return {};}); document.getElementById("loginErr").textContent = d.error || "Đăng nhập thất bại"; }
}
async function doLogout(){ await fetch("/admin/api/logout",{method:"POST"}); location.reload(); }

function forceLogin(msg){
  hide("app");
  document.querySelectorAll(".modal-bg").forEach(function(b){ b.remove(); });
  show("login");
  var le = document.getElementById("loginErr");
  if(le) le.textContent = msg || "";
}
function handle401(r){
  if(r && r.status===401){ forceLogin("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại."); return true; }
  return false;
}

async function boot(){
  updateThemeBtn();
  try {
    var me = await fetch("/admin/api/me",{cache:"no-store"}).then(function(r){return r.json();}).catch(function(){return {authed:false};});
    if(!me.authed){ hide("app"); show("login"); return; }
    hide("login"); show("app"); switchTab("users");
  } catch(e){ forceLogin("Có lỗi xảy ra, vui lòng đăng nhập lại."); }
}

function switchTab(name){
  ["users","docs","media","config","cost"].forEach(function(t){
    var tb = document.getElementById("tab-"+t); if(tb) tb.classList.toggle("active", t===name);
    var vw = document.getElementById("view-"+t); if(vw) vw.classList.toggle("hidden", t!==name);
  });
  if(name==="users") loadUsers();
  if(name==="docs") loadDocs();
  if(name==="media") loadMedia();
  if(name==="config") loadConfigTab();
  if(name==="cost") loadCostTab();
}

// ── Khách hàng ──
async function loadUsers(){
  document.getElementById("list").innerHTML = '<p class="muted">Đang tải…</p>';
  try {
    var r = await fetch("/admin/api/users",{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ document.getElementById("list").innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
    var d = await r.json();
    USERS = d.users || [];
    GLOBAL_ON = d.global !== false;
    renderGlobal(); render();
  } catch(e){ document.getElementById("list").innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; }
}

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
  var r = await fetch("/admin/api/global",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:next})});
  el.disabled = false;
  if(handle401(r)){ el.checked = !next; return; }
  if(r.ok){ GLOBAL_ON = next; renderGlobal(); toast(next ? "Đã bật AI cho tất cả mọi người." : "Đã tắt AI với tất cả mọi người.", "ok"); }
  else { el.checked = !next; toast("Cập nhật thất bại, thử lại.", "err"); }
}

function changePage(delta){ PAGE += delta; render(); }

function render(){
  var q = (document.getElementById("q").value||"").trim().toLowerCase();
  if(q !== LAST_Q){ PAGE = 1; LAST_Q = q; }
  var rows = USERS.filter(function(u){
    if(!q) return true;
    return (u.name||"").toLowerCase().indexOf(q)>=0 || String(u.sender_id).indexOf(q)>=0;
  });
  if(rows.length===0){ document.getElementById("list").innerHTML = '<p class="muted">Chưa có khách nào nhắn.</p>'; return; }
  var total = rows.length;
  var pages = Math.ceil(total / PAGE_SIZE);
  if(PAGE > pages) PAGE = pages;
  if(PAGE < 1) PAGE = 1;
  var start = (PAGE - 1) * PAGE_SIZE;
  var pageRows = rows.slice(start, start + PAGE_SIZE);
  var html = '<div class="panel"><table><thead><tr><th>Khách hàng</th><th>Tin nhắn gần nhất</th><th>Hoạt động gần nhất</th><th class="right">Trợ lý AI</th><th class="right">Xoá</th></tr></thead><tbody>';
  pageRows.forEach(function(u){
    var p = u.lastPair || {};
    var pairHtml = (!p.user && !p.bot)
      ? '<span class="muted">—</span>'
      : '<div class="msg-pair">'
          + (p.user ? '<div class="msg-line"><span class="msg-who user">Khách</span> ' + esc(cut(p.user,140)) + '</div>' : '')
          + (p.bot  ? '<div class="msg-line"><span class="msg-who bot">Bot</span> '   + esc(cut(p.bot,140))  + '</div>' : '')
        + '</div>';
    html += '<tr>'
      + '<td class="c-user"><div class="name">' + esc(u.name || "(chưa rõ tên)") + '</div><div class="mono">' + esc(u.sender_id) + '</div></td>'
      + '<td class="msgcol c-msg">' + pairHtml + '</td>'
      + '<td class="muted c-act">' + fmt(u.last_active) + '</td>'
      + '<td class="right c-ai"><label class="switch"><input type="checkbox" ' + (u.enabled?"checked":"")
      + ' onchange="toggle(\\'' + esc(u.sender_id) + '\\', this)"><span class="slider"></span></label></td>'
      + '<td class="right c-del"><button class="del" title="Xoá dữ liệu chat" onclick="delUser(\\'' + esc(u.sender_id) + '\\', this)">✕</button></td>'
      + '</tr>';
  });
  html += '</tbody></table></div>';
  if(pages > 1){
    var from = start + 1, to = start + pageRows.length;
    html += '<div class="pager">'
      + '<button class="btn" onclick="changePage(-1)"' + (PAGE<=1?" disabled":"") + '>‹ Trước</button>'
      + '<span class="pageinfo">' + from + '–' + to + ' / ' + total + ' · Trang ' + PAGE + '/' + pages + '</span>'
      + '<button class="btn" onclick="changePage(1)"' + (PAGE>=pages?" disabled":"") + '>Sau ›</button>'
      + '</div>';
  }
  document.getElementById("list").innerHTML = html;
}

async function toggle(senderId, el){
  el.disabled = true;
  var next = el.checked;
  var r = await fetch("/admin/api/users/toggle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senderId:senderId, enabled:next})});
  el.disabled = false;
  if(handle401(r)){ el.checked = !next; return; }
  if(r.ok){ var u = USERS.find(function(x){return x.sender_id===senderId;}); if(u) u.enabled = next; }
  else { el.checked = !next; toast("Cập nhật thất bại, thử lại.", "err"); }
}

async function delUser(senderId, btn){
  var yes = await askConfirm("Xoá toàn bộ dữ liệu chat của người này? Gồm tin nhắn và lịch sử hội thoại — KHÔNG thể hoàn tác.", "Xoá", true);
  if(!yes) return;
  if(btn) btn.disabled = true;
  var r = await fetch("/admin/api/users/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senderId:senderId})});
  if(handle401(r)){ if(btn) btn.disabled = false; return; }
  if(r.ok){ USERS = USERS.filter(function(x){ return x.sender_id !== senderId; }); render(); toast("Đã xoá dữ liệu chat.", "ok"); }
  else { if(btn) btn.disabled = false; toast("Xoá thất bại, thử lại.", "err"); }
}

// ── Tài liệu ──
async function loadDocs(){
  var box = document.getElementById("docList");
  try {
    var r = await fetch("/admin/api/docs",{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ box.innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
    var d = await r.json();
    renderDocs(d.docs || []);
  } catch(e){ box.innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; }
}

function docCardHtml(d, childName){
  var when = (d.created_at||"").slice(0,10);
  var label = (childName != null && childName !== "") ? childName : d.title;
  return '<div class="kcard"><div class="khead"><b>'+esc(label)+'</b>'
    + '<span class="muted" style="margin-left:auto">'+d.chunk_count+' đoạn · '+esc(when)+'</span></div>'
    + '<div class="kacts"><button class="btn kbtn" onclick="editDoc('+d.id+')">Xem / Sửa</button>'
    + '<button class="btn btn-danger kbtn" onclick="delDoc('+d.id+')">Xoá</button></div>'
    + '<div id="docedit-'+d.id+'" class="hidden" style="margin-top:12px"></div></div>';
}

// Gộp tài liệu con vào FOLDER cha. Tiêu đề dạng "<Folder> – <mục con>" → gộp theo tiền tố trước
// dấu " – "; tiêu đề KHÔNG có " – " (3 doc Fami) đứng lẻ trên đầu. Folder mặc định thu gọn.
function renderDocs(docs){
  var box = document.getElementById("docList");
  if(!docs.length){ box.innerHTML = '<p class="muted">Chưa có tài liệu nào.</p>'; return; }
  var SEP = " – ";
  var standalone = [], folders = {}, order = [];
  docs.forEach(function(d){
    var i = (d.title||"").indexOf(SEP);
    if(i < 0){ standalone.push(d); return; }
    var name = d.title.slice(0, i);
    if(!folders[name]){ folders[name] = []; order.push(name); }
    folders[name].push(d);
  });
  var html = "";
  standalone.forEach(function(d){ html += docCardHtml(d, null); });
  order.forEach(function(name, fi){
    var items = folders[name], chunks = 0, inner = "";
    items.forEach(function(d){
      chunks += (d.chunk_count||0);
      var i = d.title.indexOf(SEP);
      inner += docCardHtml(d, d.title.slice(i + SEP.length));
    });
    html += '<div class="kcard">'
      + '<div class="khead" onclick="toggleFolder('+fi+')" style="cursor:pointer;user-select:none">'
      + '<span id="folder-arrow-'+fi+'" style="margin-right:8px">▶</span>'
      + '<b>📁 '+esc(name)+'</b>'
      + '<span class="muted" style="margin-left:auto">'+items.length+' tài liệu · '+chunks+' đoạn</span></div>'
      + '<div id="folder-body-'+fi+'" class="hidden" style="margin-top:10px;padding-left:12px;border-left:2px solid #e5e7eb">'+inner+'</div>'
      + '</div>';
  });
  box.innerHTML = html;
}

function toggleFolder(fi){
  var body = document.getElementById("folder-body-"+fi);
  var arrow = document.getElementById("folder-arrow-"+fi);
  if(!body) return;
  var hidden = body.classList.toggle("hidden");
  if(arrow) arrow.textContent = hidden ? "▶" : "▼";
}

async function editDoc(id){
  var box = document.getElementById("docedit-"+id);
  if(box.getAttribute("data-loaded")==="1"){ box.classList.toggle("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = '<p class="muted">Đang tải…</p>';
  var r = await fetch("/admin/api/docs/get",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id})});
  if(handle401(r)) return;
  var d = await r.json().catch(function(){return {};});
  if(!r.ok){ box.innerHTML = '<p class="muted">'+esc(d.error||"Lỗi tải")+'</p>'; return; }
  var doc = d.doc;
  box.innerHTML =
    '<label class="plbl">Tên tài liệu</label>'
    + '<input id="doctitle-'+id+'" class="input" value="'+esc(doc.title)+'"/>'
    + '<label class="plbl">Nội dung (sửa xong bấm Lưu — bot cắt đoạn + học lại ngay)</label>'
    + '<textarea id="doctext-'+id+'" class="ktext">'+esc(doc.content)+'</textarea>'
    + '<div class="kacts"><button class="btn btn-primary kbtn" onclick="saveDoc('+id+')">Lưu tài liệu</button>'
    + '<button class="btn kbtn" onclick="editDoc('+id+')">Đóng</button></div>';
  box.setAttribute("data-loaded","1");
}

async function saveDoc(id){
  var title = document.getElementById("doctitle-"+id).value;
  var text = document.getElementById("doctext-"+id).value;
  if(!title.trim() || !text.trim()){ toast("Cần tên và nội dung","err"); return; }
  var r = await fetch("/admin/api/docs/update",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:id,title:title,text:text})});
  if(handle401(r)) return;
  var d = await r.json().catch(function(){return {};});
  if(r.ok){ toast("Đã lưu ("+d.chunks+" đoạn), bot dùng được ngay","ok"); loadDocs(); }
  else { toast(d.error || "Lưu thất bại","err"); }
}

async function uploadDoc(){
  var btn = document.getElementById("doc-up-btn");
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
      fd.append("file", fileEl.files[0]); fd.append("title", title);
      r = await fetch("/admin/api/docs/upload",{method:"POST",body:fd});
    } else {
      r = await fetch("/admin/api/docs/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:title,text:text})});
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

// ── Ảnh / Video ──
function imgThumb(url){ return url.indexOf("/upload/")>=0 ? url.replace("/upload/","/upload/c_fill,w_260,h_260,q_auto,f_auto/") : url; }
function videoPoster(url){
  var u = url.indexOf("/upload/")>=0 ? url.replace("/upload/","/upload/so_0,c_fill,w_260,h_260/") : url;
  var dot = u.lastIndexOf("."); return dot>=0 ? u.slice(0,dot) + ".jpg" : u;
}

async function loadMedia(){
  var box = document.getElementById("mediaList");
  box.innerHTML = '<p class="muted">Đang tải…</p>';
  try {
    var r = await fetch("/admin/api/media",{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ box.innerHTML = '<p class="muted">Không tải được thư viện. Thử lại sau.</p>'; return; }
    var d = await r.json();
    MEDIA = d.categories || [];
    if(d.limits) LIMITS = d.limits;
    document.getElementById("mediaSub").textContent =
      "Ảnh/video gửi cho khách qua Facebook. Giới hạn: ảnh ≤ " + fmtBytes(LIMITS.image) + ", video ≤ " + fmtBytes(LIMITS.video) + ".";
    renderMedia();
  } catch(e){ box.innerHTML = '<p class="muted">Không tải được thư viện. Thử lại sau.</p>'; }
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
  inp.onchange = function(){ if(inp.files && inp.files[0]) uploadFile(base, kind, inp.files[0]); inp.value = ""; };
  inp.click();
}

async function uploadFile(base, kind, f){
  var max = kind === "video" ? LIMITS.video : LIMITS.image;
  if(f.size > max){ toast("File quá lớn (" + fmtBytes(f.size) + "). Tối đa " + fmtBytes(max) + " theo giới hạn Facebook.", "err"); return; }
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
  else { var d = await r.json().catch(function(){ return {}; }); toast(d.error || "Tải lên thất bại, thử lại.", "err"); }
}

async function deleteItem(t, btn){
  if(!(await askConfirm("Xoá media này?","Xoá",true))) return;
  if(btn) btn.disabled = true;
  var r = await fetch("/admin/api/media/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({publicId:t.public_id, resourceType:t.resource_type})});
  if(handle401(r)){ if(btn) btn.disabled = false; return; }
  if(r.ok){ toast("Đã xoá.", "ok"); await loadMedia(); }
  else { if(btn) btn.disabled = false; toast("Xoá thất bại, thử lại.", "err"); }
}

// ── Toast + hộp xác nhận ──
// ── Cấu hình (giờ nghỉ đêm / kíp trực / nhịp gõ) ──
async function loadConfigTab(){
  document.getElementById("shiftRows").innerHTML = '<p class="muted">Đang tải…</p>';
  try {
    var r = await fetch("/admin/api/config",{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ toast("Lỗi tải cấu hình.","err"); return; }
    var d = await r.json();
    CONFIG = d.config || {};
    renderConfig();
  } catch(e){ toast("Không tải được cấu hình.","err"); }
}

function renderConfig(){
  setVal("cfg-ln-start", CONFIG.lateNightStart);
  setVal("cfg-ln-end", CONFIG.lateNightEnd);
  setVal("cfg-delay-min", (Number(CONFIG.bubbleDelayMinMs||0)/1000));
  setVal("cfg-delay-max", (Number(CONFIG.bubbleDelayMaxMs||0)/1000));
  renderShifts();
}

function renderShifts(){
  var list = CONFIG.shifts || [];
  var html = list.map(function(s,i){
    return '<div class="shift-row" data-i="'+i+'">'
      + '<input class="input sh-name" placeholder="Tên" value="'+esc(s.name)+'"/>'
      + '<input class="input sh-label" placeholder="ca sáng" value="'+esc(s.label)+'"/>'
      + '<input class="input sh-start" type="number" min="0" max="23" value="'+Number(s.start)+'"/>'
      + '<input class="input sh-end" type="number" min="0" max="23" value="'+Number(s.end)+'"/>'
      + '<button class="del" title="Xoá ca" onclick="removeShift('+i+')">✕</button>'
      + '</div>';
  }).join("");
  document.getElementById("shiftRows").innerHTML = html || '<p class="empty">Chưa có ca nào — bấm "Thêm ca".</p>';
}

// Đọc lại giá trị đang gõ trên DOM vào CONFIG.shifts (giữ chỉnh sửa chưa lưu khi thêm/xoá dòng).
function readShiftsFromDom(){
  var out = [];
  var rows = document.querySelectorAll("#shiftRows .shift-row");
  for(var k=0;k<rows.length;k++){
    var row = rows[k];
    out.push({
      name: row.querySelector(".sh-name").value.trim(),
      label: row.querySelector(".sh-label").value.trim(),
      start: parseInt(row.querySelector(".sh-start").value,10) || 0,
      end: parseInt(row.querySelector(".sh-end").value,10) || 0
    });
  }
  CONFIG.shifts = out;
}

function addShift(){
  readShiftsFromDom();
  if(!CONFIG.shifts) CONFIG.shifts = [];
  CONFIG.shifts.push({ name:"", label:"ca trực", start:0, end:0 });
  renderShifts();
}

function removeShift(i){
  readShiftsFromDom();
  CONFIG.shifts.splice(i,1);
  renderShifts();
}

async function saveConfigTab(){
  readShiftsFromDom();
  var payload = {
    lateNightStart: parseInt(val("cfg-ln-start"),10),
    lateNightEnd: parseInt(val("cfg-ln-end"),10),
    bubbleDelayMinMs: Math.round(parseFloat(val("cfg-delay-min"))*1000),
    bubbleDelayMaxMs: Math.round(parseFloat(val("cfg-delay-max"))*1000),
    shifts: CONFIG.shifts || []
  };
  if((payload.shifts||[]).some(function(s){ return !s.name; })){
    toast("Có ca chưa nhập tên — điền tên hoặc xoá ca đó.","err"); return;
  }
  var btn = document.getElementById("cfg-save-btn"); btn.disabled = true;
  try {
    var r = await fetch("/admin/api/config/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    if(handle401(r)) return;
    var d = await r.json().catch(function(){return {};});
    if(!r.ok || !d.ok){ toast(d.error || "Lưu thất bại.","err"); return; }
    CONFIG = d.config; renderConfig();
    toast("Đã lưu cấu hình ✓","ok");
  } catch(e){ toast("Không lưu được, thử lại.","err"); }
  finally { btn.disabled = false; }
}

// ── Chi phí AI ──
function fmtVnd(n){ try { return Math.round(Number(n||0)).toLocaleString("vi-VN") + " ₫"; } catch(e){ return "0 ₫"; } }
function fmtUsd(n){ var v = Number(n||0); return "$" + (v < 1 ? v.toFixed(4) : v.toFixed(2)); }
function fmtNum(n){ try { return Math.round(Number(n||0)).toLocaleString("vi-VN"); } catch(e){ return "0"; } }
function fmtMonth(m){ var p=(m||"").split("-"); return p.length===2 ? ("Tháng "+p[1]+"/"+p[0]) : m; }

async function loadCostTab(){
  document.getElementById("costMonths").innerHTML = '<p class="muted">Đang tải…</p>';
  document.getElementById("costDetail").classList.add("hidden");
  try {
    var r = await fetch("/admin/api/cost",{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ document.getElementById("costMonths").innerHTML = '<p class="muted">Lỗi tải dữ liệu.</p>'; return; }
    var d = await r.json();
    PRICING = d.pricing || null;
    renderCostMonths(d.months || []);
    renderPricing();
  } catch(e){ document.getElementById("costMonths").innerHTML = '<p class="muted">Không tải được. Thử lại sau.</p>'; }
}

function renderCostMonths(months){
  if(!months.length){
    document.getElementById("costMonths").innerHTML = '<p class="empty">Chưa có lần gọi AI nào được ghi nhận. Sau khi có khách chat, chi phí sẽ hiện ở đây.</p>';
    return;
  }
  var totUsd = 0, totVnd = 0;
  months.forEach(function(m){ totUsd += Number(m.costUsd||0); totVnd += Number(m.costVnd||0); });
  var html = '<div class="panel"><table><thead><tr>'
    + '<th>Tháng</th><th class="right">Số lần gọi</th><th class="right">Token vào</th><th class="right">Token ra</th>'
    + '<th class="right">Tạm tính (USD)</th><th class="right">Tạm tính (VNĐ)</th></tr></thead><tbody>';
  html += months.map(function(m){
    return '<tr class="crow" style="cursor:pointer" onclick="showCostDetail(\\''+esc(m.month)+'\\')">'
      + '<td><b>'+fmtMonth(m.month)+'</b></td>'
      + '<td class="right">'+fmtNum(m.calls)+'</td>'
      + '<td class="right">'+fmtNum(m.promptTokens)+'</td>'
      + '<td class="right">'+fmtNum(m.outputTokens)+'</td>'
      + '<td class="right">'+fmtUsd(m.costUsd)+'</td>'
      + '<td class="right"><b>'+fmtVnd(m.costVnd)+'</b></td></tr>';
  }).join("");
  html += '<tr><td><b>Tổng cộng</b></td><td class="right"></td><td class="right"></td><td class="right"></td>'
    + '<td class="right"><b>'+fmtUsd(totUsd)+'</b></td><td class="right"><b>'+fmtVnd(totVnd)+'</b></td></tr>';
  html += '</tbody></table></div>';
  html += '<p class="note">Bấm vào một tháng để xem chi tiết theo mục đích. "Tạm tính" = số token đã dùng × bảng giá hiện tại, chỉ mang tính ước lượng (hoá đơn thật xem trên Google AI Studio).</p>';
  document.getElementById("costMonths").innerHTML = html;
}

async function showCostDetail(month){
  document.getElementById("costDetail").classList.remove("hidden");
  document.getElementById("costDetailMonth").textContent = fmtMonth(month);
  document.getElementById("costDetailBody").innerHTML = '<p class="muted">Đang tải…</p>';
  try {
    var r = await fetch("/admin/api/cost/detail?month="+encodeURIComponent(month),{cache:"no-store"});
    if(handle401(r)) return;
    if(!r.ok){ document.getElementById("costDetailBody").innerHTML = '<p class="muted">Lỗi tải chi tiết.</p>'; return; }
    var d = await r.json();
    var rows = d.rows || [];
    if(!rows.length){ document.getElementById("costDetailBody").innerHTML = '<p class="empty">Không có dữ liệu.</p>'; return; }
    var html = '<div class="panel"><table><thead><tr>'
      + '<th>Mục đích</th><th class="right">Số lần</th><th class="right">Token vào</th>'
      + '<th class="right">Token ra</th><th class="right">Tạm tính (VNĐ)</th></tr></thead><tbody>';
    html += rows.map(function(x){
      return '<tr><td>'+esc(x.purpose)+'</td>'
        + '<td class="right">'+fmtNum(x.calls)+'</td>'
        + '<td class="right">'+fmtNum(x.promptTokens)+'</td>'
        + '<td class="right">'+fmtNum(x.outputTokens)+'</td>'
        + '<td class="right">'+fmtVnd(x.costVnd)+'</td></tr>';
    }).join("");
    html += '</tbody></table></div>';
    document.getElementById("costDetailBody").innerHTML = html;
    document.getElementById("costDetail").scrollIntoView({behavior:"smooth",block:"nearest"});
  } catch(e){ document.getElementById("costDetailBody").innerHTML = '<p class="muted">Không tải được.</p>'; }
}

function prNum(n){ return String(Number(n)).replace(".", ","); }
function renderPricing(){
  if(!PRICING) return;
  var m = (PRICING.models && PRICING.models["gemini-3.6-flash"]) || PRICING.default || {in:0.75,out:3.75};
  var html = '<div class="panel"><table><thead><tr><th>Khoản mục</th><th class="right">Giá trị</th></tr></thead><tbody>'
    + '<tr><td>Tỉ giá USD → VNĐ</td><td class="right">'+fmtNum(PRICING.usdToVnd)+' ₫</td></tr>'
    + '<tr><td>gemini-3.6-flash — giá token vào</td><td class="right">'+prNum(m.in)+' USD / 1 triệu token</td></tr>'
    + '<tr><td>gemini-3.6-flash — giá token ra</td><td class="right">'+prNum(m.out)+' USD / 1 triệu token</td></tr>'
    + '</tbody></table></div>';
  document.getElementById("priceView").innerHTML = html;
}

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

boot();
</script>
</body>
</html>`;

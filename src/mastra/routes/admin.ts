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
 *
 * ENV cần thêm: ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET (chuỗi ngẫu nhiên dài).
 * Dùng lại PG_* sẵn có (qua botControl.ts) — không cần biến DB mới.
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { listUsers, setBotEnabled, deleteBotUser } from "../lib/botControl";
import { cancelFollowup } from "../lib/followup";
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

// ── Xoá TOÀN BỘ dữ liệu chat của 1 user ──
// Quét mọi nơi lưu dữ liệu theo PSID (= threadId = resourceId):
//   (1) Mastra memory: tin nhắn + FSM state + vector semantic-recall  (stateStore)
//   (2) Postgres: dòng bot_controls + working-memory mastra_resources  (botControl)
//   (3) Cache RAM: senders (FB session) + followup timer + classify queue
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

  // (1) Mastra memory (tin nhắn + FSM state + vector).
  try {
    const { mastra } = await import("../index");
    const { deleteConversationData } = await import("../lib/stateStore");
    const r = await deleteConversationData(mastra, senderId);
    warnings.push(...r.errors);
  } catch (e) {
    warnings.push(`memory: ${(e as Error).message}`);
  }

  // (2) Postgres: bot_controls + working-memory resource. Lỗi ở đây là đáng kể → trả 500.
  try {
    await deleteBotUser(senderId);
  } catch (e) {
    console.error(`[admin] delete bot_controls failed for ${senderId}:`, e);
    return c.json({ error: "db_error", warnings }, 500);
  }

  // (3) Cache in-memory (best-effort, dynamic import tránh circular dep).
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
    <button id="tab-media" class="tab" onclick="switchTab('media')">Thư viện ảnh/video</button>
  </div>

  <div id="view-users">
    <p class="subtitle">Bật hoặc tắt việc trợ lý AI tự động trả lời từng người.</p>
    <input id="q" class="input search" placeholder="Tìm theo tên hoặc ID…" oninput="render()" />
    <div id="list"></div>
    <p class="note">Khi tắt, trợ lý AI sẽ ngừng trả lời người này. Thay đổi có hiệu lực ngay ở tin nhắn tiếp theo.</p>
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
    var r = await fetch("/admin/api/users",{cache:"no-store"});
    if(r.status===401){ forceLogin(); return; }
    if(!r.ok){ forceLogin("Không kết nối được máy chủ, vui lòng đăng nhập lại."); return; }
    var d = await r.json(); USERS = d.users || [];
    hide("login"); show("app"); updateThemeBtn(); render();
  } catch(e){
    forceLogin("Có lỗi xảy ra, vui lòng đăng nhập lại.");
  }
}

function render(){
  var q = (document.getElementById("q").value||"").trim().toLowerCase();
  var rows = USERS.filter(function(u){
    if(!q) return true;
    return (u.name||"").toLowerCase().indexOf(q)>=0 || String(u.sender_id).indexOf(q)>=0;
  });
  if(rows.length===0){ document.getElementById("list").innerHTML = '<p class="muted">Chưa có người dùng nào.</p>'; return; }
  var html = '<div class="panel"><table><thead><tr><th>Người dùng</th><th>Tin nhắn gần nhất</th><th>Hoạt động gần nhất</th><th>Trạng thái</th><th class="right">Trợ lý AI</th><th class="right">Xoá</th></tr></thead><tbody>';
  rows.forEach(function(u){
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

function switchTab(name){
  var isUsers = name === "users";
  document.getElementById("tab-users").classList.toggle("active", isUsers);
  document.getElementById("tab-media").classList.toggle("active", !isUsers);
  document.getElementById("view-users").classList.toggle("hidden", !isUsers);
  document.getElementById("view-media").classList.toggle("hidden", isUsers);
  if(!isUsers && MEDIA === null) loadMedia();
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

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
import { listUsers, setBotEnabled } from "../lib/botControl";

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

// ── Danh sách user ──
adminWebhook.get("/admin/api/users", async (c) => {
  if (!isAuthed(c)) return c.json({ error: "unauthorized" }, 401);
  try {
    const users = await listUsers();
    return c.json({ users });
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
.note{color:var(--muted);font-size:13px;margin-top:16px;line-height:1.5}
.hidden{display:none}
.right{text-align:right}
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
    <h1>Người dùng trợ lý AI</h1>
    <div class="actions">
      <button id="themeBtn" class="btn" onclick="toggleTheme()"></button>
      <button class="btn" onclick="doLogout()">Đăng xuất</button>
    </div>
  </div>
  <p class="subtitle">Bật hoặc tắt việc trợ lý AI tự động trả lời từng người.</p>
  <input id="q" class="input search" placeholder="Tìm theo tên hoặc ID…" oninput="render()" />
  <div id="list"></div>
  <p class="note">Khi tắt, trợ lý AI sẽ ngừng trả lời người này. Thay đổi có hiệu lực ngay ở tin nhắn tiếp theo.</p>
</div>

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

async function doLogin(){
  document.getElementById("loginErr").textContent = "";
  var r = await fetch("/admin/api/login",{method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({username:document.getElementById("u").value, password:document.getElementById("p").value})});
  if(r.ok){ hide("login"); boot(); }
  else { var d = await r.json().catch(function(){return {};}); document.getElementById("loginErr").textContent = d.error || "Đăng nhập thất bại"; }
}

async function doLogout(){ await fetch("/admin/api/logout",{method:"POST"}); location.reload(); }

async function boot(){
  updateThemeBtn();
  var r = await fetch("/admin/api/users",{cache:"no-store"});
  if(r.status===401){ hide("app"); show("login"); return; }
  var d = await r.json(); USERS = d.users || [];
  hide("login"); show("app"); updateThemeBtn(); render();
}

function render(){
  var q = (document.getElementById("q").value||"").trim().toLowerCase();
  var rows = USERS.filter(function(u){
    if(!q) return true;
    return (u.name||"").toLowerCase().indexOf(q)>=0 || String(u.sender_id).indexOf(q)>=0;
  });
  if(rows.length===0){ document.getElementById("list").innerHTML = '<p class="muted">Chưa có người dùng nào.</p>'; return; }
  var html = '<div class="panel"><table><thead><tr><th>Người dùng</th><th>Hoạt động gần nhất</th><th>Trạng thái</th><th class="right">Trợ lý AI</th></tr></thead><tbody>';
  rows.forEach(function(u){
    html += '<tr>'
      + '<td><div class="name">' + esc(u.name || "(chưa rõ tên)") + '</div><div class="mono">' + esc(u.sender_id) + '</div></td>'
      + '<td class="muted">' + fmt(u.last_active) + '</td>'
      + '<td><span class="badge ' + (u.enabled?"on":"off") + '">' + (u.enabled?"Đang bật":"Đã tắt") + '</span></td>'
      + '<td class="right"><label class="switch"><input type="checkbox" ' + (u.enabled?"checked":"")
      + ' onchange="toggle(\\'' + esc(u.sender_id) + '\\', this)"><span class="slider"></span></label></td>'
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
  if(r.ok){ var u = USERS.find(function(x){return x.sender_id===senderId;}); if(u) u.enabled = next; render(); }
  else { el.checked = !next; alert("Cập nhật thất bại, thử lại."); }
}

boot();
</script>
</body>
</html>`;

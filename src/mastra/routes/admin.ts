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
// Không backtick bên trong (đang nằm trong template literal).
// ─────────────────────────────────────────────
const PAGE_HTML = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>VNLink Admin</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f1115;color:#e6e8ec}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px}
.topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.topbar h1{font-size:20px;margin:0}
.btn{background:#2b2f3a;color:#e6e8ec;border:1px solid #3a3f4b;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:14px}
.btn:hover{background:#353a47}
.btn-primary{background:#2563eb;border-color:#2563eb;color:#fff;width:100%;padding:10px}
.input{width:100%;padding:10px 12px;margin-top:6px;background:#1a1d24;border:1px solid #2b2f3a;border-radius:8px;color:#e6e8ec;font-size:14px}
.search{max-width:320px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #20242d}
th{color:#8b93a1;font-weight:600;font-size:12px;text-transform:uppercase}
td.mono{font-family:ui-monospace,monospace;color:#9aa3b2;font-size:12px}
.badge{font-size:12px;padding:2px 8px;border-radius:999px}
.badge.on{background:#14331f;color:#4ade80}
.badge.off{background:#3a1414;color:#f87171}
.switch{position:relative;display:inline-block;width:46px;height:26px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;cursor:pointer;background:#4b5563;border-radius:999px;transition:.2s}
.slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
input:checked + .slider{background:#22c55e}
input:checked + .slider:before{transform:translateX(20px)}
.card{max-width:360px;margin:80px auto;background:#161922;padding:28px;border-radius:14px;border:1px solid #232733}
.card h1{font-size:20px;margin:0 0 18px}
.label{font-size:13px;color:#8b93a1}
.error{color:#f87171;font-size:13px;margin-top:12px}
.muted{color:#8b93a1;font-size:13px}
.hidden{display:none}
</style>
</head>
<body>
<div id="login" class="card hidden">
  <h1>VNLink Admin</h1>
  <label class="label">Tài khoản</label>
  <input id="u" class="input" autofocus />
  <div style="height:14px"></div>
  <label class="label">Mật khẩu</label>
  <input id="p" class="input" type="password" />
  <div style="height:20px"></div>
  <button class="btn btn-primary" onclick="doLogin()">Đăng nhập</button>
  <div id="loginErr" class="error"></div>
</div>

<div id="app" class="wrap hidden">
  <div class="topbar">
    <h1>🤖 AI Chatbot — Người dùng</h1>
    <button class="btn" onclick="doLogout()">Đăng xuất</button>
  </div>
  <input id="q" class="input search" placeholder="Tìm theo tên hoặc ID…" oninput="render()" />
  <div id="list"></div>
  <p class="muted" style="margin-top:18px">Tắt = AI ngừng trả lời người này (áp dụng ngay tin nhắn kế tiếp).</p>
</div>

<script>
var USERS = [];

function show(id){ document.getElementById(id).classList.remove("hidden"); }
function hide(id){ document.getElementById(id).classList.add("hidden"); }

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
  var r = await fetch("/admin/api/users",{cache:"no-store"});
  if(r.status===401){ hide("app"); show("login"); return; }
  var d = await r.json(); USERS = d.users || [];
  hide("login"); show("app"); render();
}

function render(){
  var q = (document.getElementById("q").value||"").trim().toLowerCase();
  var rows = USERS.filter(function(u){
    if(!q) return true;
    return (u.name||"").toLowerCase().indexOf(q)>=0 || String(u.sender_id).indexOf(q)>=0;
  });
  if(rows.length===0){ document.getElementById("list").innerHTML = '<p class="muted">Chưa có người dùng nào.</p>'; return; }
  var html = '<table><thead><tr><th>Người dùng</th><th>Hoạt động gần nhất</th><th>Trạng thái</th><th style="text-align:right">AI trả lời</th></tr></thead><tbody>';
  rows.forEach(function(u){
    html += '<tr>'
      + '<td><div>' + esc(u.name || "(chưa rõ tên)") + '</div><div class="mono">' + esc(u.sender_id) + '</div></td>'
      + '<td class="muted">' + fmt(u.last_active) + '</td>'
      + '<td><span class="badge ' + (u.enabled?"on":"off") + '">' + (u.enabled?"Đang bật":"Đã tắt") + '</span></td>'
      + '<td style="text-align:right"><label class="switch"><input type="checkbox" ' + (u.enabled?"checked":"")
      + ' onchange="toggle(\\'' + esc(u.sender_id) + '\\', this)"><span class="slider"></span></label></td>'
      + '</tr>';
  });
  html += '</tbody></table>';
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

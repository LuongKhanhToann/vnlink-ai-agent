/**
 * routes/admin.ts — Webadmin luồng mới (basic), 3 trang dạng tab client-side:
 *   1) Khách hàng   — danh sách user + bật/tắt AT/tổng + xoá (tái dùng lib/botControl).
 *   2) Tài liệu     — danh sách tài liệu RAG + upload (PDF/Word/text hoặc dán text) + xoá.
 *   3) Ảnh/Video    — thư viện Cloudinary theo danh mục + upload + xoá.
 *
 * Auth: cookie ký HMAC bằng AUTH_SECRET, so username/password với ADMIN_USERNAME/ADMIN_PASSWORD.
 * Mọi API /admin/api/* đều qua isAuthed → 401 nếu chưa đăng nhập.
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import "dotenv/config";

import { listUsers, setBotEnabled, setGlobalEnabled, getGlobalEnabled, deleteBotUser } from "../lib/botControl";
import { clearHistory } from "../lib/history";
import { listDocs, ingestDoc, deleteDoc } from "../rag/store";
import { parseUpload } from "../lib/parseUpload";
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
    return c.json({ users, global });
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
  return c.json({ categories: cats });
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

// ── UI (single page, 3 tab) ──
const PAGE_HTML = `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Fami Fitness — Admin</title>
<style>
  :root{--bg:#0f1420;--card:#171e2e;--line:#26304a;--fg:#e7ecf5;--mut:#95a2bd;--acc:#3b82f6;--ok:#16a34a;--danger:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  header h1{font-size:16px;margin:0}
  .tabs{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line);overflow-x:auto}
  .tabs button{flex:0 0 auto;background:transparent;color:var(--mut);border:1px solid var(--line);padding:8px 14px;border-radius:999px;font-size:14px;cursor:pointer}
  .tabs button.active{background:var(--acc);color:#fff;border-color:var(--acc)}
  main{padding:14px;max-width:960px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
  .row:last-child{border-bottom:0}
  .muted{color:var(--mut);font-size:13px}
  button.btn{background:var(--acc);color:#fff;border:0;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:14px}
  button.btn.gray{background:#31405f}
  button.btn.danger{background:var(--danger)}
  input,select,textarea{background:#0e1524;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;font-size:14px;width:100%}
  textarea{min-height:120px;resize:vertical}
  label{display:block;font-size:13px;color:var(--mut);margin:10px 0 5px}
  .switch{position:relative;width:46px;height:26px;flex:0 0 auto}
  .switch input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#3a4763;border-radius:999px;transition:.15s;cursor:pointer}
  .slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}
  .switch input:checked + .slider{background:var(--ok)}
  .switch input:checked + .slider:before{transform:translateX(20px)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-top:10px}
  .thumb{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;aspect-ratio:1}
  .thumb img,.thumb video{width:100%;height:100%;object-fit:cover;display:block}
  .thumb .x{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.6);color:#fff;border:0;border-radius:6px;padding:2px 7px;cursor:pointer}
  .toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#111827;border:1px solid var(--line);padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;transition:.2s;z-index:20}
  .toast.show{opacity:1}
  .login{max-width:340px;margin:12vh auto}
  .hidden{display:none}
  h3{margin:6px 0 2px;font-size:15px}
</style>
</head><body>

<div id="loginView" class="login hidden">
  <div class="card">
    <h1 style="margin-top:0">Fami Fitness — Admin</h1>
    <label>Tài khoản</label><input id="u" autocomplete="username"/>
    <label>Mật khẩu</label><input id="p" type="password" autocomplete="current-password"/>
    <button class="btn" style="margin-top:14px;width:100%" onclick="login()">Đăng nhập</button>
    <div id="loginErr" class="muted" style="color:#f87171;margin-top:8px"></div>
  </div>
</div>

<div id="appView" class="hidden">
  <header><h1>Fami Fitness — Admin</h1><button class="btn gray" onclick="logout()">Đăng xuất</button></header>
  <div class="tabs">
    <button data-tab="users" class="active" onclick="showTab('users')">Khách hàng</button>
    <button data-tab="docs" onclick="showTab('docs')">Tài liệu</button>
    <button data-tab="media" onclick="showTab('media')">Ảnh / Video</button>
  </div>
  <main>
    <section id="tab-users"></section>
    <section id="tab-docs" class="hidden"></section>
    <section id="tab-media" class="hidden"></section>
  </main>
</div>

<div id="toast" class="toast"></div>

<script>
const $ = (s)=>document.querySelector(s);
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}
async function api(path, opts){const r=await fetch(path,opts);let j={};try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;}

async function boot(){
  const me=await fetch("/admin/api/me").then(r=>r.json()).catch(()=>({authed:false}));
  if(me.authed){$("#loginView").classList.add("hidden");$("#appView").classList.remove("hidden");showTab("users");}
  else{$("#appView").classList.add("hidden");$("#loginView").classList.remove("hidden");}
}
async function login(){
  try{await api("/admin/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("#u").value,password:$("#p").value})});boot();}
  catch(e){$("#loginErr").textContent=e.message;}
}
async function logout(){await fetch("/admin/api/logout",{method:"POST"});boot();}

function showTab(name){
  document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));
  ["users","docs","media"].forEach(n=>$("#tab-"+n).classList.toggle("hidden",n!==name));
  if(name==="users")loadUsers();if(name==="docs")loadDocs();if(name==="media")loadMedia();
}

// ── Khách hàng ──
async function loadUsers(){
  const el=$("#tab-users");el.innerHTML='<div class="muted">Đang tải…</div>';
  try{
    const {users,global}=await api("/admin/api/users");
    let h='<div class="card"><div class="row"><div><b>Công tắc tổng</b><div class="muted">Tắt = AI im với mọi người</div></div>'
      +switchHtml("g",global,'toggleGlobal(this.checked)')+'</div></div>';
    h+='<div class="card"><h3>Danh sách khách ('+users.length+')</h3>';
    if(!users.length)h+='<div class="muted">Chưa có khách nào nhắn.</div>';
    users.forEach(u=>{
      h+='<div class="row"><div><b>'+esc(u.name||"(chưa rõ tên)")+'</b><div class="muted">'+u.sender_id+' · '+fmt(u.last_active)+'</div></div>'
        +'<div style="display:flex;gap:10px;align-items:center">'
        +switchHtml("u_"+u.sender_id,u.enabled,'toggleUser("'+u.sender_id+'",this.checked)')
        +'<button class="btn danger" onclick="delUser(\\''+u.sender_id+'\\')">Xoá</button></div></div>';
    });
    h+='</div>';el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="card muted">Lỗi: '+esc(e.message)+'</div>';}
}
function switchHtml(id,on,handler){return '<label class="switch"><input type="checkbox" '+(on?"checked":"")+' onchange="'+handler+'"><span class="slider"></span></label>';}
async function toggleGlobal(v){await api("/admin/api/global",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:v})});toast(v?"Đã BẬT AI tổng":"Đã TẮT AI tổng");}
async function toggleUser(id,v){await api("/admin/api/users/toggle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senderId:id,enabled:v})});toast("Đã cập nhật");}
async function delUser(id){if(!confirm("Xoá khách này và toàn bộ lịch sử chat?"))return;await api("/admin/api/users/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senderId:id})});toast("Đã xoá");loadUsers();}

// ── Tài liệu ──
async function loadDocs(){
  const el=$("#tab-docs");el.innerHTML='<div class="muted">Đang tải…</div>';
  try{
    const {docs}=await api("/admin/api/docs");
    let h='<div class="card"><h3>Nạp tài liệu</h3>'
      +'<label>Tên tài liệu</label><input id="docTitle" placeholder="VD: Bảng giá Fami"/>'
      +'<label>Chọn file (PDF / Word / .txt / .md)</label><input id="docFile" type="file" accept=".pdf,.doc,.docx,.txt,.md"/>'
      +'<label>… hoặc dán nội dung text</label><textarea id="docText" placeholder="Dán nội dung tài liệu vào đây"></textarea>'
      +'<button class="btn" style="margin-top:12px" onclick="uploadDoc()">Nạp tài liệu</button></div>';
    h+='<div class="card"><h3>Tài liệu hiện có ('+docs.length+')</h3>';
    if(!docs.length)h+='<div class="muted">Chưa có tài liệu nào.</div>';
    docs.forEach(d=>{h+='<div class="row"><div><b>'+esc(d.title)+'</b><div class="muted">'+d.chunk_count+' đoạn · '+fmt(d.created_at)+'</div></div>'
      +'<button class="btn danger" onclick="delDoc('+d.id+')">Xoá</button></div>';});
    h+='</div>';el.innerHTML=h;
  }catch(e){el.innerHTML='<div class="card muted">Lỗi: '+esc(e.message)+'</div>';}
}
async function uploadDoc(){
  const title=$("#docTitle").value.trim();const file=$("#docFile").files[0];const text=$("#docText").value.trim();
  try{
    toast("Đang nạp…");
    if(file){const fd=new FormData();fd.append("title",title);fd.append("file",file);await api("/admin/api/docs/upload",{method:"POST",body:fd});}
    else{if(!title||!text){toast("Cần tên + file hoặc text");return;}await api("/admin/api/docs/upload",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,text})});}
    toast("Đã nạp tài liệu");loadDocs();
  }catch(e){toast("Lỗi: "+e.message);}
}
async function delDoc(id){if(!confirm("Xoá tài liệu này?"))return;await api("/admin/api/docs/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});toast("Đã xoá");loadDocs();}

// ── Ảnh/Video ──
async function loadMedia(){
  const el=$("#tab-media");el.innerHTML='<div class="muted">Đang tải…</div>';
  try{
    const {categories}=await api("/admin/api/media");
    let h="";
    categories.forEach(cat=>{
      h+='<div class="card"><h3>'+esc(cat.label)+'</h3>';
      h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">'
        +'<button class="btn gray" onclick="pickUpload(\\''+cat.base+'\\',\\'img\\')">+ Ảnh</button>'
        +'<button class="btn gray" onclick="pickUpload(\\''+cat.base+'\\',\\'video\\')">+ Video</button></div>';
      h+='<div class="grid">';
      (cat.images||[]).forEach(m=>{h+=thumb(m,"image");});
      (cat.videos||[]).forEach(m=>{h+=thumb(m,"video");});
      if(!(cat.images||[]).length&&!(cat.videos||[]).length)h+='<div class="muted">Trống</div>';
      h+='</div></div>';
    });
    el.innerHTML=h+'<input id="mediaFile" type="file" class="hidden"/>';
  }catch(e){el.innerHTML='<div class="card muted">Lỗi: '+esc(e.message)+'</div>';}
}
function thumb(m,rt){
  const media=rt==="video"?'<video src="'+m.url+'" muted></video>':'<img src="'+m.url+'"/>';
  return '<div class="thumb">'+media+'<button class="x" onclick="delMedia(\\''+m.public_id+'\\',\\''+rt+'\\')">✕</button></div>';
}
let _up={base:"",kind:"img"};
function pickUpload(base,kind){_up={base,kind};const f=$("#mediaFile");f.accept=kind==="video"?"video/*":"image/*";f.onchange=doUpload;f.click();}
async function doUpload(){
  const file=$("#mediaFile").files[0];if(!file)return;
  try{toast("Đang tải lên…");const fd=new FormData();fd.append("base",_up.base);fd.append("kind",_up.kind);fd.append("file",file);
    await api("/admin/api/media/upload",{method:"POST",body:fd});toast("Đã tải lên");loadMedia();}
  catch(e){toast("Lỗi: "+e.message);}
  $("#mediaFile").value="";
}
async function delMedia(publicId,rt){if(!confirm("Xoá media này?"))return;await api("/admin/api/media/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({publicId,resourceType:rt})});toast("Đã xoá");loadMedia();}

function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function fmt(t){try{return new Date(t).toLocaleString("vi-VN")}catch(e){return t}}
boot();
</script>
</body></html>`;

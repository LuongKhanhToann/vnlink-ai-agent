/**
 * smokeRoutes.ts — Kiểm tầng route KHÔNG cần bật server: gọi thẳng .fetch() của Hono app.
 *   npx -y tsx src/mastra/scripts/smokeRoutes.ts
 */
import "dotenv/config";
import { adminWebhook } from "../routes/admin";
import { facebookWebhook } from "../routes/facebook";

const B = "http://local";
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  // 1) Admin page render
  const page = await adminWebhook.fetch(new Request(`${B}/admin`));
  const html = await page.text();
  check("GET /admin trả 200 HTML", page.status === 200 && html.includes("Fami Fitness — Admin"));
  check("HTML có 3 tab", html.includes("Khách hàng") && html.includes("Tài liệu") && html.includes("Ảnh / Video"));

  // 2) Chưa đăng nhập
  const me = await adminWebhook.fetch(new Request(`${B}/admin/api/me`));
  const meJson = await me.json();
  check("api/me khi chưa login → authed:false", meJson.authed === false);
  const users401 = await adminWebhook.fetch(new Request(`${B}/admin/api/users`));
  check("api/users chưa login → 401", users401.status === 401);

  // 3) Login sai / đúng
  const badLogin = await adminWebhook.fetch(new Request(`${B}/admin/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "x", password: "y" }),
  }));
  check("login sai → 401", badLogin.status === 401);

  const login = await adminWebhook.fetch(new Request(`${B}/admin/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "fami@2026" }),
  }));
  const setCookie = login.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0];
  check("login đúng → 200 + set-cookie", login.status === 200 && cookie.startsWith("admin_auth="));

  // 4) Có cookie → gọi được api
  const docs = await adminWebhook.fetch(new Request(`${B}/admin/api/docs`, { headers: { cookie } }));
  const docsJson = await docs.json();
  check("api/docs có cookie → 200 + list", docs.status === 200 && Array.isArray(docsJson.docs),
    `${docsJson.docs?.length ?? 0} tài liệu`);

  // 5) Facebook verify challenge
  const vt = process.env.FB_VERIFY_TOKEN || "";
  const verify = await facebookWebhook.fetch(new Request(
    `${B}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(vt)}&hub.challenge=12345`));
  const vtxt = await verify.text();
  check("FB GET /webhook verify → echo challenge", verify.status === 200 && vtxt === "12345");
  const badVerify = await facebookWebhook.fetch(new Request(
    `${B}/webhook?hub.mode=subscribe&hub.verify_token=SAI&hub.challenge=12345`));
  check("FB verify sai token → 403", badVerify.status === 403);

  console.log(`\n${fail === 0 ? "TẤT CẢ PASS" : "CÓ LỖI"}: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });

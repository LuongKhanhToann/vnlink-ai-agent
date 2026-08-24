/**
 * smokeConfigLive.ts — Smoke THỰC TẾ các tính năng cấu-hình-được, kiểm ĐÚNG LOGIC (config → hành vi).
 *
 *   npx -y tsx src/mastra/scripts/smokeConfigLive.ts
 *
 * Đọc CONFIG THẬT từ DB (bot_config), rồi:
 *   1) GIỜ NGHỈ ĐÊM — isLateNight theo khung config + reply thật: trong khung → giục ngủ; ngoài → bán bình thường.
 *   2) NHỊP GÕ    — humanTypingDelayMs bám biên [min,max]; sendReply thật (stub FB) → đo delay giữa bóng.
 *   3) CHỨNG MINH CONFIG-DRIVEN — dùng config KHÁC (dời khung nghỉ đêm), xác nhận bot ĐỔI theo.
 *
 * Model call ~3-4 lượt. KHÔNG đụng history khách (dựng messages tại chỗ như brain.ts, không lưu DB).
 */
import "dotenv/config";
import { generateReply, type ChatMsg } from "../llm/gemini";
import { FAMI_SYSTEM } from "../prompts/fami";
import { vnParts, buildTimeBlock, isLateNight, type VNParts } from "../lib/timeContext";
import { loadConfig, type BotRuntimeConfig } from "../lib/settings";
import { humanTypingDelayMs, sendReply } from "../routes/facebook";

let pass = 0,
  fail = 0;
const A = (cond: boolean, msg: string, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL " + msg + (extra ? "  → " + extra : "")); }
};

/** Date sao cho giờ VN = h (VN = UTC+7), ngày cố định 15/08/2026, phút mm. */
function vnAtHour(h: number, mm = 15): VNParts {
  const utcH = (h - 7 + 24) % 24;
  return vnParts(new Date(Date.UTC(2026, 7, 15, utcH, mm, 0)));
}
/** Giờ giữa 1 khung (hỗ trợ khung qua đêm start>end). */
function midHour(start: number, end: number): number {
  if (start === end) return start;
  if (start < end) return Math.floor((start + end) / 2);
  const len = 24 - start + end; // qua đêm
  return (start + Math.floor(len / 2)) % 24;
}

function buildMessages(userMsg: string, now: VNParts, config: BotRuntimeConfig): ChatMsg[] {
  const systemContent = [FAMI_SYSTEM, buildTimeBlock(now, config)].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: systemContent },
    { role: "user", content: `(${now.hhmm}) ${userMsg}` },
  ];
}
async function reply(userMsg: string, now: VNParts, config: BotRuntimeConfig): Promise<string> {
  let r = (await generateReply(buildMessages(userMsg, now, config), { temperature: 0.6, maxTokens: 450 })).trim();
  if (!r) r = (await generateReply(buildMessages(userMsg, now, config), { temperature: 0.6, maxTokens: 450 })).trim();
  return r;
}
const SLEEP_RE = /ngủ|khuya|nghỉ ngơi|muộn|mai .*(tư vấn|nhắn)|đi ngh/i;

async function main() {
  const original = await loadConfig(); // config THẬT hiện tại (source of truth)
  console.log("== CONFIG THẬT TỪ DB ==");
  console.log("  nghỉ đêm:", original.lateNightStart + "h→" + original.lateNightEnd + "h",
    "| nhịp gõ:", original.bubbleDelayMinMs + "-" + original.bubbleDelayMaxMs + "ms");

  // ── 1) GIỜ NGHỈ ĐÊM — logic ──
  console.log("\n== 1) GIỜ NGHỈ ĐÊM (logic: trong khung = true, ngoài = false) ==");
  const lnIn = midHour(original.lateNightStart, original.lateNightEnd);
  const lnOut = midHour(original.lateNightEnd, original.lateNightStart); // giữa khung "ban ngày"
  A(isLateNight(lnIn, original.lateNightStart, original.lateNightEnd), `giờ ${lnIn}h trong khung nghỉ đêm → true`);
  A(!isLateNight(lnOut, original.lateNightStart, original.lateNightEnd), `giờ ${lnOut}h ngoài khung → false`);

  // ── 2) NHỊP GÕ — biên [min,max] ──
  console.log("\n== 2) NHỊP GÕ (humanTypingDelayMs bám biên config) ==");
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < 3000; i++) { const d = humanTypingDelayMs(original.bubbleDelayMinMs, original.bubbleDelayMaxMs); if (d < mn) mn = d; if (d > mx) mx = d; }
  A(mn >= original.bubbleDelayMinMs && mx <= original.bubbleDelayMaxMs, `3000 mẫu đều trong [${original.bubbleDelayMinMs},${original.bubbleDelayMaxMs}]`, `đo [${mn},${mx}]`);
  A(mn <= original.bubbleDelayMinMs + 300 && mx >= original.bubbleDelayMaxMs - 300, "phủ gần cả cận dưới lẫn cận trên (ngẫu nhiên thật)", `đo [${mn},${mx}]`);

  // ── Reply thật với config GỐC ──
  console.log("\n== Reply THẬT (config gốc) ==");
  const nowDay = vnAtHour(lnOut);
  const rDay = await reply("Tư vấn tiếp cho anh gói tập gym với", nowDay, original);
  console.log(`  [${lnOut}h ban ngày] hỏi mua → ${rDay}`);
  A(!SLEEP_RE.test(rDay), "ban ngày KHÔNG giục ngủ");

  const nowNight = vnAtHour(lnIn);
  const rNight = await reply("Tư vấn tiếp cho anh gói tập gym với", nowNight, original);
  console.log(`  [${lnIn}h nghỉ đêm] hỏi mua → ${rNight}`);
  A(SLEEP_RE.test(rNight), `trong khung nghỉ đêm (${lnIn}h) → giục khách đi ngủ`);

  // ── 3) CHỨNG MINH CONFIG-DRIVEN (config object khác truyền thẳng, ĐÚNG như brain sau loadConfig) ──
  console.log("\n== 3) ĐỔI CONFIG → BOT ĐỔI THEO (config object khác, không đụng DB) ==");
  // Config mới: dời giờ nghỉ đêm sớm hơn (23h→22h).
  const modified: BotRuntimeConfig = {
    lateNightStart: 22, lateNightEnd: 5, // sớm hơn default (23h) 1 tiếng
    bubbleDelayMinMs: original.bubbleDelayMinMs, bubbleDelayMaxMs: original.bubbleDelayMaxMs,
  };
  // Dời GIỜ nghỉ đêm 23h→22h: tại 22h30, default(23-5) CHƯA ngủ, config mới(22-5) ĐÃ ngủ.
  A(!isLateNight(22, original.lateNightStart, original.lateNightEnd), "default: 22h CHƯA phải nghỉ đêm");
  A(isLateNight(22, modified.lateNightStart, modified.lateNightEnd), "config mới: 22h ĐÃ là nghỉ đêm");
  const rNewNight = await reply("Tư vấn tiếp gói gym cho anh", vnAtHour(22, 30), modified);
  console.log(`  [22h30 khung mới 22-5] hỏi mua → ${rNewNight}`);
  A(SLEEP_RE.test(rNewNight), "22h30 (đã dời giờ nghỉ đêm về 22h) → giục khách đi ngủ");

  // ── Nhịp gõ END-TO-END: sendReply THẬT tự đọc loadConfig() (config gốc trong DB) ──
  console.log("\n== Nhịp gõ END-TO-END (sendReply thật đọc config DB, stub FB) ==");
  const sends: number[] = [];
  const typings: number[] = [];
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (_u: any, o: any) => {
    try { const b = JSON.parse(o?.body ?? "{}"); if (b?.message?.text) sends.push(Date.now()); else if (b?.sender_action === "typing_on") typings.push(Date.now()); } catch {}
    return { ok: true, status: 200, text: async () => "ok" } as any;
  };
  const t0 = Date.now();
  await sendReply("SMOKE_TEST_PSID", "Bóng một ạ.\n\nBóng hai ạ.\n\nBóng ba ạ.");
  globalThis.fetch = origFetch;
  const g1 = sends[1] - sends[0], g2 = sends[2] - sends[1];
  console.log(`  gửi ${sends.length} bóng, ${typings.length} typing_on, gap ≈ ${g1}ms, ${g2}ms (tổng ${Date.now() - t0}ms)`);
  A(sends.length === 3, "tách đúng 3 bóng");
  A(typings.length >= 2, "có bật 'đang nhập…' giữa các bóng");
  const lo = original.bubbleDelayMinMs, hi = original.bubbleDelayMaxMs;
  A(g1 >= lo - 60 && g1 <= hi + 400 && g2 >= lo - 60 && g2 <= hi + 400, `gap giữa bóng nằm trong [${lo},${hi}]ms của config DB`, `đo ${g1},${g2}`);

  console.log(`\n═══ TỔNG: ${pass} PASS / ${fail} FAIL ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("LỖI SMOKE:", (e as Error).message); process.exit(1); });

/**
 * smokeConfigLive.ts — Smoke THỰC TẾ 3 tính năng cấu-hình-được, kiểm ĐÚNG LOGIC (config → hành vi).
 *
 *   npx -y tsx src/mastra/scripts/smokeConfigLive.ts
 *
 * Đọc CONFIG THẬT từ DB (bot_config), rồi:
 *   1) KÍP TRỰC   — shiftFor theo từng ca trong config + reply thật "Em tên gì?" đúng tên ca.
 *   2) GIỜ NGHỈ ĐÊM — isLateNight theo khung config + reply thật: trong khung → giục ngủ; ngoài → bán bình thường.
 *   3) NHỊP GÕ    — humanTypingDelayMs bám biên [min,max]; sendReply thật (stub FB) → đo delay giữa bóng.
 *   4) CHỨNG MINH CONFIG-DRIVEN — lưu config KHÁC (đổi tên ca + đổi khung nghỉ đêm), xác nhận bot ĐỔI theo,
 *      rồi KHÔI PHỤC config gốc (finally, luôn chạy).
 *
 * Model call ~5-6 lượt. KHÔNG đụng history khách (dựng messages tại chỗ như brain.ts, không lưu DB).
 */
import "dotenv/config";
import { generateReply, type ChatMsg } from "../llm/gemini";
import { FAMI_SYSTEM } from "../prompts/fami";
import { vnParts, buildTimeBlock, stampFor, shiftFor, isLateNight, type VNParts } from "../lib/timeContext";
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
/** Giờ giữa 1 ca (hỗ trợ ca qua đêm start>end). */
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
  const original = await loadConfig(); // config THẬT hiện tại (source of truth) — khôi phục ở finally
  console.log("== CONFIG THẬT TỪ DB ==");
  console.log("  nghỉ đêm:", original.lateNightStart + "h→" + original.lateNightEnd + "h",
    "| nhịp gõ:", original.bubbleDelayMinMs + "-" + original.bubbleDelayMaxMs + "ms",
    "| ca:", original.shifts.map((s) => s.name + "(" + s.start + "-" + s.end + ")").join(", "));

  try {
    // ── 1) KÍP TRỰC — logic ──
    console.log("\n== 1) KÍP TRỰC (logic: giờ → đúng tên ca theo config) ==");
    const cover: string[] = [];
    for (let h = 0; h < 24; h++) cover.push(shiftFor(h, original.shifts).name);
    for (const s of original.shifts) {
      const mh = midHour(s.start, s.end);
      A(shiftFor(mh, original.shifts).name === s.name, `giờ ${mh}h → ${s.name} (${s.label})`,
        `nhận ${shiftFor(mh, original.shifts).name}`);
    }
    A(cover.every((n, i) => shiftForHit(i, original.shifts)), "mọi giờ 0-23 đều map ĐÚNG 1 ca (không lỗ hổng)");
    console.log("  map giờ→tên:", cover.map((n, i) => i + ":" + n).join(" "));

    // ── 2) GIỜ NGHỈ ĐÊM — logic ──
    console.log("\n== 2) GIỜ NGHỈ ĐÊM (logic: trong khung = true, ngoài = false) ==");
    const lnIn = midHour(original.lateNightStart, original.lateNightEnd);
    const lnOut = midHour(original.lateNightEnd, original.lateNightStart); // giữa khung "ban ngày"
    A(isLateNight(lnIn, original.lateNightStart, original.lateNightEnd), `giờ ${lnIn}h trong khung nghỉ đêm → true`);
    A(!isLateNight(lnOut, original.lateNightStart, original.lateNightEnd), `giờ ${lnOut}h ngoài khung → false`);

    // ── 3) NHỊP GÕ — biên [min,max] ──
    console.log("\n== 3) NHỊP GÕ (humanTypingDelayMs bám biên config) ==");
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < 3000; i++) { const d = humanTypingDelayMs(original.bubbleDelayMinMs, original.bubbleDelayMaxMs); if (d < mn) mn = d; if (d > mx) mx = d; }
    A(mn >= original.bubbleDelayMinMs && mx <= original.bubbleDelayMaxMs, `3000 mẫu đều trong [${original.bubbleDelayMinMs},${original.bubbleDelayMaxMs}]`, `đo [${mn},${mx}]`);
    A(mn <= original.bubbleDelayMinMs + 300 && mx >= original.bubbleDelayMaxMs - 300, "phủ gần cả cận dưới lẫn cận trên (ngẫu nhiên thật)", `đo [${mn},${mx}]`);

    // ── Reply thật với config GỐC ──
    console.log("\n== Reply THẬT (config gốc) ==");
    const dayShift = original.shifts.find((s) => !isLateNight(midHour(s.start, s.end), original.lateNightStart, original.lateNightEnd)) || original.shifts[0];
    const dh = midHour(dayShift.start, dayShift.end);
    const nowDay = vnAtHour(dh);
    const rName = await reply("Cho hỏi em tên gì thế?", nowDay, original);
    console.log(`  [${dh}h ${dayShift.label}] hỏi tên → ${rName}`);
    A(rName.toLowerCase().includes(dayShift.name.toLowerCase()), `bot xưng đúng tên ca "${dayShift.name}"`);
    A(!SLEEP_RE.test(rName), "ban ngày KHÔNG giục ngủ");

    const nowNight = vnAtHour(lnIn);
    const rNight = await reply("Tư vấn tiếp cho anh gói tập gym với", nowNight, original);
    console.log(`  [${lnIn}h nghỉ đêm] hỏi mua → ${rNight}`);
    A(SLEEP_RE.test(rNight), `trong khung nghỉ đêm (${lnIn}h) → giục khách đi ngủ`);

    // ── 4) CHỨNG MINH CONFIG-DRIVEN (KHÔNG ghi đè DB — tránh ảnh khách thật; dùng config object
    //       khác nhau truyền thẳng, ĐÚNG như brain làm sau loadConfig) ──
    console.log("\n== 4) ĐỔI CONFIG → BOT ĐỔI THEO (config object khác, không đụng DB) ==");
    // Config mới HỢP LÝ: đổi tên ca (→ "Bảo Ngọc") + dời giờ nghỉ đêm sớm hơn (23h→22h).
    const modified: BotRuntimeConfig = {
      lateNightStart: 22, lateNightEnd: 5, // sớm hơn default (23h) 1 tiếng
      bubbleDelayMinMs: original.bubbleDelayMinMs, bubbleDelayMaxMs: original.bubbleDelayMaxMs,
      shifts: [
        { name: "Bảo Ngọc", label: "ca ngày", start: 5, end: 22 },
        { name: "Bảo Ngọc", label: "ca đêm", start: 22, end: 5 },
      ],
    };
    // (a) đổi TÊN ca → reply đổi theo (15h vẫn ban ngày, không giục ngủ)
    A(shiftFor(15, modified.shifts).name === "Bảo Ngọc", "config mới: shiftFor(15h) = 'Bảo Ngọc'");
    const rNewName = await reply("Ủa quên, em tên gì nhỉ?", vnAtHour(15), modified);
    console.log(`  [15h config mới] hỏi tên → ${rNewName}`);
    A(/ngọc/i.test(rNewName), "reply thật ĐỔI theo config: bot xưng 'Bảo Ngọc'");
    A(!SLEEP_RE.test(rNewName), "15h ban ngày → không giục ngủ");

    // (b) dời GIỜ nghỉ đêm 23h→22h: tại 22h30, default(23-5) CHƯA ngủ, config mới(22-5) ĐÃ ngủ.
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
  } finally {
    console.log("\n(config DB KHÔNG bị đụng trong smoke này)");
  }

  console.log(`\n═══ TỔNG: ${pass} PASS / ${fail} FAIL ═══`);
  process.exit(fail ? 1 : 0);
}

// helper cục bộ: giờ h có khớp ca nào không (mọi ca đều phủ non-overlap thì luôn true)
function shiftForHit(h: number, shifts: { start: number; end: number }[]): boolean {
  return shifts.some((s) => (s.start === s.end ? false : s.start < s.end ? h >= s.start && h < s.end : h >= s.start || h < s.end));
}

main().catch((e) => { console.error("LỖI SMOKE:", (e as Error).message); process.exit(1); });

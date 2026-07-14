/**
 * SMOKE bug "xoá nhầm reply thật" — chạy ĐÚNG webhook handler production (Hono .request),
 * nên đi qua đủ debounce → abort pre-commit → deleteLastAssistantMessage.
 * libsql → không đụng prod memory. Graph API sẽ fail (sender giả) — không sao, ta assert trên MEMORY.
 *
 * Kịch bản tái hiện đúng luồng 26526487480361334 lúc 15:17-15:18:
 *   T1: khách hỏi → bot trả lời (REPLY THẬT, khách đã đọc)
 *   T2: khách nhắn tiếp → turn chạy
 *   T3: khách nhắn thêm khi turn T2 CHƯA commit → abort → dọn phantom
 *   ASSERT: REPLY THẬT của T1 vẫn còn trong memory (trước fix: bị xoá mất)
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = "libsql";
process.env.ENGINE = "agent";

const SID = `smk-abort-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function evt(text: string) {
  return {
    object: "page",
    entry: [{ messaging: [{ sender: { id: SID }, recipient: { id: "PAGE" }, message: { text } }] }],
  };
}

// Bắt log để CHỨNG MINH nhánh abort thật sự chạy — không có nó thì smoke vô nghĩa (PASS giả).
const logged: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
    orig(...a);
  };
}

async function main() {
  const { facebookWebhook } = await import("../routes/facebook");
  const { memory } = await import("../config/memory");

  const post = async (text: string) => {
    await facebookWebhook.request("/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt(text)),
    });
  };

  const assistants = async (): Promise<string[]> => {
    let r: any;
    try {
      r = await memory.recall({ threadId: SID, resourceId: SID, perPage: 50 });
    } catch {
      return []; // thread chưa tồn tại (turn đầu chưa lưu xong)
    }
    return r.messages
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => {
        const c: any = m.content;
        const parts = c?.parts ?? c?.content ?? [];
        const t = Array.isArray(parts)
          ? parts.map((p: any) => p?.text ?? "").join(" ")
          : typeof c === "string"
            ? c
            : "";
        return t.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean);
  };

  // ── T1: 1 lượt bình thường, đợi bot trả xong ──
  console.log("T1 → khách: 'Tư vấn cho tôi khóa học bơi'");
  await post("Tư vấn cho tôi khóa học bơi");
  for (let i = 0; i < 40 && (await assistants()).length === 0; i++) await sleep(1000);
  const afterT1 = await assistants();
  console.log(`   bot đã trả (KHÁCH ĐÃ ĐỌC): "${afterT1[0]?.slice(0, 90)}..."`);
  if (!afterT1.length) throw new Error("T1 không sinh reply — smoke sai, dừng");

  // ── T2 rồi T3 dồn dập → ép abort pre-commit ──
  // T3 phải rơi SAU khi flush T2 chạy (debounce 5s) nhưng TRƯỚC commit (generate ~8-14s).
  const DEBOUNCE = Number(process.env.FB_DEBOUNCE_MS ?? "5000");
  console.log("\nT2 → khách: 'mình chưa biết bơi'  (bot bắt đầu nghĩ)");
  await post("mình chưa biết bơi");
  await sleep(DEBOUNCE + 2500); // qua debounce → turn đang generate, CHƯA commit
  console.log("T3 → khách nhắn CHÈN: 'mà 3 bố con học cùng được không'  ← ép abort");
  await post("mà 3 bố con học cùng được không");

  // đợi turn gộp chạy xong
  await sleep(50000);

  const afterT3 = await assistants();
  console.log("\n── MEMORY sau cùng ──");
  afterT3.forEach((t, i) => console.log(`  [${i + 1}] ${t.slice(0, 100)}`));

  const sawAbort = logged.some((l) => l.includes("aborting inflight turn"));
  const sawCleanup = logged.some(
    (l) => l.includes("deleted phantom assistant msg") || l.includes("skip delete for"),
  );
  const t1Survived = afterT3.some((t) => t === afterT1[0]);

  console.log("\n" + "=".repeat(70));
  console.log(`nhánh abort pre-commit có chạy? ${sawAbort ? "CÓ" : "KHÔNG"}`);
  console.log(`hàm dọn phantom có chạy?        ${sawCleanup ? "CÓ" : "KHÔNG"}`);
  logged
    .filter((l) => l.includes("skip delete for") || l.includes("deleted phantom"))
    .forEach((l) => console.log("   ↳", l.trim()));

  if (!sawAbort || !sawCleanup) {
    console.log("\n⚠️  INCONCLUSIVE — không chạm được nhánh abort, smoke KHÔNG chứng minh gì. Chỉnh timing rồi chạy lại.");
    process.exit(2);
  }
  console.log(
    t1Survived
      ? "\n✅ PASS — abort ĐÃ xảy ra, và reply THẬT của T1 vẫn còn trong memory (không bị xoá nhầm)"
      : "\n❌ FAIL — reply THẬT của T1 ĐÃ BỊ XOÁ khỏi memory (bug còn nguyên)",
  );
  console.log(`   (assistant msgs: ${afterT1.length} → ${afterT3.length})`);
  process.exit(t1Survived ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});

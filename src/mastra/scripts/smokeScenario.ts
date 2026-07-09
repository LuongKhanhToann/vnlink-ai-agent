/**
 * smokeScenario.ts — chạy NGUYÊN 1 kịch bản dài trong scenarios.ts qua ENGINE MỚI (runAgentTurn),
 * in đầy đủ từng lượt: tin khách · kỳ vọng · REPLY THẬT của bot · media tự gửi (nhãn ẢNH/VIDEO) · QR.
 *
 * Mục đích: soi tính năng TỰ ĐỘNG GỬI ẢNH/VIDEO + toàn bộ funnel dài (discovery→pitch→media→giá→chốt).
 * Media fetch Cloudinary THẬT (không mock). STORAGE_BACKEND=libsql → không đụng prod.
 *
 * Chạy:  STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeScenario.ts TANGCAN
 */

import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
process.env.ENGINE = "agent";

const scenarioId = process.argv[2] ?? "TANGCAN";

function mediaLabel(url: string): string {
  const isVideo = /\.(mp4|mov|webm|avi)(\?.*)?$/i.test(url) || url.toLowerCase().includes("/video/");
  return isVideo ? "🎬 VIDEO" : "🖼 ẢNH";
}

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { loadState } = await import("../lib/stateStore");
  const { getScenario } = await import("./scenarios");

  const sc = getScenario(scenarioId);
  if (!sc) {
    console.error(`Không thấy kịch bản "${scenarioId}".`);
    process.exit(1);
  }

  const stamp = Date.now();
  const threadId = `scn-${stamp}-${sc.id}`;

  console.log("\n" + "█".repeat(76));
  console.log(`█ ${sc.title}`);
  console.log(`█ flow=${sc.flow} · ${sc.turns.length} lượt · thread=${threadId}`);
  console.log(`█ GOAL: ${sc.goal}`);
  console.log("█".repeat(76));

  let mediaCount = 0;
  let videoCount = 0;

  for (let i = 0; i < sc.turns.length; i++) {
    const t = sc.turns[i];
    console.log("\n" + "─".repeat(76));
    console.log(`【${i + 1}/${sc.turns.length}】 KH: ${t.msg}`);
    if (t.expect) console.log(`   ⟨kỳ vọng⟩ ${t.expect}`);
    console.log("─".repeat(76));

    try {
      const out = await runAgentTurn({
        mastra,
        message: t.msg,
        threadId,
        resourceId: threadId,
      });

      console.log("BOT ▶ " + out.reply);

      if (out.mediaUrls?.length) {
        for (const u of out.mediaUrls) {
          const lbl = mediaLabel(u);
          if (lbl.includes("VIDEO")) videoCount++;
          else mediaCount++;
          console.log(`      ${lbl}: ${u}`);
        }
      }
      if (out.qrUrl) console.log(`      🔗 QR: ${out.qrUrl}`);

      const st = await loadState(mastra, threadId, threadId);
      const k = st.knownInfo;
      console.log(
        `      · flow=${st.flow} intent=${st.intent} stage=${st.stage} media=${(st.mediaShownKeys ?? []).join("|") || "—"}\n` +
          `      · name=${k.name} phone=${k.phone} svc=${k.serviceType} goal=${k.fitnessGoal} ` +
          `time=${k.preferredTime} date=${k.appointmentDate}`,
      );
    } catch (e) {
      console.error(`BOT ▶ ✖ LỖI: ${(e as Error).message}`);
      console.error((e as Error).stack);
    }
  }

  console.log("\n" + "█".repeat(76));
  console.log(`█ XONG. Tổng media tự gửi: ${mediaCount} ẢNH + ${videoCount} VIDEO.`);
  console.log("█".repeat(76));
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

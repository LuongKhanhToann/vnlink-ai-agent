/**
 * smokeGemma.ts — smoke REPLY THẬT qua engine gemma (engine/gemmaBrain.ts:runGemmaTurn).
 *
 * Đặt STORAGE_BACKEND=libsql → không đụng prod DB. Mỗi kịch bản 1 threadId riêng.
 * In reply + lead map sang prod state (tên/SĐT/ngày → Sheets) + media từng turn.
 *
 * 4 kịch bản phủ bề mặt rủi ro cao nhất:
 *   1) FITNESS: hỏi giá gym → giảm cân → chốt ngày → tên "Mai"+SĐT (case tên trùng "ngày mai")
 *   2) GIAICO : đau vai gáy (discovery đủ nhịp) → chấn thương <72h (an toàn cấp tính)
 *   3) MEDIA  : nghi ngờ kết quả tăng cân → phải bung ảnh before-after-gain (Cloudinary thật)
 *   4) HSSV   : sinh viên hỏi giá (bảng HS/SV đúng số)
 *
 * Endpoint/model/API key lấy từ .env (GEMMA_ENDPOINT · GEMMA_MODEL · GEMMA_API_KEY).
 * Chạy:  STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeGemma.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

interface Scenario {
  name: string;
  turns: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "FITNESS (giá→giảm cân→chốt, tên 'Mai')",
    turns: [
      "cho hỏi tập gym bên mình giá thế nào ạ",
      "c muốn giảm cân là chính, 1m60 70kg",
      "ok qua thử, chủ nhật nhé",
      "Mai 0906112233",
    ],
  },
  {
    name: "GIAICO (đau vai gáy→cấp tính)",
    turns: [
      "a hay đau mỏi vai gáy, ngồi máy tính nhiều",
      "hôm qua a với tay bê đồ giờ đau nhói, sưng lên rồi",
    ],
  },
  {
    name: "MEDIA (nghi ngờ tăng cân → before-after)",
    turns: [
      "a gầy 1m70 có 52kg, ăn mãi ko lên cân",
      "gầy thế này tập có lên được thật ko",
    ],
  },
  {
    name: "HSSV (sinh viên hỏi giá)",
    turns: ["e là sinh viên, tập gym giá nhiêu ạ"],
  },
];

async function main() {
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  const { loadState } = await import("../lib/stateStore");

  for (const scn of SCENARIOS) {
    const threadId = `smoke-gemma-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log(`\n${"═".repeat(70)}\n▶ ${scn.name}  (thread=${threadId})\n${"═".repeat(70)}`);
    for (const msg of scn.turns) {
      console.log(`\nKH: ${msg}`);
      const t0 = Date.now();
      try {
        const out = await runGemmaTurn({
          mastra,
          message: msg,
          threadId,
          resourceId: threadId,
        });
        console.log(`BOT (${((Date.now() - t0) / 1000).toFixed(1)}s): ${out.reply}`);
        if (out.mediaUrls?.length) console.log(`  📎 media: ${out.mediaUrls.join(" | ")}`);
        if (out.qrUrl) console.log(`  🔳 qr: ${out.qrUrl}`);
      } catch (e) {
        console.error(`  ✗ LỖI:`, (e as Error)?.message);
      }
    }
    const st = await loadState(mastra, threadId, threadId);
    console.log(
      `\n⚙ prod-state map: flow=${st.flow} honorific=${st.honorific} intent=${st.intent} stage=${st.stage} ` +
        `lead={tên=${st.knownInfo.name ?? "—"}, sđt=${st.knownInfo.phone ?? "—"}, giờ=${st.knownInfo.preferredTime ?? "—"}, ` +
        `ngày=${st.knownInfo.appointmentDate ?? "—"}} mediaKeys=[${(st.mediaShownKeys ?? []).join(",")}]`,
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

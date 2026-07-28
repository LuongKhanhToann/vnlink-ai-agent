/**
 * smokeGemmaRawTimeout.ts — diagnostic 1-off: gọi thẳng engine/gemma/pipeline.ts (bỏ qua cap
 * timeoutMs=120_000 cứng của gemmaBrain.ts) với budget dài hơn, để đo xem 1 lượt CLASSIFY+GENERATE
 * thật (system prompt đầy đủ + JSON schema) có hoàn tất được không nếu cho đủ thời gian, hay
 * đang thật sự treo/lỗi (không chỉ do timeout ngắn).
 *
 * Chạy:  STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeGemmaRawTimeout.ts
 */
import "dotenv/config";

async function main() {
  const { runGemmaTurn } = await import("../engine/gemma/pipeline");
  const { newState } = await import("../engine/gemma/state");

  const conv = newState();
  const t0 = Date.now();
  console.log("gọi runGemmaTurn (pipeline) timeoutMs=280000 ...");
  const out = await runGemmaTurn({
    conv,
    history: [],
    message: "cho em hỏi giá tập gym ạ",
    timeoutMs: 280_000,
  });
  console.log(`xong sau ${((Date.now() - t0) / 1000).toFixed(1)}s (cls=${out.clsSeconds.toFixed(1)}s gen=${out.genSeconds.toFixed(1)}s)`);
  console.log("REPLY:", out.reply);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

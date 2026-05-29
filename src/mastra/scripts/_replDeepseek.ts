// Temp repro: gọi fitnessAgent.generate() với deepseek-v4-pro để bắt lỗi gốc.
import "dotenv/config";
import { fitnessAgent } from "../agents/fitness";

(async () => {
  console.log("model =", process.env.DEEPSEEK_MODEL, "| key set =", !!process.env.DEEPSEEK_API_KEY);
  try {
    const res = await fitnessAgent.generate(
      [{ role: "user", content: "hii e, a muốn tập gym giảm mỡ" }],
      {
        memory: { thread: "repro-test-thread", resource: "facebook-customer" },
        maxSteps: 2,
        modelSettings: { temperature: 0.85, topP: 0.95 },
      } as any,
    );
    console.log("=== OK ===");
    console.log("text:", JSON.stringify(res.text));
    console.log("finishReason:", (res as any).finishReason);
  } catch (e: any) {
    console.log("=== ERROR ===");
    console.log("name:", e?.name);
    console.log("message:", e?.message);
    console.log("cause:", e?.cause?.message ?? e?.cause);
    if (e?.responseBody) console.log("responseBody:", e.responseBody);
    if (e?.stack) console.log("stack:", String(e.stack).split("\n").slice(0, 6).join("\n"));
  }
  process.exit(0);
})();

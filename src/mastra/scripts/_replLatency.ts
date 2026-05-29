import "dotenv/config";
import { fitnessAgent } from "../agents/fitness";

(async () => {
  const model = process.env.DEEPSEEK_MODEL;
  for (const msg of ["a muốn tập gym giảm mỡ", "gói gym bao nhiêu tiền v"]) {
    const t0 = Date.now();
    try {
      const res = await fitnessAgent.generate(
        [{ role: "user", content: msg }],
        { memory: { thread: "lat-" + model, resource: "facebook-customer" }, maxSteps: 2, modelSettings: { temperature: 0.85, topP: 0.95 } } as any,
      );
      console.log(`[${model}] ${((Date.now()-t0)/1000).toFixed(1)}s | "${res.text.slice(0,70)}..."`);
    } catch (e: any) { console.log(`[${model}] ERROR ${e?.message}`); }
  }
  process.exit(0);
})();

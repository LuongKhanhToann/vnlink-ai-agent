/**
 * scripts/smokeRagPipeline.ts — Smoke CHỈ-ĐỌC cho pipeline RAG mới (rewrite→hybrid→RRF→rerank).
 * KHÔNG mutate dữ liệu doc (chỉ kích hoạt DDL cộng-cột idempotent). Chạy:
 *   npx -y tsx src/mastra/scripts/smokeRagPipeline.ts
 */
import "dotenv/config";
import { retrieveForTurn } from "../rag/retrieve";
import { hasDocs } from "../rag/store";

type Case = { name: string; message: string; history?: { role: "user" | "assistant"; content: string }[] };

const CASES: Case[] = [
  { name: "Hỏi thẳng (giá gym)", message: "gói gym 12 tháng bao nhiêu tiền" },
  {
    name: "Nối tiếp cần ngữ cảnh",
    message: "còn cái kia thì bao nhiêu?",
    history: [
      { role: "user", content: "cho hỏi gói bơi cho bé" },
      { role: "assistant", content: "Dạ bên em có lớp học bơi cho bé ạ." },
    ],
  },
  { name: "Chào hỏi (nên bỏ tra cứu)", message: "alo shop ơi" },
];

async function main() {
  console.log("hasDocs:", await hasDocs());
  for (const c of CASES) {
    const t0 = Date.now();
    let block = "";
    let err = "";
    try {
      block = await retrieveForTurn({ message: c.message, history: c.history });
    } catch (e) {
      err = (e as Error).message;
    }
    const ms = Date.now() - t0;
    console.log(`\n──────── ${c.name} (${ms}ms) ────────`);
    console.log(`Q: ${c.message}`);
    if (err) console.log("ERROR:", err);
    else if (!block) console.log("→ (không có tài liệu / bỏ tra cứu)");
    else console.log(block.slice(0, 900));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("smoke fail:", e);
  process.exit(1);
});

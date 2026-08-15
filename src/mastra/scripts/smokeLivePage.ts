/**
 * smokeLivePage.ts — Smoke đa kịch bản đọc REPLY THẬT qua pipeline runTurn (cùng code vừa deploy,
 * cùng box models, cùng Supabase RAG chung). STORAGE_BACKEND=libsql để không đụng state prod.
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeLivePage.ts
 */
import "dotenv/config";
import { runTurn } from "../engine/brain";
import { clearHistory } from "../lib/history";

type Turn = string;
type Scenario = { id: string; name: string; turns: Turn[] };

const SCENARIOS: Scenario[] = [
  { id: "gia-gym", name: "Hỏi giá gói tập (fact Fami — số cụ thể)", turns: ["gói tập gym bên mình bao nhiêu tiền vậy shop"] },
  { id: "xong-hoi", name: "Xông hơi có không (case từng bị sách chen)", turns: ["phòng mình có xông hơi không ạ"] },
  { id: "khong-biet-boi", name: "Không biết bơi → bơi trị liệu", turns: ["em không biết bơi thì tập bơi trị liệu được không"] },
  { id: "tieu-duong", name: "Bệnh lý tiểu đường (guardrail y tế + kiến thức)", turns: ["mình bị tiểu đường tuýp 2, tập ở đây có kiểm soát đường huyết được không"] },
  { id: "dia-chi-gio", name: "Địa chỉ + giờ mở cửa", turns: ["trung tâm ở đâu, mấy giờ mở cửa vậy"] },
  { id: "sau-sinh", name: "Sau sinh đau lưng (guardrail + phễu)", turns: ["em mới sinh xong 3 tháng, đau lưng nhiều, muốn giảm cân thì tập gì"] },
  { id: "gia-khong-dau", name: "Gõ không dấu, câu ngắn", turns: ["gia bao nhieu 1 thang"] },
  { id: "tra-gop", name: "Trả góp / khuyến mại", turns: ["có trả góp không ạ, đang có ưu đãi gì không"] },
  { id: "chao-hoi", name: "Chào hỏi trống (không nên tra cứu)", turns: ["alo shop ơi"] },
  { id: "kien-thuc-sach", name: "Kiến thức thuần từ sách (mỡ nội tạng)", turns: ["mỡ nội tạng là gì thế, nó nguy hiểm không"] },
  { id: "noi-tiep-ngu-canh", name: "Nối tiếp ngữ cảnh (đại từ)", turns: ["bên mình có bơi trị liệu chứ", "thế cái đó giá sao"] },
];

async function main() {
  const only = process.env.ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const list = only?.length ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  console.log(`\n=== SMOKE LIVE PAGE — ${list.length} kịch bản (reply thật) ===\n`);

  for (const sc of list) {
    const sender = `smokelive_${sc.id}`;
    await clearHistory(sender).catch(() => {});
    console.log(`\n──────────── [${sc.id}] ${sc.name} ────────────`);
    for (const msg of sc.turns) {
      console.log(`👤 khách: ${msg}`);
      let reply = "";
      try {
        reply = (await runTurn({ senderId: sender, message: msg })).reply;
      } catch (e) {
        reply = `⚠️ LỖI: ${(e as Error)?.message}`;
      }
      console.log(`🤖 bot  : ${reply}\n`);
    }
    await clearHistory(sender).catch(() => {});
  }
  console.log("\n=== DONE ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

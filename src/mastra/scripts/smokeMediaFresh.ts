/**
 * smokeMediaFresh.ts — chứng minh cổng ảnh GỬI khi user MỚI (mediaSent rỗng).
 * 2 kịch bản, mỗi kịch bản threadId mới tinh (không dính cờ "đã gửi" cũ):
 *   A) tò mò cơ sở gym  → mong đợi media=fitness-gym bung ở lượt 2
 *   B) hoài nghi kết quả giảm cân → mong đợi fitness-before-after-loss
 * STORAGE_BACKEND=libsql → không đụng prod.
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

const SCEN = [
  { name: "Tò mò cơ sở (gym to không)", turns: ["a muốn tập gym để tăng cơ", "phòng gym bên em có to không, máy móc thế nào"] },
  { name: "Hoài nghi kết quả (giảm cân)", turns: ["e nặng 1m55 65kg muốn giảm cân", "tập ở đây liệu có giảm được thật không, e sợ tập rồi lại như cũ"] },
];

async function main() {
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  const { mastra } = await import("../index");
  for (const s of SCEN) {
    const tid = `smoke-mediafresh-${s.name.replace(/\W+/g, "").slice(0, 8)}-${SCEN.indexOf(s)}`;
    console.log(`\n${"═".repeat(64)}\n▶ ${s.name}  (thread=${tid})\n${"═".repeat(64)}`);
    for (const t of s.turns) {
      console.log(`\nKH: ${t}`);
      const r: any = await runGemmaTurn({ mastra, threadId: tid, resourceId: tid, message: t });
      const media = r?.mediaKeys?.length ? r.mediaKeys.join(", ") : (r?.mediaUrls?.length ? r.mediaUrls.join(", ") : "—");
      console.log(`BOT: ${r?.reply ?? r?.text ?? JSON.stringify(r).slice(0, 200)}`);
      console.log(`   📎 media=${media}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

/**
 * testNaturalUser.ts
 *
 * Mô phỏng user CHAT THẬT trên Messenger — không phải kịch bản "sạch":
 *   - viết tắt, không dấu, sai chính tả
 *   - hỏi lan man, kèm cảm xúc, off-topic
 *   - đổi ý giữa chừng
 *   - hỏi gộp nhiều câu trong 1 tin
 *   - cắt ngang
 *
 * Mục đích: SOI xem bot reply có tự nhiên không (không cần grader).
 *
 * Run:
 *   $env:STORAGE_BACKEND="libsql"; npx tsx src/mastra/scripts/testNaturalUser.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

// PHẢI import mastra trước routerWorkflow để storage bind vào workflow context.
await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");

interface Scenario {
  name: string;
  vibe: string; // mô tả "kiểu khách" để dễ đọc log
  messages: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "me_bim_sua_giam_can",
    vibe: "Mẹ bỉm sữa, hỏi lan man, lo lắng, off-topic về con",
    messages: [
      "aloo",
      "chị mới sinh đc 4 tháng, bụng eo bự lắm huhu",
      "tập có sao ko em, chị đang cho con bú",
      "à mà có chỗ trông con ko? chị ko gửi đâu đc",
      "thôi để chị qua xem đã, địa chỉ ở đâu vậy",
    ],
  },
  {
    name: "dan_van_phong_dau_lung_voi_vang",
    vibe: "Dân văn phòng đau lưng, gộp nhiều thông tin 1 tin, chốt nhanh",
    messages: [
      "shop có cái gì chữa đau lưng ko",
      "anh ngồi máy tính cả ngày, lưng dưới với cổ vai cứng đơ luôn",
      "tại sao đắt vậy có giảm gì ko",
      "ok anh tên Tuấn 0912345678, chiều mai 4h anh ghé thử 1 buổi xem sao",
    ],
  },
  {
    name: "khach_so_sanh_gia_kho_tinh",
    vibe: "Trả giá kỹ tính, so sánh đối thủ, dò trải nghiệm free",
    messages: [
      "gói rẻ nhất bao nhiêu vậy em",
      "uầy đắt thế, bên kia có 200k/tháng đấy",
      "tập thử có mất phí ko",
      "có gì để cho chị xem trước ko, hình ảnh phòng tập ấy",
      "ờ thôi cho chị xin địa chỉ chị qua xem",
    ],
  },
  {
    name: "khach_doi_y_giua_chung",
    vibe: "Đổi ý liên tục: gym → yoga → giải cơ → quay lại gym",
    messages: [
      "em ơi chị muốn tập gym để săn chắc",
      "à mà nghĩ lại chị stress quá, yoga có phù hợp ko",
      "thật ra chị đang đau vai gáy, bên em có giải cơ ko",
      "thôi vẫn tập gym đi, có HLV 1-1 ko",
      "ok cho chị thông tin gói, chị tên Mai 0901234567",
    ],
  },
  {
    name: "khach_lanh_tro_loi_ngan",
    vibe: "Reply cụt lủn, lười nói, bot phải đẩy chủ động",
    messages: [
      "có gì",
      "gym",
      "giảm cân",
      "tối",
      "bao nhiêu",
      "thôi",
    ],
  },
];

async function runOne(sc: Scenario) {
  const threadId = `natural-test-${Date.now()}-${sc.name}`;
  const resourceId = "natural-user";

  console.log(`\n${"═".repeat(78)}`);
  console.log(`▶  ${sc.name}`);
  console.log(`   vibe: ${sc.vibe}`);
  console.log(`${"═".repeat(78)}`);

  for (let i = 0; i < sc.messages.length; i++) {
    const msg = sc.messages[i];
    let reply = "(no reply)";
    let stage = "?";
    let intent = "?";
    let media = 0;
    let qr = false;
    const t0 = Date.now();

    try {
      const run = await routerWorkflow.createRun();
      const result = await run.start({
        inputData: { message: msg, threadId, resourceId },
      });
      const steps = (result as any).steps ?? {};
      const out =
        steps["call-fitness"]?.output ??
        steps["call-giai-co"]?.output ??
        steps["fallback"]?.output ??
        null;

      if (out) {
        reply = out.reply ?? "(no reply)";
        media = out.mediaUrls?.length ?? 0;
        qr = !!out.qrUrl;
      }
      // Lấy stage/intent từ next step nếu có
      const fitnessOut = steps["call-fitness"]?.output;
      const giaiCoOut = steps["call-giai-co"]?.output;
      stage = fitnessOut?.nextStep ?? giaiCoOut?.nextStep ?? "?";
    } catch (e) {
      reply = `❌ ERROR: ${String(e).slice(0, 200)}`;
    }

    const dur = Date.now() - t0;
    console.log(`\n[T${i + 1}] (${dur}ms${media ? ` 📷${media}` : ""}${qr ? " 💳QR" : ""})`);
    console.log(`  KH : ${msg}`);
    console.log(`  BOT: ${reply.replace(/\n/g, "\n       ")}`);
  }
}

async function main() {
  const filter = process.env.SCENARIOS?.trim();
  const selected = filter
    ? SCENARIOS.filter((s) => filter.split(",").some((f) => s.name.includes(f.trim())))
    : SCENARIOS;

  console.log(`\n🏃 Natural user test  |  ${selected.length} scenarios`);

  for (const sc of selected) {
    await runOne(sc);
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`✅ Done. Đọc reply trên để đánh giá độ tự nhiên.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

/**
 * testEdgeCases.ts
 *
 * Test các kịch bản KHÔNG có trong tài liệu Fami chính thức — edge cases thực tế:
 *   - Khách hỏi gộp 2 dịch vụ trong 1 tin
 *   - Khách đổi ý ngay turn đầu
 *   - Chính sách nhạy cảm (bảo lưu / hoàn tiền / đổi gói)
 *   - CSVC (chỗ gửi xe, tủ đồ, wifi, máy lọc khí)
 *   - Bộ môn không có trong list (boxing, dance, pilates)
 *   - Khách đã là hội viên cũ hỏi gia hạn
 *   - Đối tượng đặc thù (người cao tuổi, tim mạch)
 *   - Khiếu nại / phàn nàn
 *   - Cơ sở 2 / chi nhánh
 *
 * Run:
 *   $env:STORAGE_BACKEND="libsql"; npx tsx src/mastra/scripts/testEdgeCases.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

// PHẢI import mastra trước routerWorkflow để storage bind vào workflow context.
await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");

interface Scenario {
  name: string;
  vibe: string;
  messages: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "hoi_gop_combo",
    vibe: "Hỏi 2 dịch vụ + giá combo trong 1 tin",
    messages: [
      "shop có gym với yoga không, có gói combo cả 2 không em",
      "chị tập gym tăng cơ, yoga thư giãn cuối tuần",
      "1 tháng combo bao nhiêu",
    ],
  },
  {
    name: "doi_y_turn_dau",
    vibe: "Vừa nói tập gym → đổi sang yoga ngay tin sau",
    messages: [
      "anh muốn đăng ký gym",
      "à không, cho anh yoga thôi",
      "anh tập tối, 1 tháng nhiêu vậy em",
    ],
  },
  {
    name: "chinh_sach_bao_luu_doi_goi",
    vibe: "Hỏi chính sách: bảo lưu, đổi gói, hoàn tiền — case nhạy cảm",
    messages: [
      "thẻ tập có bảo lưu được không em",
      "đang tập gym mà muốn đổi sang yoga thì sao",
      "lỡ đăng ký rồi không tập có hoàn tiền không",
    ],
  },
  {
    name: "csvc_tien_ich",
    vibe: "Hỏi tiện ích phụ: chỗ gửi xe, tủ đồ, wifi, lọc khí, tắm",
    messages: [
      "bên em có chỗ gửi xe không, có mất phí không",
      "có tủ đồ với phòng tắm sau khi tập chứ",
      "phòng tập có máy lọc không khí không em",
    ],
  },
  {
    name: "bo_mon_khong_co",
    vibe: "Hỏi bộ môn không có (boxing, pilates, dance)",
    messages: [
      "bên em có boxing không",
      "thế pilates thì sao",
      "ờ thôi có lớp dance giảm cân nào không",
    ],
  },
  {
    name: "hoi_vien_cu_gia_han",
    vibe: "Khách đã là hội viên cũ, muốn gia hạn — không phải khách mới",
    messages: [
      "anh hết hạn thẻ gym tháng trước rồi, giờ muốn gia hạn",
      "anh tập gói 12 tháng, có ưu đãi gì cho khách cũ không",
      "anh tên Hùng, sđt cũ 0912345678",
    ],
  },
  {
    name: "doi_tuong_dac_thu_nguoi_gia",
    vibe: "Mẹ tập cho người lớn tuổi — case sensitive về sức khỏe",
    messages: [
      "mẹ anh 65 tuổi tập được không em",
      "bà có cao huyết áp với khớp gối hơi yếu",
      "có lớp nào nhẹ nhàng cho bà không",
    ],
  },
  {
    name: "khieu_nai_phong_dong",
    vibe: "Khách phàn nàn phòng tập đông — cần xử lý feedback",
    messages: [
      "hôm qua chị đến phòng tập đông quá không có máy",
      "tập 7h tối thì lúc nào cũng đông kiểu này à",
      "thế giờ nào vắng vắng tí",
    ],
  },
  {
    name: "chi_nhanh_co_so_2",
    vibe: "Hỏi cơ sở khác / chi nhánh ngoài Vĩnh Yên",
    messages: [
      "bên em có cơ sở 2 không",
      "anh ở Hà Nội tập được không, có chi nhánh trên này không",
    ],
  },
  {
    name: "khach_hoi_lung_tung",
    vibe: "Khách lúng túng — gõ sai chính tả, dùng từ teen, viết tắt",
    messages: [
      "co tap zumba k a oi",
      "ny e muon giam can ma luoi qua",
      "1th hk e",
      "ok ngày mai e qua đk",
    ],
  },
];

async function runOne(sc: Scenario) {
  const threadId = `edge-test-${Date.now()}-${sc.name}`;
  const resourceId = "edge-user";

  console.log(`\n${"═".repeat(78)}`);
  console.log(`▶  ${sc.name}`);
  console.log(`   vibe: ${sc.vibe}`);
  console.log(`${"═".repeat(78)}`);

  for (let i = 0; i < sc.messages.length; i++) {
    const msg = sc.messages[i];
    let reply = "(no reply)";
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

  console.log(`\n🏃 Edge cases test  |  ${selected.length} scenarios`);

  for (const sc of selected) {
    await runOne(sc);
  }

  console.log(`\n${"═".repeat(78)}`);
  console.log(`✅ Done.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

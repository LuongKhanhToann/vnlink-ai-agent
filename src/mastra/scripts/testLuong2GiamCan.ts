/**
 * 🅱️ LUỒNG 2 — GIẢM CÂN · khách ĐÃ biết tập (chat 1 mạch, 1 thread).
 *
 * Smoke 21 lượt liên tục để soi funnel: SAU SINH → InBody → thẻ hội viên
 * (KHÔNG ép PT) → before-after → đa môn (zumba+bơi) → giá → reframe value
 * → ưu đãi nhóm → chốt NGÀY → xin tên+SĐT → giữ slot → after-close.
 *
 * Mỗi turn in expectation (›) để đối chiếu mắt thường.
 *
 * Run: STORAGE_BACKEND=libsql npx tsx src/mastra/scripts/testLuong2GiamCan.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = "libsql";

const { mastra } = await import("../index");
const { routerWorkflow } = await import("../workflows/routerWorkflow");
const { loadState } = await import("../lib/stateStore");

interface Turn {
  msg: string;
  expect: string; // kỳ vọng hành vi bot (để soi mắt)
}

const TURNS: Turn[] = [
  { msg: "hi", expect: "chào mở đầu" },
  { msg: "c muốn giảm cân", expect: "xưng 'chị', hỏi cao–nặng / history" },
  { msg: "1m58 68kg, muốn giảm tầm 10kg", expect: "hỏi vùng tự ti" },
  { msg: "bụng với đùi nhiều mỡ lắm", expect: "hỏi thói quen sinh hoạt" },
  {
    msg: "ngồi văn phòng cả ngày, hay ăn vặt tối, với c mới sinh xong",
    expect: "⚠ SAU SINH → trấn an + lưu ý an toàn (hỏi HLV/giấy khám), KHÔNG ép gói",
  },
  {
    msg: "trước nhịn ăn với uống trà giảm cân mà ko xuống, còn mệt",
    expect: "đủ nỗi đau → InBody (không nhịn ăn mù quáng, đo mỡ thừa/cơ)",
  },
  {
    msg: "mà c tập gym với chạy bộ 2 năm rồi, cứ giảm xong lại lên",
    expect: "ĐÃ biết tập → tối ưu chi phí bằng THẺ HỘI VIÊN + tự dựa InBody chọn máy. KHÔNG ép PT, KHÔNG hỏi lại 'đã tập chưa'",
  },
  { msg: "đo inbody khác gì cân thường ở nhà", expect: "giải thích bóc tách mỡ/cơ, dẫn value" },
  {
    msg: "tập rồi liệu có xuống ko hay lại lên lại như cũ",
    expect: "🖼 GỬI ẢNH BEFORE-AFTER (đang nghi ngờ) + trấn an",
  },
  { msg: "zumba có giảm cân ko e", expect: "kiến thức Zumba (giảm mỡ toàn thân + xả stress), gợi kết hợp Gym" },
  {
    msg: "c cũng thích bơi nữa, bên mình có bể ko",
    expect: "nhớ ĐA MÔN: xác nhận có bơi (bể 4 mùa) + nhớ cả giảm cân",
  },
  { msg: "thế gói full bao nhiêu 1 tháng", expect: "báo gói Full hợp nhất + giá, không đổ hết bảng" },
  {
    msg: "đắt thế e",
    expect: "reframe VALUE (700m2 + bể 4 mùa + GV Ấn Độ + bãi đỗ xe), KHÔNG hạ giá / chia nhỏ ly cà phê",
  },
  { msg: "trung tâm gần đây ko, đỗ xe tiện ko", expect: "vị trí + bãi đỗ xe rộng" },
  { msg: "thôi để c thử 1 buổi xem", expect: "mời trải nghiệm miễn phí + suất giới hạn nhẹ" },
  { msg: "rủ thêm đứa bạn nữa được ko", expect: "ưu đãi nhóm" },
  { msg: "ok qua thử", expect: "hỏi NGÀY trước" },
  { msg: "sáng chủ nhật nhé", expect: "mới xin tên + SĐT" },
  { msg: "Hương, 0987654321", expect: "xác nhận giữ slot → DỪNG" },
  { msg: "tới đó có cần mang đồ bơi ko e", expect: "sau chốt: trả lời tự nhiên, KHÔNG xin lại info" },
  { msg: "ok thanks e", expect: "chào ấm" },
];

async function run() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const threadId = `test-luong2-giamcan-${runId}`;
  const resourceId = "luong2-tester";

  console.log(`\n${"═".repeat(80)}`);
  console.log(`🅱️  LUỒNG 2 — GIẢM CÂN · khách đã biết tập   |   thread=${threadId}`);
  console.log(`${"═".repeat(80)}`);

  for (let i = 0; i < TURNS.length; i++) {
    const { msg, expect } = TURNS[i];
    try {
      const r = await routerWorkflow.createRun();
      const result = await r.start({ inputData: { message: msg, threadId, resourceId } });
      const steps = (result as any).steps ?? {};
      const out =
        steps["call-fitness"]?.output ??
        steps["call-giai-co"]?.output ??
        steps["fallback"]?.output ??
        null;

      const state = await loadState(mastra, threadId, resourceId);
      const reply = (out?.reply ?? "(no reply)").trim();
      const media = out?.mediaUrls ?? out?.media ?? null;

      const k = state.knownInfo ?? {};
      console.log(`\n${"─".repeat(80)}`);
      console.log(`[${i + 1}] KH: ${msg}`);
      console.log(`    › kỳ vọng: ${expect}`);
      console.log(
        `    state: stage=${state.stage} intent=${state.intent} goal=${k.fitnessGoal ?? "-"} svc=${k.serviceType ?? "-"} mt=${k.memberType ?? "-"} name=${k.name ?? "-"} phone=${k.phone ?? "-"} time=${k.preferredTime ?? "-"}`,
      );
      if (media && (Array.isArray(media) ? media.length : true)) {
        console.log(`    📎 MEDIA: ${JSON.stringify(media)}`);
      }
      console.log(`    BOT: ${reply.replace(/\n/g, "\n         ")}`);
    } catch (e) {
      console.error(`[${i + 1}] ❌ error:`, e);
    }
  }

  process.exit(0);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

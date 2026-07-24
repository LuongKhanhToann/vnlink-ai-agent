/**
 * smokeEngine.ts — smoke REPLY THẬT qua engine mới (engine/brain.ts:runAgentTurn).
 *
 * Gọi thẳng runAgentTurn (bỏ qua tầng humanize/followup của facebook.ts) để đọc câu chữ
 * bot engine mới THỰC SỰ trả. Đặt STORAGE_BACKEND=libsql → không đụng prod. Mỗi kịch bản 1
 * threadId riêng (fresh state). In reply + slot + media/qr từng turn để soi nghiệp vụ.
 *
 * Chọn 4 kịch bản phủ bề mặt rủi ro cao nhất (không chạy hàng loạt tốn token):
 *   1) FITNESS: giá gym → mục tiêu giảm cân (media trước-sau) → chốt tên+SĐT+ngày (QR gate)
 *   2) GIAICO : đau vai gáy (đồng cảm, không tra hỏi) → mới đau 2 hôm (an toàn cấp tính <72h)
 *   3) DOIFLOW: hỏi giá gym (fitness) → than lưng đau mỏi (pivot sang giai-co)
 *   4) HSSV   : sinh viên hỏi giá gym (bảng giá HS/SV đúng số)
 *
 * Chạy:  STORAGE_BACKEND=libsql ENGINE=agent npx tsx src/mastra/scripts/smokeEngine.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
process.env.ENGINE = "agent";

interface Scenario {
  name: string;
  turns: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "FITNESS (giá→giảm cân→chốt QR)",
    turns: [
      "cho hỏi tập gym bên mình giá thế nào ạ",
      "mình muốn giảm cân là chính, nặng 78kg",
      "ok để mình đăng ký, mình tên Trung sđt 0987654321",
      "mai mình qua nhé",
    ],
  },
  {
    name: "GIAICO (đau vai gáy→an toàn cấp tính)",
    turns: [
      "em bị đau mỏi vai gáy mấy hôm nay khó chịu quá",
      "em mới bị có 2 hôm nay thôi, đau nhói khi quay cổ",
    ],
  },
  {
    name: "DOIFLOW (gym→lưng đau, pivot giai-co)",
    turns: [
      "cho hỏi giá gói gym ạ",
      "à mà dạo này lưng em đau mỏi quá, ngồi lâu là ê ẩm",
    ],
  },
  {
    name: "HSSV (sinh viên hỏi giá gym)",
    turns: [
      "em là sinh viên, tập gym bên mình giá bao nhiêu ạ",
    ],
  },
];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { loadState } = await import("../lib/stateStore");

  const stamp = Date.now();

  for (const sc of SCENARIOS) {
    const threadId = `smoke-${stamp}-${sc.name.slice(0, 6).replace(/\s/g, "")}`;
    console.log("\n" + "═".repeat(72));
    console.log("▶ " + sc.name + "   thread=" + threadId);
    console.log("═".repeat(72));

    for (let i = 0; i < sc.turns.length; i++) {
      const msg = sc.turns[i];
      console.log(`\n[KH ${i + 1}] ${msg}`);
      try {
        const out = await runAgentTurn({
          mastra,
          message: msg,
          threadId,
          resourceId: threadId,
        });
        console.log(`[BOT] ${out.reply}`);
        if (out.mediaUrls?.length) console.log(`   📷 media: ${out.mediaUrls.join(", ")}`);
        if (out.qrUrl) console.log(`   🔗 QR: ${out.qrUrl}`);
        const st = await loadState(mastra, threadId, threadId);
        const k = st.knownInfo;
        console.log(
          `   ⋯ flow=${st.flow} intent=${st.intent} stage=${st.stage} | ` +
            `name=${k.name} phone=${k.phone} svc=${k.serviceType} goal=${k.fitnessGoal} ` +
            `pain=${k.painArea} time=${k.preferredTime} date=${k.appointmentDate}`,
        );
      } catch (e) {
        console.error(`[BOT] ✖ LỖI: ${(e as Error).message}`);
        console.error((e as Error).stack);
      }
    }
  }

  console.log("\n✔ smoke xong.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

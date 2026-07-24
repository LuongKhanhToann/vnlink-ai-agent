/**
 * smokeEngine2.ts — ĐỢT SMOKE 2: các case KHÁC smokeEngine.ts (không lặp lại 4 case cũ).
 *
 * Nhắm vào bề mặt CHƯA từng soi: bảng giá theo ĐỐI TƯỢNG (giáo viên), bơi TRẺ EM (suy đối
 * tượng, không hỏi máy móc), CHỐNG BỊA (dịch vụ off-list), OBJECTION (đắt/trả góp), MEDIA do
 * nghi-ngờ-kết-quả, và SAU CHỐT (concierge, không xin lại info).
 *
 * Ngoài reply, script còn DUMP lịch sử memory của thread ở cuối để kiểm 1 nghi vấn:
 * brain.ts nối header [ĐÃ BIẾT: …] vào user message rồi mới generate → header đó có bị LƯU
 * vào thread history và tồn tại như "lời khách nói" ở các lượt sau không?
 *
 * Chạy: STORAGE_BACKEND=libsql npx tsx src/mastra/scripts/smokeEngine2.ts
 */

import "dotenv/config";

process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";
process.env.ENGINE = "agent";

interface Scenario {
  name: string;
  turns: string[];
  /** Điều cần SOI MẮT khi đọc reply (không assert cứng — funnel sale khó assert). */
  watch: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "GIAOVIEN (giá theo đối tượng)",
    watch: "phải ra bảng FULL giáo viên 700k/1.8tr/2.8tr/4.8tr — KHÔNG bê giá cá nhân",
    turns: [
      "mình là giáo viên cấp 2, muốn đăng ký tập bên mình thì giá sao ạ",
      "gói 12 tháng bao nhiêu",
    ],
  },
  {
    name: "BOITREEM (suy đối tượng)",
    watch: "nhận ra là TRẺ EM, không hỏi 'người lớn hay bé'; giá học bơi/bơi trẻ em đúng",
    turns: [
      "cho hỏi bên mình có dạy bơi cho bé không ạ",
      "bé nhà mình 7 tuổi, chưa biết bơi gì cả",
      "học 1 kèm 1 thì bao nhiêu tiền",
    ],
  },
  {
    name: "CHONGBIA (dịch vụ off-list)",
    watch: "KHÔNG bịa: không có xông hơi/sauna, không boxing, không bán nước; không trả góp",
    turns: [
      "bên mình có phòng xông hơi với sauna không ạ",
      "thế có lớp boxing không, với đóng tiền trả góp được không",
    ],
  },
  {
    name: "NGHINGO (media before-after)",
    watch: "lượt 2 phải bắn media fitness-before-after-loss + caption dẫn ảnh tự nhiên",
    turns: [
      "em muốn giảm mỡ bụng, nặng 72kg cao 1m58",
      "nhưng em tập mấy chỗ rồi mà có xuống đâu, sợ lại mất tiền vô ích",
    ],
  },
  {
    name: "SAUCHOT (concierge)",
    watch: "sau khi chốt: answer-first, KHÔNG xin lại tên/SĐT/giờ, KHÔNG pitch lại gói",
    turns: [
      "mình muốn đăng ký tập gym, mai qua được không",
      "mình tên Hà, sđt 0912345678, mai 9h sáng nhé",
      "qua đó cần mang gì không bạn",
      "chỗ mình gửi xe ô tô được không",
    ],
  },
];

async function main() {
  const { mastra } = await import("../index");
  const { runAgentTurn } = await import("../engine/brain");
  const { loadState } = await import("../lib/stateStore");

  const stamp = Date.now();
  let lastThread = "";

  for (const sc of SCENARIOS) {
    const threadId = `smk2-${stamp}-${sc.name.slice(0, 8).replace(/\s/g, "")}`;
    lastThread = threadId;
    console.log("\n" + "═".repeat(78));
    console.log("▶ " + sc.name);
    console.log("  SOI: " + sc.watch);
    console.log("═".repeat(78));

    for (let i = 0; i < sc.turns.length; i++) {
      const msg = sc.turns[i];
      console.log(`\n[KH ${i + 1}] ${msg}`);
      try {
        const out = await runAgentTurn({ mastra, message: msg, threadId, resourceId: threadId });
        console.log(`[BOT] ${out.reply}`);
        if (out.mediaUrls?.length) console.log(`   📷 media(${out.mediaUrls.length}): ${out.mediaUrls[0]}`);
        if (out.qrUrl) console.log(`   🔗 QR: ${out.qrUrl}`);
        const st = await loadState(mastra, threadId, threadId);
        const k = st.knownInfo;
        console.log(
          `   ⋯ flow=${st.flow} intent=${st.intent} | name=${k.name} phone=${k.phone} ` +
            `svc=${k.serviceType} member=${k.memberType} goal=${k.fitnessGoal} ` +
            `time=${k.preferredTime} date=${k.appointmentDate} written=${st.sheetsWritten}`,
        );
      } catch (e) {
        console.error(`[BOT] ✖ LỖI: ${(e as Error).message}`);
      }
    }
  }

  // ── KIỂM MEMORY: header [ĐÃ BIẾT] có rò vào lịch sử thread không? ──
  console.log("\n" + "═".repeat(78));
  console.log("▶ DUMP MEMORY thread cuối (" + lastThread + ")");
  console.log("═".repeat(78));
  try {
    const { memory } = await import("../config/memory");
    const res: any = await (memory as any).query({
      threadId: lastThread,
      selectBy: { last: 20 },
    });
    const msgs = res?.uiMessages ?? res?.messages ?? [];
    for (const m of msgs) {
      const content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? m.parts ?? "").slice(0, 400);
      console.log(`  [${m.role}] ${String(content).slice(0, 300).replace(/\n/g, " ⏎ ")}`);
    }
    const leaked = msgs.filter(
      (m: any) => m.role === "user" && JSON.stringify(m.content ?? m.parts ?? "").includes("ĐÃ BIẾT"),
    ).length;
    console.log(`\n  → user message chứa header "[ĐÃ BIẾT" : ${leaked} / ${msgs.length}`);
  } catch (e) {
    console.error("  dump memory lỗi:", (e as Error).message);
  }

  console.log("\n✔ smoke 2 xong.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

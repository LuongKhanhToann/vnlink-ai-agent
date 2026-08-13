/**
 * smokeMediaGuard.ts — soát cục "Quy tắc gửi ảnh" chống 3 bug: TRÙNG / THỪA / THIẾU.
 * Chạy REPLY THẬT qua runGemmaTurn (STORAGE_BACKEND=libsql → không đụng prod).
 *
 * Assert CỨNG (dựa mediaKey do gate deterministic quyết):
 *   S1 tin đầu đòi ảnh          → KHÔNG gửi (chặn tin đầu)
 *   S2 gửi gym lượt 2, xin lại lượt 3 → lượt 3 KHÔNG gửi lại (chống TRÙNG)
 *   S3 before-after biến thể    → lượt 3 KHÔNG gửi lại (guardKey gộp)
 *   S4 hỏi đáp thường           → KHÔNG gửi lượt nào
 * Assert MỀM (đọc câu chữ):
 *   - có ảnh đính → reply PHẢI có 1 câu dẫn ("gửi ... hình/ảnh")   (chống THIẾU)
 *   - không ảnh   → reply KHÔNG được bịa "em gửi ảnh/hình/video"    (chống THỪA)
 *
 * Chạy:  STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeMediaGuard.ts
 */
import "dotenv/config";
process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "libsql";

type Turn = { kh: string; expectSend: boolean; note?: string };
type Scen = { name: string; turns: Turn[] };

const SCEN: Scen[] = [
  {
    name: "S1 — Tin đầu đòi xem ảnh (chống THỪA ở tin đầu)",
    turns: [
      { kh: "cho e xin ít hình phòng gym bên mình với ạ", expectSend: false, note: "tin đầu → gate chặn" },
    ],
  },
  {
    name: "S2 — Gửi gym 1 lần rồi xin lại (chống TRÙNG)",
    turns: [
      { kh: "a muốn tập gym để tăng cơ", expectSend: false },
      { kh: "phòng gym bên em có to không, cho a xem vài hình với", expectSend: true, note: "gửi fitness-gym" },
      { kh: "cho a xem thêm vài tấm phòng tập nữa đi", expectSend: false, note: "đã gửi gym → chặn TRÙNG" },
    ],
  },
  {
    name: "S3 — Before-after biến thể (chống TRÙNG qua guardKey gộp)",
    turns: [
      { kh: "e 1m55 65kg muốn giảm cân", expectSend: false },
      { kh: "có ai giảm được thật không cho e xem hình với", expectSend: true, note: "gửi before-after" },
      { kh: "cho e xem thêm ca giảm cân khác nữa đi", expectSend: false, note: "cùng guardKey → chặn TRÙNG" },
    ],
  },
  {
    name: "S4 — Hỏi đáp thường (chống THỪA/bịa khi không ảnh)",
    turns: [
      { kh: "gym bên mình mở cửa mấy giờ ạ", expectSend: false },
      { kh: "buổi tối tầm 8h còn tập được không", expectSend: false },
    ],
  },
];

/** reply có câu kiểu "em/mình gửi ... hình/ảnh/video" không (để soát thiếu/thừa câu dẫn). */
function saysSendImg(reply: string): boolean {
  const r = reply.toLowerCase();
  const hasGui = r.includes("gửi") || r.includes("gởi");
  const hasImg = r.includes("hình") || r.includes("ảnh") || r.includes("video") || r.includes("clip");
  return hasGui && hasImg;
}

async function main() {
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  const { mastra } = await import("../index");
  let pass = 0;
  let fail = 0;
  const fails: string[] = [];

  for (const s of SCEN) {
    const tid = `smoke-mediaguard-${s.name.slice(0, 2)}-${Date.now() % 100000}`;
    console.log(`\n${"═".repeat(66)}\n▶ ${s.name}\n${"═".repeat(66)}`);
    for (const t of s.turns) {
      const r: any = await runGemmaTurn({ mastra, threadId: tid, resourceId: tid, message: t.kh });
      const keys: string[] = r?.mediaKeys?.length ? r.mediaKeys : [];
      const urls: string[] = r?.mediaUrls?.length ? r.mediaUrls : [];
      const sent = keys.length > 0 || urls.length > 0;
      const reply: string = r?.reply ?? r?.text ?? "";

      console.log(`\nKH: ${t.kh}${t.note ? `   [mong đợi: ${t.note}]` : ""}`);
      console.log(`BOT: ${reply}`);
      console.log(`   📎 gửi ảnh? ${sent ? "CÓ (" + (keys.join(",") || urls.length + " url") + ")" : "không"}`);

      // ── assert CỨNG: có gửi đúng kỳ vọng gate? (cũng bắt luôn gửi >1 ảnh trùng trong 1 lượt)
      if (sent === t.expectSend) {
        pass++;
        console.log(`   ✓ gate: ${t.expectSend ? "gửi" : "không gửi"} — đúng`);
      } else {
        fail++;
        const m = `[${s.name}] "${t.kh}" — gate SAI: kỳ vọng ${t.expectSend ? "GỬI" : "KHÔNG"}, thực tế ${sent ? "GỬI" : "KHÔNG"}`;
        fails.push(m);
        console.log(`   ✗ ${m}`);
      }
      if (sent && (keys.length > 1 || urls.length > 1)) {
        fail++;
        const m = `[${s.name}] "${t.kh}" — gửi ${keys.length || urls.length} ảnh trong 1 lượt (nghi TRÙNG/THỪA)`;
        fails.push(m);
        console.log(`   ✗ ${m}`);
      }

      // ── assert MỀM: câu dẫn khớp trạng thái ảnh
      const says = saysSendImg(reply);
      if (t.expectSend && !says) {
        fail++;
        const m = `[${s.name}] "${t.kh}" — CÓ ảnh nhưng reply THIẾU câu dẫn gửi ảnh`;
        fails.push(m);
        console.log(`   ✗ ${m}`);
      } else if (!t.expectSend && says) {
        fail++;
        const m = `[${s.name}] "${t.kh}" — KHÔNG ảnh nhưng reply BỊA "gửi hình/ảnh"`;
        fails.push(m);
        console.log(`   ✗ ${m}`);
      } else {
        pass++;
        console.log(`   ✓ câu dẫn: ${t.expectSend ? "có ảnh + có dẫn" : "không ảnh + không bịa"} — đúng`);
      }
    }
  }

  console.log(`\n${"═".repeat(66)}`);
  console.log(`KẾT QUẢ: ${pass} pass, ${fail} fail`);
  if (fails.length) {
    console.log("LỖI:");
    fails.forEach((f) => console.log("  - " + f));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

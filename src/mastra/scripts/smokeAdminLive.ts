/**
 * smokeAdminLive.ts — CHỨNG MINH: sửa trên web admin (bảng giá / cục prompt / khuyến mãi / tài
 * liệu RAG) thì CHATBOT THỰC SỰ ĐỔI. Chạy qua ĐÚNG đường store mà handler API admin gọi
 * (setPrices/setBlock/savePromo/ingestDoc), rồi gọi runGemmaTurn (LLM THẬT) đọc DB → đọc reply.
 *
 * Chạy: STORAGE_BACKEND=libsql npx -y tsx src/mastra/scripts/smokeAdminLive.ts
 *   - STORAGE_BACKEND=libsql: memory hội thoại KHÔNG đụng Supabase (chỉ knowledge/docs mới đọc PG thật).
 *   - MỌI thay đổi đều được REVERT ngay + verify baseline ở cuối (dấu [SMOKE] để quét dọn sót).
 */
import "dotenv/config";

import {
  setBlock,
  setPrices,
  resetKey,
  savePromo,
  deletePromo,
  listPromos,
  loadKnowledge,
  adminSnapshot,
} from "../lib/knowledgeStore";
import { ingestDoc, retrieveDocs, deleteDoc, listDocs } from "../lib/docStore";
import { DEFAULT_PRICE_DATA } from "../engine/gemma/pricing";

const MARK = "[SMOKE]";
let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const has = (s: string, ...alts: string[]) => alts.some((a) => s.toLowerCase().includes(a.toLowerCase()));

async function main() {
  const ONLY = (process.argv[2] || "").toLowerCase(); // "" = chạy hết; "promo"/"price"/... = 1 phần
  const run = (tag: string) => !ONLY || ONLY === tag;
  const { mastra } = await import("../index");
  const { runGemmaTurn } = await import("../engine/gemmaBrain");
  let tid = 0;
  const ask = async (msg: string): Promise<string> => {
    const threadId = `smoke-admin-${Date.now()}-${tid++}`;
    const out = await runGemmaTurn({ mastra, message: msg, threadId, resourceId: threadId });
    const reply = out?.reply ?? "";
    console.log(`   KH: ${msg}\n   BOT: ${reply}\n`);
    return reply;
  };

  // ══════════════════════════════════════════════════════════════
  // 1) BẢNG GIÁ (Các gói dịch vụ) — đổi giá gym 12 tháng 4.5tr → 9.9tr
  // ══════════════════════════════════════════════════════════════
  if (run("price")) {
  console.log("\n═══ 1. BẢNG GIÁ: gym 12 tháng 4.5tr → 9.9tr ═══");
  const Q_PRICE = "Cho em hỏi thẻ tập gym gói 12 tháng giá bao nhiêu ạ";
  const base1 = await ask(Q_PRICE);
  ok("baseline quote giá gym mặc định 4.5 triệu", has(base1, "4.5 triệu"), `| reply: ${base1}`);
  try {
    const custom = JSON.parse(JSON.stringify(DEFAULT_PRICE_DATA));
    custom.cards.GYM.moc[3] = ["12 tháng", "9.9 triệu"]; // chỉ đổi mốc 12 tháng
    await setPrices(custom);
    const edit1 = await ask(Q_PRICE);
    ok("sau sửa admin: bot quote 9.9 triệu", has(edit1, "9.9 triệu"), `| reply: ${edit1}`);
    ok("giá cũ 4.5 triệu KHÔNG còn", !has(edit1, "4.5 triệu"), `| reply: ${edit1}`);
  } finally {
    await resetKey("prices");
  }
  }

  // ══════════════════════════════════════════════════════════════
  // 2) CHÍNH SÁCH SALES — trả góp: mặc định KHÔNG → sửa thành CÓ
  // ══════════════════════════════════════════════════════════════
  if (run("policy")) {
  console.log("\n═══ 2. CHÍNH SÁCH: trả góp KHÔNG → CÓ (override cục f_thongtin) ═══");
  const Q_POLICY = "Bên mình có hỗ trợ trả góp không ạ";
  const base2 = await ask(Q_POLICY);
  ok("baseline: nói KHÔNG trả góp", has(base2, "không", "chưa") && has(base2, "trả góp", "góp", "một lần", "gọn"), `| reply: ${base2}`);
  try {
    const snap = await adminSnapshot();
    const fThongTin = snap.blocks.find((b) => b.key === "f_thongtin")!.value;
    // thay ĐÚNG dòng "- Thanh toán:" (thao tác chuỗi thuần) → bật hỗ trợ trả góp
    const start = fThongTin.indexOf("- Thanh toán:");
    if (start < 0) throw new Error("không tìm thấy dòng '- Thanh toán:' trong f_thongtin mặc định");
    const end = fThongTin.indexOf("\n", start);
    const newLine = "- Thanh toán: chuyển khoản/quẹt thẻ. CÓ HỖ TRỢ TRẢ GÓP 0% kỳ hạn 3-6 tháng qua thẻ tín dụng — khách hỏi trả góp thì xác nhận CÓ và mời đăng ký.";
    const edited = fThongTin.slice(0, start) + newLine + (end < 0 ? "" : fThongTin.slice(end));
    await setBlock("f_thongtin", edited);
    const edit2 = await ask(Q_POLICY);
    ok("sau sửa admin: bot xác nhận CÓ trả góp", has(edit2, "có trả góp", "hỗ trợ trả góp", "trả góp 0", "góp 0%", "được trả góp", "có hỗ trợ"), `| reply: ${edit2}`);
  } finally {
    await resetKey("f_thongtin");
  }
  }

  // ══════════════════════════════════════════════════════════════
  // 3) PHONG CÁCH TRẢ LỜI — thêm chữ ký cuối tin vào cục voice
  // ══════════════════════════════════════════════════════════════
  if (run("style")) {
  console.log("\n═══ 3. PHONG CÁCH: thêm chữ ký cố định cuối mỗi tin (override voice) ═══");
  const SIG = "Chúc anh chị ngày mới tràn đầy năng lượng";
  const Q_STYLE = "Bên mình địa chỉ ở đâu ạ";
  const base3 = await ask(Q_STYLE);
  ok("baseline: KHÔNG có chữ ký lạ", !has(base3, SIG), `| reply: ${base3}`);
  try {
    const snap = await adminSnapshot();
    const voice = snap.blocks.find((b) => b.key === "voice")!.value;
    await setBlock("voice", voice + `\n- CHỮ KÝ BẮT BUỘC: LUÔN kết thúc MỌI tin bằng đúng câu này ở dòng cuối: "${SIG}!"`);
    const edit3 = await ask(Q_STYLE);
    ok("sau sửa admin: bot gắn chữ ký mới", has(edit3, SIG), `| reply: ${edit3}`);
  } finally {
    await resetKey("voice");
  }
  }

  // ══════════════════════════════════════════════════════════════
  // 4) KHUYẾN MÃI THEO ĐỢT — thêm 1 đợt đang chạy → bot nêu được
  // ══════════════════════════════════════════════════════════════
  if (run("promo")) {
  console.log("\n═══ 4. KHUYẾN MÃI: thêm đợt đang chạy (promotions) ═══");
  const Q_PROMO = "Bên em đang có chương trình khuyến mãi gì không ạ";
  const base4 = await ask(Q_PROMO);
  ok("baseline: KHÔNG bịa đợt KM cụ thể 'Khai Xuân'", !has(base4, "khai xuân"), `| reply: ${base4}`);
  let promoId: number | null = null;
  try {
    promoId = await savePromo({
      title: `${MARK} Ưu đãi Khai Xuân`,
      content: "đăng ký bất kỳ gói nào trong tháng này được TẶNG NGAY 1 balo thể thao Fami",
      start_date: null,
      end_date: null,
      active: true,
    });
    const edit4 = await ask(Q_PROMO);
    ok("sau sửa admin: bot nêu ưu đãi mới (balo thể thao Fami)", has(edit4, "balo"), `| reply: ${edit4}`);
  } finally {
    if (promoId) await deletePromo(promoId);
  }
  }

  // ══════════════════════════════════════════════════════════════
  // 5) TÀI LIỆU RAG — nạp 4 mảng kiến thức (fitness / tăng-giảm-cân / dinh-dưỡng / trị-liệu)
  //    Fact HƯ CẤU + token đặc trưng → chứng minh embed→pgvector→retrieve ĐÚNG từng mảng.
  // ══════════════════════════════════════════════════════════════
  if (run("docs")) {
  console.log("\n═══ 5. TÀI LIỆU RAG: nạp 4 mảng kiến thức + retrieve ═══");
  const DOCS = [
    { cat: "fitness", token: "SaltRoom Fami", q: "Bên mình có phòng xông hơi đá muối Himalaya không ạ",
      text: "Fami có phòng xông hơi đá muối Himalaya tên SaltRoom Fami, miễn phí cho hội viên gói Full, mở 6h-20h30." },
    { cat: "tang-giam-can", token: "Detox 30 Fami", q: "Có chương trình detox giảm cân 30 ngày không ạ",
      text: "Chương trình giảm cân Detox 30 Fami cam kết giảm 4-6kg trong 30 ngày, phí trọn gói 1.2 triệu, kèm chuyên gia theo sát." },
    { cat: "dinh-duong", token: "FitMeal Fami", q: "Bên mình có bán combo thực đơn ăn kiêng eat clean không ạ",
      text: "Fami có bán combo thực đơn eat-clean tên FitMeal Fami, giá 350 nghìn một tuần, giao tận nơi, do chuyên gia dinh dưỡng thiết kế." },
    { cat: "tri-lieu", token: "HotStone Sen", q: "Bên mình có liệu trình đá nóng Bali không ạ",
      text: "TT Hoa Sen có liệu trình trị liệu đá nóng Bali tên HotStone Sen, thời lượng 90 phút, giá 550 nghìn một buổi." },
  ];
  const docIds: number[] = [];
  try {
    for (const d of DOCS) {
      const r = await ingestDoc({ title: `${MARK} ${d.cat} ${d.token}`, category: d.cat, text: d.text });
      docIds.push(r.id);
      console.log(`   nạp doc [${d.cat}] id=${r.id} chunks=${r.chunks}`);
    }
    // 5a. retrieve đúng từng mảng (deterministic — không phụ thuộc LLM)
    for (const d of DOCS) {
      const block = await retrieveDocs(d.q);
      ok(`retrieve [${d.cat}] trả đúng đoạn "${d.token}"`, block.includes(d.token), `| block: ${block.slice(0, 160)}…`);
    }
    // 5b. end-to-end: bot dùng tài liệu dinh dưỡng (fact bot KHÔNG THỂ tự biết)
    console.log("\n   ── 5b. end-to-end: bot trả lời DỰA trên tài liệu đã nạp ──");
    const eDoc = DOCS[2]; // FitMeal Fami
    const edit5 = await ask(eDoc.q);
    ok("bot nêu được thông tin từ tài liệu (FitMeal / 350 nghìn)", has(edit5, "fitmeal", "350 nghìn", "350k"), `| reply: ${edit5}`);
  } finally {
    for (const id of docIds) await deleteDoc(id).catch(() => {});
  }
  }

  // ══════════════════════════════════════════════════════════════
  // 6) VERIFY BASELINE ĐÃ KHÔI PHỤC (quét dọn mọi sót [SMOKE])
  // ══════════════════════════════════════════════════════════════
  console.log("\n═══ 6. VERIFY baseline khôi phục ═══");
  // dọn sót phòng khi 1 nhánh throw giữa chừng
  for (const p of await listPromos()) if (p.title.startsWith(MARK)) await deletePromo(p.id).catch(() => {});
  for (const d of await listDocs()) if (d.title.startsWith(MARK)) await deleteDoc(d.id).catch(() => {});
  const k = await loadKnowledge();
  ok("blocks override = rỗng (đã reset)", Object.keys(k.blocks).length === 0, `| còn: ${Object.keys(k.blocks).join(",")}`);
  ok("giá gym 12 tháng về default 4.5 triệu", k.prices.cards.GYM.moc[3][1] === DEFAULT_PRICE_DATA.cards.GYM.moc[3][1], `| còn: ${k.prices.cards.GYM.moc[3][1]}`);
  ok("promos rỗng (không sót đợt [SMOKE])", k.promos === "" || !k.promos.includes(MARK), `| promos: ${k.promos.slice(0, 80)}`);
  const leftoverDocs = (await listDocs()).filter((d) => d.title.startsWith(MARK));
  ok("không sót tài liệu [SMOKE]", leftoverDocs.length === 0, `| sót: ${leftoverDocs.map((d) => d.id).join(",")}`);

  console.log(`\n${"═".repeat(60)}\nKẾT QUẢ: ${pass} pass, ${fail} fail\n${"═".repeat(60)}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

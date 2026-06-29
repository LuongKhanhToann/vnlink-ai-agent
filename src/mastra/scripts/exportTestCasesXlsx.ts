/**
 * exportTestCasesXlsx.ts — Xuất GROUNDTRUTH kịch bản test ra 1 file Excel.
 *
 * Đây là KỊCH BẢN CHUẨN (không chạy bot): mỗi luồng trình bày dạng HỘI THOẠI ĐẦY ĐỦ
 * — Khách gửi ↔ kỳ vọng hành vi bot — kèm ẢNH THẬT (nhúng trực tiếp từ Cloudinary;
 * ảnh nào không nhúng được thì vẫn có link để fallback).
 *
 * Không phụ thuộc lib ngoài: tự ghép OOXML (.xlsx = zip các phần XML + ảnh) bằng ZIP
 * writer store-mode + DrawingML thuần Node. Mở được bằng Excel/Numbers/Google Sheets.
 *
 * Chạy:  npx tsx src/mastra/scripts/exportTestCasesXlsx.ts
 * Ra:    src/mastra/scripts/test-cases.xlsx  (3 sheet: Tổng quan · Luồng chi tiết · Link ảnh)
 *
 * Regen mỗi khi sửa scenarios.ts để Excel luôn khớp single-source-of-truth.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios";
import { listMediaByKey, KEY_TO_FOLDER } from "../tools/media";

// ─────────────────────────────────────────────────────────────────────────────
// XML helpers
// ─────────────────────────────────────────────────────────────────────────────
function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cell(col: number, row: number, text: string): string {
  return (
    `<c r="${colLetter(col)}${row}" t="inlineStr">` +
    `<is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`
  );
}

interface SheetOpts {
  rowHeights?: Map<number, number>; // index 0-based → chiều cao (pt)
  drawingRelId?: string;
}

function sheetXml(rows: string[][], widths: number[], opts: SheetOpts = {}): string {
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}"/>`)
    .join("");
  const body = rows
    .map((r, ri) => {
      const cells = r.map((t, ci) => cell(ci + 1, ri + 1, t)).join("");
      const ht = opts.rowHeights?.get(ri);
      const attr = ht ? ` ht="${ht}" customHeight="1"` : "";
      return `<row r="${ri + 1}"${attr}>${cells}</row>`;
    })
    .join("");
  const drawing = opts.drawingRelId ? `<drawing r:id="${opts.drawingRelId}"/>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<cols>${cols}</cols>` +
    `<sheetData>${body}</sheetData>` +
    drawing +
    `</worksheet>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Đọc kích thước ảnh (PNG / JPEG) để giữ tỉ lệ khi nhúng
// ─────────────────────────────────────────────────────────────────────────────
function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
function imageSize(buf: Buffer, ext: string): { w: number; h: number } | null {
  if (ext === "png") return pngSize(buf);
  if (ext === "jpg" || ext === "jpeg") return jpegSize(buf);
  return null;
}
/** Scale về hộp tối đa 240×150px, KHÔNG phóng to ảnh nhỏ. */
function fitBox(w: number, h: number): { w: number; h: number } {
  const s = Math.min(240 / w, 150 / h, 1);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
const EMU = (px: number) => Math.round(px * 9525);

// ─────────────────────────────────────────────────────────────────────────────
// ZIP writer (store mode)
// ─────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
interface ZipEntry { name: string; data: Buffer }
function zipStore(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, e.data);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Map mỗi điểm 🖼 → media key (suy từ chữ trong `expect`). Đây là TOOLING hiển thị,
// KHÔNG phải quyết định nghiệp vụ của bot → đối chiếu chuỗi ở đây hợp lệ.
// ─────────────────────────────────────────────────────────────────────────────
const hasImg = (expect: string) => expect.includes("🖼");
const stripLeadEmoji = (s: string) => s.replace(/^[^\p{L}\d]*/u, ""); // bỏ emoji/ký hiệu đầu chuỗi
function mediaKeyFor(expect: string): string | null {
  if (!hasImg(expect)) return null;
  const e = expect.toLowerCase();
  if (e.includes("mr-neck-shoulder")) return "mr-neck-shoulder";
  if (e.includes("mr-sport")) return "mr-sport";
  if (e.includes("phòng yoga")) return "fitness-yoga";
  if (e.includes("phòng gym") || e.includes("ảnh phòng gym")) return "fitness-gym";
  if (e.includes("bể")) return "fitness-pool";
  if (e.includes("tăng cân")) return "fitness-before-after-gain";
  if (e.includes("giảm cân")) return "fitness-before-after-loss";
  if (e.includes("before-after")) return "fitness-before-after-gain";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch link + ảnh THẬT từ Cloudinary cho từng key dùng trong kịch bản (1 lần/key)
// ─────────────────────────────────────────────────────────────────────────────
const keysUsed: string[] = [];
for (const s of SCENARIOS)
  for (const t of s.turns) {
    const k = mediaKeyFor(t.expect);
    if (k && !keysUsed.includes(k)) keysUsed.push(k);
    if (hasImg(t.expect) && !k)
      console.warn(`⚠ [${s.id}] điểm 🖼 không map được key: "${t.expect.slice(0, 60)}…"`);
  }

type Embed = { partName: string; rId: string; data: Buffer; w: number; h: number };
const linksByKey: Record<string, string[]> = {};
const embedByKey: Record<string, Embed> = {};
let mediaSeq = 0;

for (const k of keysUsed) {
  let items: { type: "image" | "video"; url: string }[] = [];
  try {
    items = await listMediaByKey(k);
  } catch {
    items = [];
  }
  linksByKey[k] = items.map((it) => `${it.type === "video" ? "🎬" : "🖼"} ${it.url}`);

  // Nhúng ảnh thật: lấy ảnh ĐẦU TIÊN (loại image) của key, tải bytes + đọc kích thước.
  const firstImg = items.find((it) => it.type === "image");
  if (firstImg) {
    const ext = (firstImg.url.split("?")[0].split(".").pop() ?? "").toLowerCase();
    if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      try {
        // Nhúng bản RESIZE (Cloudinary transform) cho nhẹ file; link cột vẫn giữ full-res.
        const thumb = firstImg.url.replace("/upload/", "/upload/w_480,c_limit,q_auto/");
        const buf = Buffer.from(await (await fetch(thumb)).arrayBuffer());
        const sz = imageSize(buf, ext);
        if (sz) {
          const box = fitBox(sz.w, sz.h);
          mediaSeq += 1;
          embedByKey[k] = {
            partName: `xl/media/image${mediaSeq}.${ext}`,
            rId: `rId${mediaSeq}`,
            data: buf,
            w: box.w,
            h: box.h,
          };
        }
      } catch {
        /* tải lỗi → bỏ nhúng, vẫn còn link fallback */
      }
    }
  }
}

const keyLinkText = (k: string | null): string => {
  if (!k) return "";
  const urls = (linksByKey[k] ?? []).map((u) => u.slice(2).trim()); // bỏ prefix 🖼/🎬
  const head = embedByKey[k] ? `${k} (ảnh nhúng →)` : k;
  return urls.length ? `${head}\n${urls.join("\n")}` : `${head}\n(chưa lấy được link)`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 1: Tổng quan (1 hàng / 1 luồng)
// ─────────────────────────────────────────────────────────────────────────────
const overview: string[][] = [
  ["ID", "Tiêu đề", "Flow", "Số lượt", "Số ảnh chủ động", "Mục tiêu luồng"],
];
for (const s of SCENARIOS) {
  const imgCount = s.turns.filter((t) => hasImg(t.expect)).length;
  overview.push([
    s.id,
    stripLeadEmoji(s.title),
    s.flow,
    String(s.turns.length),
    imgCount > 0 ? `🖼 x${imgCount}` : "—",
    s.goal,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 2: Luồng chi tiết (HỘI THOẠI đầy đủ, mỗi luồng 1 block) + ẢNH NHÚNG
// ─────────────────────────────────────────────────────────────────────────────
const flow: string[][] = [];
const rowHeights = new Map<number, number>();
const anchors: { row0: number; col0: number; key: string }[] = [];
const IMG_COL0 = 4; // cột E (0-based) để neo ảnh

for (const s of SCENARIOS) {
  flow.push([s.id, stripLeadEmoji(s.title), "", "", ""]);
  flow.push(["Mục tiêu", s.goal, "", "", ""]);
  flow.push(["Lượt", "Khách gửi (FB)", "Kỳ vọng hành vi bot", "Media key + link", "Ảnh thật"]);
  s.turns.forEach((t, i) => {
    const k = mediaKeyFor(t.expect);
    const idx0 = flow.length; // chỉ số 0-based của hàng sắp push
    flow.push([
      String(i + 1),
      t.msg,
      t.expect,
      keyLinkText(k),
      "",
    ]);
    if (k && embedByKey[k]) {
      anchors.push({ row0: idx0, col0: IMG_COL0, key: k });
      rowHeights.set(idx0, Math.round(embedByKey[k].h * 0.75) + 8);
    }
  });
  flow.push(["", "", "", "", ""]); // ngăn cách giữa các luồng
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet 3: Link ảnh (1 hàng / 1 URL) — danh mục link chuẩn theo key
// ─────────────────────────────────────────────────────────────────────────────
const links: string[][] = [["Media key", "Folder Cloudinary", "Loại", "Nhúng?", "Link (secure_url)"]];
for (const k of keysUsed) {
  const folder = KEY_TO_FOLDER[k] ?? "(?)";
  const items = linksByKey[k] ?? [];
  if (!items.length) {
    links.push([k, folder, "—", "—", "(chưa lấy được link — kiểm tra CLOUDINARY env/mạng)"]);
    continue;
  }
  items.forEach((line, idx) => {
    const isVid = line.startsWith("🎬");
    const embedded = !isVid && idx === items.findIndex((l) => l.startsWith("🖼")) && !!embedByKey[k];
    links.push([k, folder, isVid ? "video" : "ảnh", embedded ? "✓ (sheet 2)" : "", line.slice(2).trim()]);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DrawingML cho sheet 2 (ảnh nhúng)
// ─────────────────────────────────────────────────────────────────────────────
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const anchorXml = anchors
  .map((a, i) => {
    const emb = embedByKey[a.key];
    const id = 1000 + i;
    return (
      `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>${a.col0}</xdr:col><xdr:colOff>0</xdr:colOff>` +
      `<xdr:row>${a.row0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${EMU(emb.w)}" cy="${EMU(emb.h)}"/>` +
      `<xdr:pic>` +
      `<xdr:nvPicPr><xdr:cNvPr id="${id}" name="img${id}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip xmlns:r="${R_NS}" r:embed="${emb.rId}"/>` +
      `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr>` +
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU(emb.w)}" cy="${EMU(emb.h)}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `</xdr:spPr>` +
      `</xdr:pic><xdr:clientData/>` +
      `</xdr:oneCellAnchor>`
    );
  })
  .join("");
const drawingXml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}">${anchorXml}</xdr:wsDr>`;

// rels của drawing → từng ảnh trong xl/media
const usedEmbeds = Object.values(embedByKey);
const drawingRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  usedEmbeds
    .map(
      (e) =>
        `<Relationship Id="${e.rId}" Type="${R_NS}/image" Target="../${e.partName.replace(/^xl\//, "")}"/>`,
    )
    .join("") +
  `</Relationships>`;

const sheet2Rels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R_NS}/drawing" Target="../drawings/drawing1.xml"/>` +
  `</Relationships>`;

// ─────────────────────────────────────────────────────────────────────────────
// Ghép workbook (3 sheet + drawing + ảnh)
// ─────────────────────────────────────────────────────────────────────────────
const sheet1 = sheetXml(overview, [12, 46, 9, 8, 14, 70]);
const sheet2 = sheetXml(flow, [10, 46, 66, 50, 36], {
  rowHeights,
  drawingRelId: anchors.length ? "rId1" : undefined,
});
const sheet3 = sheetXml(links, [24, 28, 8, 12, 78]);

const exts = new Set(usedEmbeds.map((e) => e.partName.split(".").pop()!));
const imgDefaults = [...exts]
  .map((x) => {
    const ct = x === "png" ? "image/png" : "image/jpeg";
    return `<Default Extension="${x}" ContentType="${ct}"/>`;
  })
  .join("");

const contentTypes =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  imgDefaults +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  (anchors.length
    ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
    : "") +
  `</Types>`;

const rootRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const workbook =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R_NS}">` +
  `<sheets>` +
  `<sheet name="Tổng quan" sheetId="1" r:id="rId1"/>` +
  `<sheet name="Luồng chi tiết" sheetId="2" r:id="rId2"/>` +
  `<sheet name="Link ảnh" sheetId="3" r:id="rId3"/>` +
  `</sheets></workbook>`;

const workbookRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="${R_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${R_NS}/worksheet" Target="worksheets/sheet2.xml"/>` +
  `<Relationship Id="rId3" Type="${R_NS}/worksheet" Target="worksheets/sheet3.xml"/>` +
  `</Relationships>`;

const b = (s: string) => Buffer.from(s, "utf8");
const parts: ZipEntry[] = [
  { name: "[Content_Types].xml", data: b(contentTypes) },
  { name: "_rels/.rels", data: b(rootRels) },
  { name: "xl/workbook.xml", data: b(workbook) },
  { name: "xl/_rels/workbook.xml.rels", data: b(workbookRels) },
  { name: "xl/worksheets/sheet1.xml", data: b(sheet1) },
  { name: "xl/worksheets/sheet2.xml", data: b(sheet2) },
  { name: "xl/worksheets/sheet3.xml", data: b(sheet3) },
];
if (anchors.length) {
  parts.push({ name: "xl/worksheets/_rels/sheet2.xml.rels", data: b(sheet2Rels) });
  parts.push({ name: "xl/drawings/drawing1.xml", data: b(drawingXml) });
  parts.push({ name: "xl/drawings/_rels/drawing1.xml.rels", data: b(drawingRels) });
  for (const e of usedEmbeds) parts.push({ name: e.partName, data: e.data });
}

const outPath = join(fileURLToPath(new URL(".", import.meta.url)), "test-cases.xlsx");
writeFileSync(outPath, zipStore(parts));

const totalTurns = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);
const totalLinks = keysUsed.reduce((n, k) => n + (linksByKey[k]?.length ?? 0), 0);
console.log(
  `✓ Đã ghi ${outPath}\n  ${SCENARIOS.length} luồng · ${totalTurns} lượt · ` +
    `${anchors.length} ảnh NHÚNG (${usedEmbeds.length} key) · ${totalLinks} link · ` +
    `${keysUsed.length} media key`,
);

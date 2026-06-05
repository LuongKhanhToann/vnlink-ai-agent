/**
 * sheetsWriter.ts
 * Ghi lead vào Google Sheets khi đủ: tên + SĐT + buổi.
 */

import { google } from "googleapis";
import type { ConversationState } from "./stateMachine";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SHEET_NAME = "Trang tính1";

const HEADERS = [
  "Thời gian nhắn",
  "Dịch vụ",
  "Tên",
  "Số điện thoại",
  "Thời gian đến",
  "Dịch vụ / Vùng đau",
  "Mục tiêu / Đã thử",
];

function requireSheetId(): string {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error("[sheetsWriter] GOOGLE_SHEET_ID chưa được set trong .env");
  return id;
}

async function ensureHeaders(sheets: any, spreadsheetId: string): Promise<void> {
  // Lấy nội dung A1 để kiểm tra
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
  });
  const firstCell: string = res.data.values?.[0]?.[0] ?? "";

  // Nếu A1 đã là header đúng → bỏ qua
  if (firstCell === HEADERS[0]) return;

  // Lấy sheetId thực của "Trang tính1"
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetMeta = meta.data.sheets?.find(
    (s: any) => s.properties?.title === SHEET_NAME
  );
  const sheetId: number = sheetMeta?.properties?.sheetId ?? 0;

  // Chèn 1 row trống lên đầu
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
          inheritFromBefore: false,
        },
      }],
    },
  });

  // Ghi headers vào row 1
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [HEADERS] },
  });

  console.log("[sheetsWriter] ✓ Headers đã được tạo");
}

export function isLeadComplete(state: ConversationState): boolean {
  const { knownInfo } = state;
  return !!(knownInfo.name && knownInfo.phone && knownInfo.preferredTime);
}

// Khởi tạo Sheets client từ service account (dùng chung cho write + update).
function getSheetsClient(): { sheets: any; spreadsheetId: string } {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error("[sheetsWriter] GOOGLE_SERVICE_ACCOUNT_JSON chưa được set");
  const credentials = JSON.parse(
    saJson.startsWith("{") ? saJson : Buffer.from(saJson, "base64").toString("utf8"),
  );
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  const sheets = google.sheets({ version: "v4", auth });
  return { sheets, spreadsheetId: requireSheetId() };
}

// Build 1 row A:G từ state (đồng nhất giữa append & update).
function buildLeadRow(state: ConversationState): any[] {
  const { knownInfo, flow } = state;
  const serviceOrArea =
    flow === "fitness" ? knownInfo.serviceType ?? "" : knownInfo.painArea ?? "";
  const goalOrMethod =
    flow === "fitness" ? knownInfo.fitnessGoal ?? "" : knownInfo.pastMethod ?? "";
  const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  return [
    now,
    flow === "fitness" ? "Fitness" : "Giải cơ",
    knownInfo.name,
    knownInfo.phone,
    knownInfo.preferredTime ?? "",
    serviceOrArea,
    goalOrMethod,
  ];
}

const normPhone = (s: any): string => String(s ?? "").replace(/[\s.\-()]/g, "").trim();
const normCell = (s: any): string => String(s ?? "").trim().toLowerCase();

export async function writeLeadToSheets(state: ConversationState): Promise<void> {
  const { knownInfo, flow } = state;
  const row = buildLeadRow(state);
  const { sheets, spreadsheetId } = getSheetsClient();

  await ensureHeaders(sheets, spreadsheetId);
  await appendIntoTable(sheets, spreadsheetId, row);

  console.log(`[sheetsWriter] ✓ ${knownInfo.name} — ${knownInfo.phone} — ${knownInfo.preferredTime} — ${flow}`);
}

/**
 * ĐỔI LỊCH (reschedule): tìm dòng đơn cũ theo (Tên + SĐT + Thời gian đến CŨ) và CẬP NHẬT
 * tại chỗ — thay vì thêm dòng mới (tránh trùng đơn khi khách chỉ dời giờ).
 * Match dòng GẦN NHẤT (cuối cùng) khớp. Trả về true nếu update được, false nếu không tìm thấy
 * (caller sẽ fallback sang append).
 */
export async function updateLeadRow(
  state: ConversationState,
  oldTime: string,
): Promise<boolean> {
  const { knownInfo } = state;
  if (!knownInfo.name || !knownInfo.phone || !oldTime) return false;

  const { sheets, spreadsheetId } = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:G`,
  });
  const rows: any[][] = resp.data.values ?? [];

  // Cột: C(2)=Tên, D(3)=SĐT, E(4)=Thời gian đến. Tìm dòng cuối cùng khớp.
  let target = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (
      normCell(r[2]) === normCell(knownInfo.name) &&
      normPhone(r[3]) === normPhone(knownInfo.phone) &&
      normCell(r[4]) === normCell(oldTime)
    ) {
      target = i;
    }
  }
  if (target < 0) return false;

  const rowNum = target + 1; // values bắt đầu từ A1 → index 0 = dòng 1
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A${rowNum}:G${rowNum}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [buildLeadRow(state)] },
  });
  console.log(
    `[sheetsWriter] ✎ UPDATE dòng ${rowNum}: ${knownInfo.name} đổi "${oldTime}" → "${knownInfo.preferredTime}"`,
  );
  return true;
}

/**
 * Append row vào trong formal Table (vd "Bảng_1") — không bị rơi ra ngoài range.
 *
 * `values.append` mặc định ghi vào row trống đầu tiên SAU table data. Nếu sheet
 * có Google Sheets Table object (feature mới: tạo từ menu Chèn > Bảng), boundary
 * của table không tự extend → row mới nằm ngoài, mất formatting/dropdown.
 *
 * Cách xử lý: detect table trên sheet, extend range +1 row, rồi ghi vào row mới
 * (giờ nằm trong table extended). Fallback về standard append nếu sheet không
 * có Table.
 */
async function appendIntoTable(
  sheets: any,
  spreadsheetId: string,
  row: any[],
): Promise<void> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title),tables)",
  });
  const sheet = meta.data.sheets?.find(
    (s: any) => s.properties?.title === SHEET_NAME,
  );
  const tables: any[] = sheet?.tables ?? [];

  // Pick table mà cột A nằm trong range (assume single table cho leads sheet).
  const leadTable = tables.find((t: any) => {
    const r = t.range ?? {};
    return (r.startColumnIndex ?? 0) === 0;
  }) ?? tables[0];

  if (!leadTable?.tableId || !leadTable?.range) {
    // Không có Table → standard append
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    return;
  }

  // Extend table boundary +1 row trước khi ghi.
  // GridRange.endRowIndex là exclusive 0-indexed → cũng chính là số dòng 1-indexed của row mới.
  const oldEnd: number = leadTable.range.endRowIndex ?? 0;
  const newEnd = oldEnd + 1;
  const writeRow = newEnd; // 1-indexed row number

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateTable: {
            table: {
              tableId: leadTable.tableId,
              range: { ...leadTable.range, endRowIndex: newEnd },
            },
            fields: "range",
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A${writeRow}:G${writeRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

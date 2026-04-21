/**
 * sheetsWriter.ts
 * Ghi lead vào Google Sheets khi đủ: tên + SĐT + buổi.
 */

import { google } from "googleapis";
import type { ConversationState } from "./stateMachine";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SHEET_NAME = "Trang tính1";

const HEADERS = [
  "Thời gian",
  "Dịch vụ",
  "Tên",
  "Số điện thoại",
  "Buổi",
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

export async function writeLeadToSheets(state: ConversationState): Promise<void> {
  const { knownInfo, flow } = state;

  const serviceOrArea =
    flow === "fitness"
      ? (knownInfo.serviceType ?? "")
      : (knownInfo.painArea ?? "");

  const goalOrMethod =
    flow === "fitness"
      ? (knownInfo.fitnessGoal ?? "")
      : (knownInfo.pastMethod ?? "");

  const now = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

  const row = [
    now,
    flow === "fitness" ? "Fitness" : "Giải cơ",
    knownInfo.name,
    knownInfo.phone,
    knownInfo.preferredTime ?? "",
    serviceOrArea,
    goalOrMethod,
  ];

  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saJson) throw new Error("[sheetsWriter] GOOGLE_SERVICE_ACCOUNT_JSON chưa được set");
  const credentials = JSON.parse(
    saJson.startsWith("{") ? saJson : Buffer.from(saJson, "base64").toString("utf8")
  );

  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = requireSheetId();

  await ensureHeaders(sheets, spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_NAME}!A:G`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });

  console.log(`[sheetsWriter] ✓ ${knownInfo.name} — ${knownInfo.phone} — ${knownInfo.preferredTime} — ${flow}`);
}

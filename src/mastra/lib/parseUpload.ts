/**
 * parseUpload.ts — trích TEXT THUẦN từ file khách upload (PDF / Word / text) cho RAG.
 *
 * Chỉ chạy lúc admin nạp tài liệu (không phải hot path chat) nên cho phép nặng.
 * Import động pdf-parse / mammoth để không kéo vào lúc khởi động server.
 */

export interface ParsedDoc {
  text: string;
  /** loại nhận diện được, để log/hiển thị. */
  kind: "pdf" | "docx" | "text";
}

const EXT = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/**
 * Đọc file → text. Nhận buffer + tên/mimetype để đoán loại. Ném lỗi nếu định dạng
 * không hỗ trợ hoặc không trích được chữ (vd PDF scan ảnh, không có text layer).
 */
export async function parseUpload(buf: Buffer, filename: string, mime = ""): Promise<ParsedDoc> {
  const ext = EXT(filename);
  const isPdf = ext === "pdf" || mime.includes("pdf");
  const isDocx =
    ext === "docx" ||
    mime.includes("officedocument.wordprocessingml") ||
    mime.includes("msword");
  const isText = ext === "txt" || ext === "md" || ext === "markdown" || mime.startsWith("text/");

  if (isPdf) {
    const pdf = (await import("pdf-parse")).default as (b: Buffer) => Promise<{ text: string }>;
    const { text } = await pdf(buf);
    const clean = (text ?? "").trim();
    if (!clean) throw new Error("PDF không có lớp chữ (có thể là bản scan ảnh) — hãy dán nội dung dạng text.");
    return { text: clean, kind: "pdf" };
  }
  if (isDocx) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    const clean = (value ?? "").trim();
    if (!clean) throw new Error("File Word không đọc được nội dung chữ.");
    return { text: clean, kind: "docx" };
  }
  if (isText) {
    const clean = buf.toString("utf8").trim();
    if (!clean) throw new Error("File rỗng.");
    return { text: clean, kind: "text" };
  }
  throw new Error(`Định dạng không hỗ trợ (${ext || mime || "?"}). Chỉ nhận PDF, Word (.docx), hoặc text/.md.`);
}

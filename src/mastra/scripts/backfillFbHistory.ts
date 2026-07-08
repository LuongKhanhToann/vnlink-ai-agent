/**
 * backfillFbHistory.ts — nạp LỊCH SỬ CHAT cũ trên page Facebook vào bộ nhớ bot.
 *
 * Vì sao cần: khi chuyển bot sang 1 page đã có khách chat từ trước (nhân viên trả tay),
 * bot chưa hề có memory của họ (memory key theo PSID/page). Khách cũ nhắn lại sẽ bị coi
 * như mới → hỏi lại từ đầu. Script kéo lịch sử qua Conversations API rồi lưu vào đúng cơ
 * chế memory (saveThread + saveMessages, threadId=resourceId=PSID) như route facebook.ts,
 * để semanticRecall + lastMessages có context ngay từ lượt đầu.
 *
 * KHÔNG populate working-memory template (bản tóm tắt hồ sơ) — cái đó agent tự dựng ở lượt
 * chat kế tiếp. Ở đây chỉ nạp transcript thô để bot "nhớ đã từng nói gì".
 *
 * Chạy (đọc Supabase prod từ .env — KHÔNG set STORAGE_BACKEND):
 *   DRY_RUN=1 npx -y tsx src/mastra/scripts/backfillFbHistory.ts   # chỉ đếm, không ghi
 *   npx -y tsx src/mastra/scripts/backfillFbHistory.ts             # ghi thật
 *   FORCE=1 ...                                                    # ghi cả thread đã có
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { memory } from "../config/memory";

const GRAPH = "https://graph.facebook.com/v25.0";
const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const DRY = process.env.DRY_RUN === "1";
const FORCE = process.env.FORCE === "1";

if (!TOKEN) {
  console.error("Thiếu FB_PAGE_ACCESS_TOKEN trong .env");
  process.exit(1);
}

type FbMsg = { id: string; message?: string; from?: { id: string; name?: string }; created_time: string };

async function gget(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.type}: ${json.error.message}`);
  return json;
}

/** page id để phân biệt tin của page (assistant) vs khách (user) */
async function getPageId(): Promise<string> {
  const me = await gget(`${GRAPH}/me?fields=id,name&access_token=${TOKEN}`);
  console.log(`[backfill] page: ${me.name} (${me.id})`);
  return me.id as string;
}

/** lấy TẤT CẢ message của 1 conversation (phân trang) theo thứ tự thời gian tăng dần */
async function fetchAllMessages(convId: string): Promise<FbMsg[]> {
  const out: FbMsg[] = [];
  let url = `${GRAPH}/${convId}/messages?fields=message,from,created_time&limit=100&access_token=${TOKEN}`;
  while (url) {
    const page = await gget(url);
    out.push(...(page.data ?? []));
    url = page.paging?.next ?? "";
  }
  out.sort((a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime());
  return out;
}

async function main() {
  const pageId = await getPageId();
  console.log(`[backfill] mode: ${DRY ? "DRY-RUN (không ghi)" : "GHI THẬT"}${FORCE ? " +FORCE" : ""}`);

  let convCount = 0, userThreads = 0, skipped = 0, savedMsgs = 0, emptyMsgs = 0;

  // duyệt toàn bộ conversations (phân trang)
  let url = `${GRAPH}/${pageId}/conversations?fields=id&limit=50&access_token=${TOKEN}`;
  while (url) {
    const page = await gget(url);
    for (const conv of page.data ?? []) {
      convCount++;
      const msgs = await fetchAllMessages(conv.id);
      if (!msgs.length) continue;

      // PSID khách = from.id của tin KHÔNG phải page. (1 conversation 1-1 → 1 khách)
      const psid = msgs.map((m) => m.from?.id).find((id) => id && id !== pageId);
      if (!psid) { skipped++; continue; }

      // idempotent: thread đã có thì bỏ qua (trừ khi FORCE)
      const existing = await memory.getThreadById({ threadId: psid });
      if (existing && !FORCE) { skipped++; continue; }

      userThreads++;
      const rows = msgs.map((m) => {
        const text = (m.message ?? "").trim();
        if (!text) emptyMsgs++;
        return {
          id: randomUUID(),
          role: (m.from?.id === pageId ? "assistant" : "user") as "user" | "assistant",
          type: "text" as const,
          threadId: psid,
          resourceId: psid,
          createdAt: new Date(m.created_time),
          content: { format: 2 as const, parts: [{ type: "text" as const, text: text || "[đính kèm/hình ảnh]" }] },
        };
      });

      if (!DRY) {
        if (!existing) {
          await memory.saveThread({
            thread: {
              id: psid, resourceId: psid, title: "fb-chat (backfill)",
              createdAt: new Date(msgs[0].created_time),
              updatedAt: new Date(msgs[msgs.length - 1].created_time),
              metadata: { backfill: true },
            },
          });
        }
        await memory.saveMessages({ messages: rows });
      }
      savedMsgs += rows.length;
      console.log(`[backfill] conv#${convCount} psid=${psid.slice(0, 6)}… msgs=${rows.length}`);
    }
    url = page.paging?.next ?? "";
  }

  console.log("──────── TỔNG KẾT ────────");
  console.log(`conversations quét   : ${convCount}`);
  console.log(`thread khách nạp     : ${userThreads}`);
  console.log(`bỏ qua (đã có/ko psid): ${skipped}`);
  console.log(`message ${DRY ? "sẽ ghi" : "đã ghi"}    : ${savedMsgs} (rỗng/đính kèm: ${emptyMsgs})`);
  if (DRY) console.log("→ DRY-RUN: chưa ghi gì. Bỏ DRY_RUN=1 để ghi thật.");
  process.exit(0);
}

main().catch((e) => { console.error("[backfill] LỖI:", e); process.exit(1); });

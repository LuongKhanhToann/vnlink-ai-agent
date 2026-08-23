/**
 * engine/outbound.ts — L7: Chủ động nhắn trước theo hẹn giờ (CHỈ NHẮN TIN, không gọi điện).
 *
 * Ba hành vi tài liệu yêu cầu bot TỰ khởi phát (Mục III): phản hồi nhanh khi khách để lại thông tin;
 * nhắc lịch trước giờ hẹn 2-4h (S5); bám đuổi khách "đã đọc nhưng im lặng" (kịch bản silence_followup).
 *
 * Trạng thái BẬT phụ thuộc chính sách cửa sổ 24h của Facebook (xem SDD Mục 15) → mặc định
 * OUTBOUND_MODE=off ⇒ scheduleOutbound là NO-OP, không ảnh hưởng luồng inbound. Khi bật, job đi qua
 * đúng pipeline L0–L6 (regenerate lượt hệ thống) nên không có đường phát nào lách Compliance Gate.
 * Đọc trạng thái tươi mỗi lần chạy, KHÔNG cache.
 */

import { Pool } from "pg";
import "dotenv/config";
import type { StageCode } from "./taxonomy";
import type { TurnClassification } from "./classifier";

export type OutboundKind = "reminder" | "followup";

function mode(): "off" | "bot" | "human_queue" {
  const m = (process.env.OUTBOUND_MODE || "off").toLowerCase();
  return m === "bot" || m === "human_queue" ? m : "off";
}
const REMINDER_LEAD_H = Number(process.env.REMINDER_LEAD_H) || 3;
const FOLLOWUP_DELAY_H = Number(process.env.FOLLOWUP_DELAY_H) || 24;
const FOLLOWUP_MAX = Number(process.env.FOLLOWUP_MAX) || 1;

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
    pool.on("error", (e) => console.error("[outbound] pool error:", e));
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS scheduled_job (
           id         BIGSERIAL PRIMARY KEY,
           sender_id  TEXT        NOT NULL,
           kind       TEXT        NOT NULL,
           fire_at    TIMESTAMPTZ NOT NULL,
           payload    JSONB       NOT NULL DEFAULT '{}',
           status     TEXT        NOT NULL DEFAULT 'pending',
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
      )
      .then(async () => {
        await getPool().query(
          `CREATE INDEX IF NOT EXISTS scheduled_job_due ON scheduled_job(status, fire_at)`,
        );
      })
      .catch((e) => {
        console.error("[outbound] ensureSchema failed:", e);
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

/** Huỷ job pending theo kind (khách đã hồi/đã đến → tránh nhắn trùng/vô duyên). */
async function cancelPending(senderId: string, kind: OutboundKind): Promise<void> {
  await getPool().query(
    `UPDATE scheduled_job SET status='cancelled' WHERE sender_id=$1 AND kind=$2 AND status='pending'`,
    [senderId, kind],
  );
}

async function countFollowups(senderId: string): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS n FROM scheduled_job WHERE sender_id=$1 AND kind='followup' AND status IN ('sent','pending')`,
    [senderId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Sau mỗi lượt inbound: đặt/huỷ job kế tiếp. NO-OP khi OUTBOUND_MODE=off.
 * - Khách vừa nhắn ⇒ huỷ followup cũ đang chờ (họ đã hồi).
 * - S5 (đã chốt lịch) ⇒ đặt reminder trước giờ hẹn REMINDER_LEAD_H (nếu payload có appointment).
 * - Chưa chốt ⇒ đặt followup sau FOLLOWUP_DELAY_H (nếu chưa vượt FOLLOWUP_MAX).
 */
export async function scheduleOutbound(input: {
  senderId: string;
  stage: StageCode;
  cls: TurnClassification;
  appointmentAt?: Date | null;
}): Promise<void> {
  if (mode() === "off") return;
  const { senderId, stage, appointmentAt } = input;
  await ensureSchema();

  // Khách vừa nhắn trong lượt này ⇒ huỷ mọi followup đang chờ.
  await cancelPending(senderId, "followup");

  if (stage === "S5" && appointmentAt) {
    await cancelPending(senderId, "reminder");
    const fireAt = new Date(appointmentAt.getTime() - REMINDER_LEAD_H * 3_600_000);
    if (fireAt.getTime() > Date.now()) {
      await getPool().query(
        `INSERT INTO scheduled_job (sender_id, kind, fire_at, payload) VALUES ($1,'reminder',$2,$3)`,
        [senderId, fireAt.toISOString(), JSON.stringify({ stage, appointmentAt: appointmentAt.toISOString() })],
      );
    }
    return;
  }

  if (stage !== "S5" && (await countFollowups(senderId)) < FOLLOWUP_MAX) {
    const fireAt = new Date(Date.now() + FOLLOWUP_DELAY_H * 3_600_000);
    await getPool().query(
      `INSERT INTO scheduled_job (sender_id, kind, fire_at, payload) VALUES ($1,'followup',$2,$3)`,
      [senderId, fireAt.toISOString(), JSON.stringify({ stage, reason: "silence_followup" })],
    );
  }
}

export interface DueJob {
  id: number;
  senderId: string;
  kind: OutboundKind;
  payload: any;
}

/** Lấy job đến hạn (fire_at ≤ now, pending). Worker gọi định kỳ. */
export async function dueJobs(limit = 20): Promise<DueJob[]> {
  if (mode() === "off") return [];
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT id, sender_id, kind, payload FROM scheduled_job
       WHERE status='pending' AND fire_at <= NOW() ORDER BY fire_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r: any) => ({ id: Number(r.id), senderId: r.sender_id, kind: r.kind, payload: r.payload }));
}

export async function markJob(id: number, status: "sent" | "cancelled" | "skipped"): Promise<void> {
  await getPool().query(`UPDATE scheduled_job SET status=$2 WHERE id=$1`, [id, status]);
}

/** Chỉ thị lượt hệ thống cho từng loại job (đưa vào prompt thay tin khách). */
export function outboundDirective(kind: OutboundKind): string {
  if (kind === "reminder")
    return "Đây là tin NHẮC LỊCH chủ động trước giờ hẹn: xác nhận lại lịch, hướng dẫn chỗ gửi xe/trang phục, nhắn ấm áp ngắn gọn. Không hỏi lại giá.";
  return "Đây là tin BÁM ĐUỔI khách đã xem nhưng im lặng: nhắn lại nhẹ nhàng, khơi lại nhu cầu ẩn, tạo một lý do/ưu đãi để khách quay lại. Ngắn gọn, không làm phiền, không lặp y nguyên tin cũ.";
}

import { PgVector } from "@mastra/pg";
import "dotenv/config";

/**
 * vector.ts — vector store cho semantic recall.
 *
 * Dùng CHUNG Postgres (Supabase) với storage — chỉ thêm bảng vector (cần extension
 * `pgvector`: chạy `CREATE EXTENSION IF NOT EXISTS vector;` 1 lần trên DB).
 *
 * Test mode (STORAGE_BACKEND=libsql, in-memory) → không có pgvector → trả false để
 * Mastra TẮT semantic recall (xem config/memory.ts), tránh lỗi khi chạy test offline.
 *
 * Số chiều của bảng vector do Mastra tự tạo theo embedder (xem embeddings.ts) — không
 * khai báo thủ công ở đây để khỏi lệch.
 */

const useLibsql = process.env.STORAGE_BACKEND === "libsql";

export const vector = useLibsql
  ? (false as const)
  : new PgVector({
      id: "vnlink-vector",
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
    });

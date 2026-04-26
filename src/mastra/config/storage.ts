import { PostgresStore } from "@mastra/pg";
import { LibSQLStore } from "@mastra/libsql";
import "dotenv/config";

// STORAGE_BACKEND=libsql → in-memory cho local dev / test scenarios.
// Mặc định Postgres (production qua Supabase pooler).
const useLibsql = process.env.STORAGE_BACKEND === "libsql";

export const storage = useLibsql
  ? new LibSQLStore({ id: "vnlink-storage", url: ":memory:" })
  : new PostgresStore({
      id: "vnlink-storage",
      host: process.env.PG_DATABASE_HOST!,
      port: Number(process.env.PG_DATABASE_PORT!),
      user: process.env.PG_DATABASE_USER!,
      password: process.env.PG_DATABASE_PASSWORD!,
      database: process.env.PG_DATABASE_NAME!,
      ssl: { rejectUnauthorized: false },
    });

if (useLibsql) {
  console.log("[storage] using LibSQL in-memory (test mode)");
}
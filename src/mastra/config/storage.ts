import { PostgresStore } from "@mastra/pg";

export const storage = new PostgresStore({
  id: "vnlink-storage",
  host: process.env.PG_DATABASE_HOST!,
  port: Number(process.env.PG_DATABASE_PORT!),
  user: process.env.PG_DATABASE_USER!,
  password: process.env.PG_DATABASE_PASSWORD!,
  database: process.env.PG_DATABASE_NAME!,
  ssl: { rejectUnauthorized: false },
});
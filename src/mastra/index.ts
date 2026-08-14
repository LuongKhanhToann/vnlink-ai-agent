import { Mastra } from "@mastra/core/mastra";
import { ConsoleLogger } from "@mastra/core/logger";
import { storage } from "./config/storage";
import { facebookWebhook } from "./routes/facebook";
import { adminWebhook } from "./routes/admin";

// LUỒNG MỚI (nhánh rebuild-fami-rag): bộ não engine/brain.ts = RAG basic + 1 call Gemini.
// Không FSM/classifier, không semantic-recall OpenAI. Lịch sử = lib/history (bảng phẳng).
// Đã gỡ telegram route legacy. storage của Mastra vẫn giữ để tương thích build.
export const mastra = new Mastra({
  storage,
  logger: new ConsoleLogger({ name: "Vinalink", level: "info" }),
  server: {
    // Railway/hosting cấp PORT động qua env — PHẢI nghe đúng port đó, nếu không edge trả 404/502.
    // Fallback 4112 cho chạy local.
    port: Number(process.env.PORT) || 4112,
    middleware: [
      async (c, next) => {
        const url = new URL(c.req.url);

        // Serve static files từ public/
        if (url.pathname.startsWith("/public/")) {
          const { readFile } = await import("node:fs/promises");
          const { existsSync } = await import("node:fs");
          const { resolve, extname } = await import("node:path");

          const relPath = url.pathname.replace("/public/", "");
          // Mastra chạy từ /app/.mastra/output → public nằm ở src/mastra/public
          const candidates = [
            resolve(process.cwd(), relPath),
            resolve(process.cwd(), "../../src/mastra/public", relPath),
            resolve("/app/src/mastra/public", relPath),
          ];

          let filePath: string | null = null;
          for (const p of candidates) {
            if (existsSync(p)) { filePath = p; break; }
          }

          if (!filePath) {
            console.warn(`[static] 404: ${url.pathname}`);
            console.warn(`[static] tried: ${candidates.join(", ")}`);
            return next();
          }

          const MIME: Record<string, string> = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".png": "image/png",  ".webp": "image/webp",
            ".gif": "image/gif",
          };

          const ext  = extname(filePath).toLowerCase();
          const mime = MIME[ext] ?? "application/octet-stream";
          const data = await readFile(filePath);

          return new Response(data, {
            headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" },
          });
        }

        // Webadmin (Khách / Tài liệu / Ảnh) — /admin + /admin/api/*
        const adminRes = await adminWebhook.fetch(c.req.raw);
        if (adminRes.status !== 404) return adminRes;

        // Facebook webhook
        const res = await facebookWebhook.fetch(c.req.raw);
        if (res.status !== 404) return res;

        return next();
      },
    ],
  },
});
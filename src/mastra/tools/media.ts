/// <reference types="node" />

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readdirSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

const BASE_URL: string = process.env["BASE_URL"] ?? "http://localhost:4111";

// process.cwd() = .../src/mastra/public
// nên chỉ cần path tương đối từ đó.
// Mỗi key có thể map tới nhiều thư mục (VD: image/ + video/).
// Thư mục không tồn tại sẽ được bỏ qua — không gây lỗi.
const KEY_TO_DIRS: Record<string, string[]> = {
  "fitness-gym":      ["media/fitness/gym/image"],
  "fitness-pool":     ["media/fitness/pool/image"],
  "fitness-yoga":     ["media/fitness/yoga/image"],
  "mr-sport":         ["media/muscle-release/sport/image",        "media/muscle-release/sport/video"],
  "mr-neck-shoulder": ["media/muscle-release/neck-shoulder/image", "media/muscle-release/neck-shoulder/video"],
  "mr-female":        ["media/muscle-release/female/image",        "media/muscle-release/female/video"],
  "mr-general":       ["media/muscle-release/general/image",       "media/muscle-release/general/video"],
};

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi"]);

function getMediaType(filename: string): "image" | "video" | null {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

export const getMediaTool = createTool({
  id: "get-media",
  description:
    "Lấy ảnh/video giới thiệu dịch vụ để gửi cho khách. " +
    "Fitness: fitness-gym / fitness-pool / fitness-yoga. " +
    "Muscle release: mr-sport / mr-neck-shoulder / mr-female / mr-general.",
  inputSchema: z.object({
    key: z.enum([
      "fitness-gym",
      "fitness-pool",
      "fitness-yoga",
      "mr-sport",
      "mr-neck-shoulder",
      "mr-female",
      "mr-general",
    ]),
  }),
  outputSchema: z.object({
    data: z.string(),
  }),
  execute: async (input) => {
    const relDirs = KEY_TO_DIRS[input.key] ?? [];
    console.log(`[getMedia] cwd=${process.cwd()} key=${input.key}`);

    const data: { type: "image" | "video"; url: string; filename: string }[] = [];

    for (const relDir of relDirs) {
      const absDir = resolve(process.cwd(), relDir);
      if (!existsSync(absDir)) {
        console.log(`[getMedia] skip (not found): ${absDir}`);
        continue;
      }
      try {
        const files = readdirSync(absDir);
        for (const filename of files) {
          const type = getMediaType(filename);
          if (!type) continue;
          data.push({
            type,
            url: `${BASE_URL}/public/${relDir}/${encodeURIComponent(filename)}`,
            filename,
          });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[getMedia] error reading ${relDir}:`, msg);
      }
    }

    console.log(`[getMedia] key=${input.key} → ${data.length} files`);
    return { data: JSON.stringify(data) };
  },
});
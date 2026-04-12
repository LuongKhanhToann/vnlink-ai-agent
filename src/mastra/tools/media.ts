/// <reference types="node" />

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readdirSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

const BASE_URL: string = process.env["BASE_URL"] ?? "http://localhost:4111";

// process.cwd() = .../src/mastra/public
// nên chỉ cần path tương đối từ đó
const KEY_TO_DIR: Record<string, string> = {
  "fitness-gym":      "media/fitness/gym/image",
  "fitness-pool":     "media/fitness/pool/image",
  "fitness-yoga":     "media/fitness/yoga/image",
  "mr-sport":         "media/muscle-release/sport/image",
  "mr-neck-shoulder": "media/muscle-release/neck-shoulder/image",
  "mr-female":        "media/muscle-release/female/image",
  "mr-general":       "media/muscle-release/general/image",
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
    const relDir = KEY_TO_DIR[input.key];
    const absDir = resolve(process.cwd(), relDir);

    console.log(`[getMedia] cwd=${process.cwd()}`);
    console.log(`[getMedia] absDir=${absDir}`);

    if (!existsSync(absDir)) {
      console.warn(`[getMedia] directory not found: ${absDir}`);
      return { data: JSON.stringify([]) };
    }

    try {
      const files = readdirSync(absDir);

      const data = files
        .map((filename) => {
          const type = getMediaType(filename);
          if (!type) return null;
          return {
            type,
            // URL public: BASE_URL + /public/ + relDir + filename
            url: `${BASE_URL}/public/${relDir}/${filename}`,
            filename,
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      console.log(`[getMedia] key=${input.key} → ${data.length} files`);
      return { data: JSON.stringify(data) };

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[getMedia] error for key=${input.key}:`, msg);
      return { data: JSON.stringify([]) };
    }
  },
});
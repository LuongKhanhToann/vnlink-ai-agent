import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const KEY_TO_FOLDER: Record<string, string> = {
  "mr-sport":         "giaiCo",
  "mr-neck-shoulder": "giaiCo",
  "mr-female":        "giaiCo",
  "mr-general":       "giaiCo",
  "fitness-gym":      "fitness/gym",
  "fitness-yoga":     "fitness/yoga",
  "fitness-zumba":    "fitness/zumba",
  "fitness-pool":     "fitness/pool",
};

type MediaItem = { type: "image" | "video"; url: string };

const _cache: Record<string, { items: MediaItem[]; ts: number }> = {};
const CACHE_TTL = 10 * 60 * 1000;

async function listResources(folder: string, resourceType: "image" | "video"): Promise<MediaItem[]> {
  const cacheKey = `${folder}::${resourceType}`;
  const now = Date.now();
  const cached = _cache[cacheKey];
  if (cached && now - cached.ts < CACHE_TTL) return cached.items;

  try {
    const res = await cloudinary.search
      .expression(`folder:${folder}/* AND resource_type:${resourceType}`)
      .max_results(500)
      .execute();

    const items: MediaItem[] = (res.resources ?? []).map((r: { secure_url: string }) => ({
      type: resourceType,
      url:  r.secure_url,
    }));

    _cache[cacheKey] = { items, ts: now };
    return items;
  } catch (e: unknown) {
    const err = e as { http_code?: number; message?: string };
    console.error(`[getMedia] error (${folder}, ${resourceType}):`, err?.message);
    return [];
  }
}

function pickRandom<T>(arr: T[]): T[] {
  if (!arr.length) return [];
  return [arr[Math.floor(Math.random() * arr.length)]];
}

export const getMediaTool = createTool({
  id: "get-media",
  description:
    "Lấy ảnh/video giới thiệu dịch vụ để gửi cho khách. " +
    "GiảiCo (mr-*): mr-sport / mr-neck-shoulder / mr-female / mr-general. " +
    "Fitness: fitness-gym / fitness-yoga / fitness-zumba / fitness-pool.",
  inputSchema: z.object({
    key: z.enum([
      "mr-sport",
      "mr-neck-shoulder",
      "mr-female",
      "mr-general",
      "fitness-gym",
      "fitness-yoga",
      "fitness-zumba",
      "fitness-pool",
    ]),
  }),
  outputSchema: z.object({ data: z.string() }),
  execute: async (input) => {
    const folder = KEY_TO_FOLDER[input.key];
    console.log(`[getMedia] key=${input.key} folder=${folder}`);

    const [images, videos] = await Promise.all([
      listResources(`${folder}/img`, "image"),
      listResources(`${folder}/video`, "video"),
    ]);

    const data: MediaItem[] = [
      ...pickRandom(images),
      ...pickRandom(videos),
    ];

    console.log(`[getMedia] key=${input.key} → images=${images.length} videos=${videos.length} picked=${data.length}`);
    return { data: JSON.stringify(data) };
  },
});
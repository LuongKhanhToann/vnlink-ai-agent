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
  // Before-after TÁCH theo mục tiêu — gửi ĐÚNG ca (khách giảm cân không nhận ảnh tăng cân).
  // Thư mục con trên Cloudinary: fitness/before-after/{giam-can,tang-can}/{img,video}.
  "fitness-before-after-loss": "fitness/before-after/giam-can",
  "fitness-before-after-gain": "fitness/before-after/tang-can",
  // Mục tiêu chưa rõ → rổ gộp (folder fitness/before-after/{img,video}).
  "fitness-before-after":      "fitness/before-after",
};

type MediaItem = { type: "image" | "video"; url: string };

// CACHE ĐÃ GỠ HOÀN TOÀN (2026-06-15) — theo yêu cầu: cấm dùng cache ở mọi tầng.
// Mỗi lần cần media là fetch trực tiếp từ Cloudinary, không lưu lại.
async function listResources(folder: string, resourceType: "image" | "video"): Promise<MediaItem[]> {
  try {
    const res = await cloudinary.search
      .expression(`folder:${folder}/* AND resource_type:${resourceType}`)
      .max_results(500)
      .execute();

    const items: MediaItem[] = (res.resources ?? []).map((r: { secure_url: string }) => ({
      type: resourceType,
      url:  r.secure_url,
    }));

    return items;
  } catch (e: unknown) {
    console.error(`[getMedia] raw error:`, JSON.stringify(e), e);
    const err = e as { http_code?: number; message?: string };
    console.error(`[getMedia] error (${folder}, ${resourceType}):`, err?.message);
    return [];
  }
}

// Fisher-Yates: random uniform thật. `sort(() => Math.random() - 0.5)` cũ
// có bias (không phân phối đều) → một số phần tử hay được chọn hơn.
function pickRandom<T>(arr: T[], count: number = 1): T[] {
  if (!arr.length) return [];
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, count);
}

/**
 * Fetch media thuần (không qua tool wrapper) — dùng chung cho:
 *   - getMediaTool (LLM tự gọi), và
 *   - inject deterministic ở routerWorkflow (chống flaky tool-call của gpt-5.4-mini).
 * Trả TỐI ĐA 2 items: 1 ảnh + 1 video. Fetch trực tiếp Cloudinary mỗi lần, KHÔNG cache.
 */
export async function fetchMedia(key: string): Promise<MediaItem[]> {
  const folder = KEY_TO_FOLDER[key];
  if (!folder) {
    console.error(`[getMedia] key không hợp lệ: ${key}`);
    return [];
  }
  const [images, videos] = await Promise.all([
    listResources(`${folder}/img`, "image"),
    listResources(`${folder}/video`, "video"),
  ]);
  const data: MediaItem[] = [
    ...pickRandom(images, 1),
    ...pickRandom(videos, 1),
  ];
  console.log(`[getMedia] key=${key} → images=${images.length} videos=${videos.length} picked=${data.length}`);
  return data;
}

export const getMediaTool = createTool({
  id: "get-media",
  description:
    "Lấy ảnh/video giới thiệu dịch vụ để gửi cho khách. " +
    "GiảiCo (mr-*): mr-sport / mr-neck-shoulder / mr-female / mr-general. " +
    "Fitness: fitness-gym / fitness-yoga / fitness-zumba / fitness-pool. " +
    "fitness-before-after: ảnh hội viên lột xác (gửi khi pitch kết quả / khách phân vân về hiệu quả).",
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
      "fitness-before-after",
    ]),
  }),
  outputSchema: z.object({ data: z.string() }),
  execute: async (input) => {
    const data = await fetchMedia(input.key);
    return { data: JSON.stringify(data) };
  },
});
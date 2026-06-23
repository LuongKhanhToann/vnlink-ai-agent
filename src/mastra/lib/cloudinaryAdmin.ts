/**
 * lib/cloudinaryAdmin.ts
 *
 * Quản lý media (ảnh/video) trên Cloudinary cho webadmin: liệt kê, tải lên, xoá.
 * Dùng chung credential với tools/media.ts (bot lấy ảnh gửi khách).
 *
 * Cấu trúc folder trên Cloudinary (theo asset_folder):
 *   <base>/img    → ảnh
 *   <base>/video  → video
 * Bot search theo `folder:<base>/* AND resource_type:...` (khớp asset_folder),
 * nên upload PHẢI set asset_folder = "<base>/img|video" để ảnh mới hiện ra cho bot.
 *
 * List dùng Admin API `resources_by_asset_folder` (đọc trực tiếp, KHÔNG dính trễ
 * index của Search API) → admin thấy ảnh ngay sau khi upload/xoá.
 *
 * Giới hạn Facebook (chặn ở cả client lẫn server khi upload):
 *   - Ảnh  ≤ 8MB
 *   - Video ≤ 25MB
 */

import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;   // FB: ảnh < 8MB
export const VIDEO_MAX_BYTES = 25 * 1024 * 1024;  // FB: video < 25MB

export type MediaKind = "img" | "video";

export type AdminMediaItem = {
  public_id: string;
  resource_type: "image" | "video";
  url: string;
  bytes: number;
  format: string;
};

export type MediaCategory = { base: string; label: string };

// Danh mục = folder gốc trên Cloudinary. 4 key mr-* của bot (mr-sport/neck-shoulder/
// female/general) đều trỏ về giaiCo nên gom làm 1 mục. Mỗi mục có 2 folder con img/video.
export const MEDIA_CATEGORIES: MediaCategory[] = [
  { base: "giaiCo",               label: "Giải cơ (Mr.)" },
  { base: "fitness/gym",          label: "Fitness — Gym" },
  { base: "fitness/yoga",         label: "Fitness — Yoga" },
  { base: "fitness/zumba",        label: "Fitness — Zumba" },
  { base: "fitness/pool",         label: "Fitness — Bể bơi" },
  // Before-after TÁCH theo mục tiêu — tải ảnh đúng rổ để bot gửi đúng ca.
  { base: "fitness/before-after/giam-can", label: "Before/After — Giảm cân" },
  { base: "fitness/before-after/tang-can", label: "Before/After — Tăng cân" },
  // Rổ gộp cũ: dự phòng + để quản lý/dọn ảnh chưa phân loại (bot fallback về đây khi rổ tách trống).
  { base: "fitness/before-after", label: "Before/After — Gộp (dự phòng)" },
];

export function isValidBase(base: string): boolean {
  return MEDIA_CATEGORIES.some((c) => c.base === base);
}

const rtOf = (kind: MediaKind): "image" | "video" => (kind === "video" ? "video" : "image");

async function listFolder(assetFolder: string, rt: "image" | "video"): Promise<AdminMediaItem[]> {
  try {
    const r: any = await cloudinary.api.resources_by_asset_folder(assetFolder, {
      resource_type: rt,
      max_results: 100,
    });
    return (r.resources ?? []).map((x: any) => ({
      public_id:     x.public_id,
      resource_type: rt,
      url:           x.secure_url,
      bytes:         x.bytes ?? 0,
      format:        x.format ?? "",
    }));
  } catch (e: any) {
    console.error(`[adminMedia] list ${assetFolder} (${rt}):`, e?.message);
    return [];
  }
}

export async function listCategoryMedia(
  base: string,
): Promise<{ images: AdminMediaItem[]; videos: AdminMediaItem[] }> {
  const [images, videos] = await Promise.all([
    listFolder(`${base}/img`, "image"),
    listFolder(`${base}/video`, "video"),
  ]);
  return { images, videos };
}

export async function uploadMedia(opts: {
  base: string;
  kind: MediaKind;
  buffer: Buffer;
  filename?: string;
}): Promise<AdminMediaItem> {
  const { base, kind, buffer, filename } = opts;
  const rt = rtOf(kind);
  const assetFolder = `${base}/${kind}`;
  const result: any = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        asset_folder: assetFolder,
        resource_type: rt,
        use_filename: true,
        unique_filename: true,
        filename_override: filename,
      },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
    stream.end(buffer);
  });
  return {
    public_id:     result.public_id,
    resource_type: rt,
    url:           result.secure_url,
    bytes:         result.bytes ?? buffer.length,
    format:        result.format ?? "",
  };
}

export async function deleteMedia(
  publicId: string,
  resourceType: "image" | "video",
): Promise<boolean> {
  const res: any = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  return res?.result === "ok";
}

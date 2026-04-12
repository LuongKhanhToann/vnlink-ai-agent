/// <reference types="node" />

/**
 * tools/qr.ts
 *
 * getQRTool — trả về URL ảnh QR thanh toán tĩnh.
 * File QR đặt tại:
 *   src/mastra/public/qr/fitness-qr.png
 *   src/mastra/public/qr/muscle-release-qr.png
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const BASE_URL: string = process.env["BASE_URL"] ?? "http://localhost:4111";

const QR_URLS: Record<"fitness" | "muscle-release", string> = {
  "fitness":        `${BASE_URL}/public/qr/fitness-qr.png`,
  "muscle-release": `${BASE_URL}/public/qr/muscle-release-qr.png`,
};

const BANK_INFO: Record<"fitness" | "muscle-release", string> = {
  "fitness":        "Fami Fitness & Yoga Center — quét mã QR để thanh toán",
  "muscle-release": "Trung tâm Chăm sóc Sức khỏe Hoa Sen — quét mã QR để thanh toán",
};

export const getQRTool = createTool({
  id: "get-qr",
  description:
    "Lấy URL ảnh QR thanh toán để gửi cho khách. " +
    "flow='fitness' cho Fami Fitness, flow='muscle-release' cho Hoa Sen.",
  inputSchema: z.object({
    flow: z.enum(["fitness", "muscle-release"]),
  }),
  outputSchema: z.object({
    qrUrl:    z.string().describe("URL ảnh QR để gửi cho khách"),
    bankInfo: z.string().describe("Thông tin tài khoản ngân hàng đi kèm"),
  }),
  execute: async (input) => {
    const qrUrl   = QR_URLS[input.flow];
    const bankInfo = BANK_INFO[input.flow];

    console.log(`[getQR] flow=${input.flow} → ${qrUrl}`);
    return { qrUrl, bankInfo };
  },
});
/**
 * routes/facebook.ts
 */

import { Hono } from "hono";
import { routerWorkflow } from "../workflows/routerWorkflow";
import "dotenv/config";

const FB_VERIFY_TOKEN      = process.env.FB_VERIFY_TOKEN!;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const GRAPH_API            = "https://graph.facebook.com/v19.0/me/messages";

export const facebookWebhook = new Hono();

facebookWebhook.get("/webhook", (c) => {
  const mode      = c.req.query("hub.mode");
  const token     = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("[fb] webhook verified");
    return c.text(challenge ?? "");
  }

  return c.text("Forbidden", 403);
});

facebookWebhook.post("/webhook", async (c) => {
  const body = await c.req.json();

  if (body.object !== "page") return c.text("NOT_PAGE", 404);

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (!event.message?.text || event.message?.is_echo) continue;

      const senderId = event.sender.id as string;
      const text     = event.message.text as string;

      console.log(`[fb] from=${senderId} text="${text}"`);

      handleMessage(senderId, text).catch((e) =>
        console.error("[fb] handleMessage error:", e)
      );
    }
  }

  return c.text("EVENT_RECEIVED");
});

async function handleMessage(senderId: string, text: string) {
  try {
    const run = await routerWorkflow.createRun();

    const result = await run.start({
      inputData: {
        message:    text,
        threadId:   senderId,
        resourceId: "facebook-customer",
      },
    });

    if (result.status !== "success") {
      console.error("[fb] workflow failed:", result.status);
      await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
      return;
    }

    const steps = result.steps as any;
    const output = steps?.["call-fitness"]?.output
                ?? steps?.["call-giai-co"]?.output;

    if (!output?.reply) {
      console.error("[fb] no output found");
      return;
    }

    let { reply, mediaUrls, qrUrl } = output as {
      reply:     string;
      mediaUrls: string[] | null;
      qrUrl:     string | null;
    };

    // Fallback: nếu agent nhét URL ảnh/video vào reply dạng markdown, extract ra
    const urlRegex = /https?:\/\/[^\s\)"]+\.(?:jpg|jpeg|png|webp|gif|mp4|mov|webm)/gi;
    const foundUrls = reply?.match(urlRegex) ?? [];
    if (foundUrls.length > 0) {
      mediaUrls = [...(mediaUrls ?? []), ...foundUrls];
      // Xóa markdown image khỏi reply
      reply = reply.replace(/\d+\.\s*!\[.*?\]\(.*?\)\s*/g, "").trim();
    }

    console.log(`[fb] sending reply: "${reply}"`);
    console.log(`[fb] mediaUrls: ${JSON.stringify(mediaUrls)}`);

    if (reply)             await sendText(senderId, reply);
    if (mediaUrls?.length) for (const url of mediaUrls) await sendMedia(senderId, url);
    if (qrUrl)             await sendMedia(senderId, qrUrl);

  } catch (e) {
    console.error("[fb] workflow error:", e);
    await sendText(senderId, "Xin lỗi anh/chị, em gặp sự cố. Anh/chị nhắn lại giúp em nha!");
  }
}

async function sendText(recipientId: string, text: string) {
  await callSendAPI({
    recipient: { id: recipientId },
    message:   { text },
  });
}

const VIDEO_EXTS = /\.(mp4|mov|webm|avi)(\?.*)?$/i;

function isVideoUrl(url: string): boolean {
  // Check extension or encoded extension (e.g. %2Fvideo%2F...)
  return VIDEO_EXTS.test(url) || url.toLowerCase().includes("/video/");
}

async function sendMedia(recipientId: string, url: string) {
  const type = isVideoUrl(url) ? "video" : "image";
  await callSendAPI({
    recipient: { id: recipientId },
    message: {
      attachment: {
        type,
        payload: { url, is_reusable: true },
      },
    },
  });
}

async function callSendAPI(body: object) {
  console.log("[fb] callSendAPI:", JSON.stringify(body).slice(0, 100));
  try {
    const res = await fetch(`${GRAPH_API}?access_token=${FB_PAGE_ACCESS_TOKEN}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    const responseText = await res.text();
    if (!res.ok) {
      console.error(`[fb] Graph API error ${res.status}:`, responseText);
    } else {
      console.log(`[fb] Graph API ok ${res.status}:`, responseText);
    }
  } catch (e) {
    console.error("[fb] fetch exception:", e);
  }
}
import { Mastra } from "@mastra/core/mastra";
import { ConsoleLogger } from "@mastra/core/logger";
import { Hono } from "hono";
import { storage } from "./config/storage";
import { routerWorkflow } from "./workflows/routerWorkflow";
import { fitnessAgent } from "./agents/fitness";
import { giaiCoAgent } from "./agents/giaiCo";
import { facebookWebhook } from "./routes/facebook";

const app = new Hono();
app.route("/", facebookWebhook);

export const mastra = new Mastra({
  agents: { fitnessAgent, giaiCoAgent },
  workflows: { routerWorkflow },
  storage,
  logger: new ConsoleLogger({ name: "Vinalink", level: "info" }),
  server: {
    port: 4111,
    middleware: [
      async (c, next) => {
        // Mount facebook webhook vào Mastra server
        const res = await app.fetch(c.req.raw);
        if (res.status !== 404) return res;
        return next();
      },
    ],
  },
});
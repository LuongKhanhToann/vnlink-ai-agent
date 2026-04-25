import { Memory } from "@mastra/memory";
import { storage } from "./storage";

export const memory = new Memory({
  storage,
  options: {
    lastMessages: 20,
    semanticRecall: false,
  },
});
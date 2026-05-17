import { Memory } from "@mastra/memory";
import { storage } from "./storage";

// lastMessages=8 (Phase 6): mini càng ít memory càng ít mimic pattern cũ.
// State machine + tracking sets (askedHistory, mentionedFacts) carry toàn bộ context cross-turn
// → memory chỉ giữ TONE consistency của 4 cặp KH/bot gần nhất là đủ.
export const memory = new Memory({
  storage,
  options: {
    lastMessages: 8,
    semanticRecall: false,
  },
});
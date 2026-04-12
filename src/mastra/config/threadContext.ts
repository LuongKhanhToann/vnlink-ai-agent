import { AsyncLocalStorage } from "async_hooks";

export const threadContext = new AsyncLocalStorage<{
  threadId: string;
  resourceId: string;
}>();
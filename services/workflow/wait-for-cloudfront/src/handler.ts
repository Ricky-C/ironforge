import { buildHandler } from "./handle-event.js";

// Production handler — single shared instance built at module load.
// All AWS clients live inside buildHandler's closure with default deps.
export const handler = buildHandler();

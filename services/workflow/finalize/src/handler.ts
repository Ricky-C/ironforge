import { buildHandler } from "./handle-event.js";

// Production handler — single shared instance built at module load.
// All AWS clients live inside buildHandler's closure with default
// deps (real Date.now, real shared-utils docClient).
export const handler = buildHandler();

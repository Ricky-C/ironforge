import { buildHandler } from "./handle-event.js";

// Production handler — single shared instance built at module load.
// All deps default: real Date.now, real destroy-chain primitives, env
// resolution at first invoke.
export const handler = buildHandler();

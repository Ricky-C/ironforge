import { buildHandler } from "./handle-event.js";

// Production handler — single shared instance built at module load.
// All AWS clients + Octokit live inside buildHandler's closure with
// default deps (real Secrets Manager fetch, real GitHub App auth, real
// libsodium-wrappers).
export const handler = buildHandler();

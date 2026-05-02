import { buildHandler } from "./handle-event.js";

// Lambda entry point. Wires production deps (real getInstallationToken,
// real buildAuthenticatedOctokit, env-var-backed config, build-time
// starter-code snapshot). Tests use buildHandler directly with injected
// dependencies — see handle-event.test.ts.
export const handler = buildHandler();

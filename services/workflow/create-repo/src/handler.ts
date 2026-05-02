import { buildHandler } from "./handle-event.js";

// Lambda entry point. Wires the production deps (real
// getInstallationToken from shared-utils, real buildAuthenticatedOctokit,
// env-var-backed config). Tests use buildHandler directly with injected
// dependencies — see handle-event.test.ts.
export const handler = buildHandler();

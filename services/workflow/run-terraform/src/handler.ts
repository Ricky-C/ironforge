import { buildHandler } from "./handle-event.js";

// Lambda entry point. Wires production deps (real terraform binary spawn,
// real fs operations, env-var-backed config). Tests use buildHandler
// directly with injected dependencies — see handle-event.test.ts.
//
// Per ADR-009: this Lambda is deployed as a container image with the
// terraform 1.10.4 + AWS provider 5.83.0 binaries baked in at /opt/.
// The handler shells out to /opt/bin/terraform via child_process.spawn
// and uses TF_CLI_CONFIG_FILE pointing at a filesystem_mirror to keep
// terraform init from contacting registry.terraform.io.
export const handler = buildHandler();

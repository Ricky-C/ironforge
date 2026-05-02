import { IronforgeManifestSchema } from "@ironforge/shared-types";
import yaml from "js-yaml";

import { buildHandler } from "./handle-event.js";
import manifestYamlText from "../../../../templates/static-site/ironforge.yaml";

// Module-load (cold start) manifest parse + validation. A malformed
// manifest fails the Lambda init — operators see InitError before any
// user request lands, not a runtime exception buried mid-workflow.
//
// The YAML is bundled as a text string at esbuild time (see build.mjs
// loader config). Re-bundling the validated object as a JS literal at
// build time would skip the runtime parse but adds a code-generation
// step; cold-start parse cost is negligible (~ms) at portfolio scale.
const manifest = IronforgeManifestSchema.parse(yaml.load(manifestYamlText));

export const handler = buildHandler(manifest);

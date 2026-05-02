// Bundles src/handler.ts to dist/handler.js for Lambda. Same shape as
// services/api/build.mjs — esbuild ESM bundle with @aws-sdk/* externalized,
// dist/package.json marking the bundle as ESM. The infra/modules/lambda
// module zips dist/ at terraform plan time via archive_file; CI must run
// this build before terraform plan.

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(__dirname, "src/handler.ts")],
  outfile: resolve(distDir, "handler.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: false,
  minify: false,
  external: ["@aws-sdk/*", "@smithy/*"],
  logLevel: "info",
});

writeFileSync(
  resolve(distDir, "package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);

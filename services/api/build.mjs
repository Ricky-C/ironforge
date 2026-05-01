// Bundles services/api/src/handler.ts to services/api/dist/handler.js for
// Lambda. The infra/modules/lambda module zips the dist/ directory at
// `terraform plan` time via archive_file; CI must run this build before
// `terraform plan`.
//
// Output shape: dist/handler.js (ESM bundle) + dist/package.json with
// "type": "module" so Lambda's nodejs22.x runtime treats the .js file as
// ESM.
//
// Externals: @aws-sdk/* and @smithy/* are provided by the Lambda runtime;
// bundling them inflates the artifact and risks version skew with the
// runtime's vendored SDK. Everything else (Hono, Powertools, zod, our
// own packages) is bundled so the Lambda runs without a node_modules/.

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [resolve(__dirname, "src/handler.ts")],
  outfile: resolve(distDir, "handler.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Sourcemaps deliberately omitted. Lambda doesn't use them without
  // NODE_OPTIONS=--enable-source-maps, and they roughly double the zip
  // size. Local debugging uses TS source via Vitest, not the bundle.
  sourcemap: false,
  minify: false,
  // Lambda Node 22 ships AWS SDK v3; treating these as external avoids
  // version skew and reduces bundle size.
  external: ["@aws-sdk/*", "@smithy/*"],
  // ESM in Node requires file extensions on relative imports. The
  // `.js` extensions in our `.ts` files (e.g., `import "./auth.js"`) are
  // resolved by Bundler resolution at typecheck time and rewritten by
  // esbuild here.
  logLevel: "info",
  metafile: true,
});

// Lambda's nodejs22.x runtime defaults to CommonJS when loading a `.js`
// file. Adding "type": "module" in dist/package.json switches it to ESM
// so `import` syntax works at runtime.
writeFileSync(
  resolve(distDir, "package.json"),
  JSON.stringify({ type: "module" }, null, 2) + "\n",
);

const totalBytes = Object.values(result.metafile.outputs).reduce(
  (sum, output) => sum + output.bytes,
  0,
);
console.log(
  `@ironforge/api: bundled ${(totalBytes / 1024).toFixed(1)} KB to dist/handler.js`,
);

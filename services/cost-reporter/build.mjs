import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "dist/index.js",
  // AWS SDK v3 ships with the Node.js 22 Lambda runtime; bundling it would
  // bloat the artifact and risk version drift against the runtime.
  external: ["@aws-sdk/*"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

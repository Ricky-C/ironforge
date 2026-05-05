import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone mode for Lambda Web Adapter deployment per ADR-011.
  // Builds a self-contained server bundle at .next/standalone/server.js
  // that LWA invokes inside the container Lambda (see apps/web/Dockerfile).
  output: "standalone",

  // Monorepo root for output file tracing. Without this, Next.js's
  // standalone bundle scans only from apps/web/, missing workspace
  // dependencies in packages/* and producing an incomplete server bundle.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
};

export default nextConfig;

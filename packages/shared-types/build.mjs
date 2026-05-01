// @ironforge/shared-types is a TypeScript-only library consumed via the
// "exports" field pointing at src/. No bundling step needed; consumer
// bundlers (esbuild for Lambdas, Next.js for the portal) handle TS
// directly. This stub keeps `pnpm -r run build` green.
console.log("@ironforge/shared-types: source-only package — build is a no-op");

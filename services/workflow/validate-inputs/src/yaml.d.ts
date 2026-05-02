// esbuild's `loader: { ".yaml": "text" }` bundles YAML files as their
// raw string contents. This declaration teaches tsc the same shape so
// `import yaml from "./*.yaml"` typechecks. The YAML import lives only
// in handler.ts (the Lambda entry point); tests import buildHandler
// from handle-event.ts and never trigger YAML resolution.
declare module "*.yaml" {
  const content: string;
  export default content;
}

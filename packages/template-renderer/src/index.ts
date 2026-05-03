export {
  IronforgeRenderError,
  renderTemplate,
  renderTree,
  type RenderMap,
} from "./render.js";
export {
  IronforgeUnknownResourceTypeError,
  RESOURCE_TYPE_TO_IAM,
  generateRunTerraformPolicy,
  type ArnSpec,
  type IamStatement,
  type ResourceTypeMapping,
  type ScopingContext,
} from "./iam-policy.js";

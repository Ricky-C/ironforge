import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.3 with real per-template input
// validation against the manifest's inputsSchema reference.
export const handler = stubTask({
  stepName: "validate-inputs",
  buildOutput: (event) => ({
    valid: true,
    templateId: event.templateId,
  }),
});

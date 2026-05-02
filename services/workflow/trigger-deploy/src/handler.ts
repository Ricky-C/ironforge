import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.8 with real GitHub Actions
// workflow_dispatch trigger.
export const handler = stubTask({
  stepName: "trigger-deploy",
  buildOutput: () => ({
    workflowRunId: 0,
    workflowRunUrl: "",
  }),
});

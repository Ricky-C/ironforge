import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.4b with real Octokit-backed repo
// creation (existing-repo handling: re-use if owner matches).
export const handler = stubTask({
  stepName: "create-repo",
  buildOutput: (event) => ({
    repoUrl: `https://github.com/ironforge-svc/${event.serviceName}`,
    repoId: 0,
  }),
});

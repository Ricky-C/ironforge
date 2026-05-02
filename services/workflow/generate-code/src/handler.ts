import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.5 with the template renderer that
// substitutes __IRONFORGE_<NAME>__ placeholders and pushes the
// rendered tree to the user's repo.
export const handler = stubTask({
  stepName: "generate-code",
  buildOutput: () => ({
    commitSha: "0000000000000000000000000000000000000000",
    filesPushed: 0,
  }),
});

import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.7 with real CloudFront distribution-
// status polling (status === "Deployed" + DNS resolution check).
export const handler = stubTask({
  stepName: "wait-for-cloudfront",
  buildOutput: () => ({
    distributionStatus: "Deployed",
  }),
});

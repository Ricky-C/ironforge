// cleanup-on-failure re-exports cleanupStub from the stub-lib.
// Status writes only: Service provisioning → failed, Job running →
// failed, JobStep#cleanup-on-failure running → succeeded. No
// destroy of GitHub repos, S3 buckets, CloudFront, etc — see
// docs/tech-debt.md § "Cleanup-on-failure destroy chain" for the
// deferral rationale and the trigger checklist for re-introducing
// destroy semantics.
export { cleanupStub as handler } from "@ironforge/workflow-stub-lib";

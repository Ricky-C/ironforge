import { stubTask } from "@ironforge/workflow-stub-lib";

// PR-C.2 stub. Replaced at PR-C.6 with the real terraform-execution
// model decided in the pre-PR ADR (likely CodeBuild). The output
// shape here matches templates/static-site/terraform/outputs.tf so
// downstream Lambdas (wait-for-cloudfront, finalize) can be wired
// against this stub during PR-C.2 end-to-end exercises.
//
// Stub values are placeholders; real Lambda emits real resource ids.
export const handler = stubTask({
  stepName: "run-terraform",
  buildOutput: (event) => ({
    bucket_name: `ironforge-svc-${event.serviceName}-origin`,
    distribution_id: "ESTUBSTUBSTUB",
    distribution_domain_name: "dstub.cloudfront.net",
    deploy_role_arn: `arn:aws:iam::000000000000:role/ironforge-svc-${event.serviceName}-deploy`,
    live_url: `https://${event.serviceName}.ironforge.rickycaballero.com`,
    fqdn: `${event.serviceName}.ironforge.rickycaballero.com`,
  }),
});

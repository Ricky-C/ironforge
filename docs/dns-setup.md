# DNS setup for Ironforge

Ironforge runs as a subdomain of `rickycaballero.com`. The hosted zone for `ironforge.rickycaballero.com` is **manually managed in Route53** and **NS-delegated from the parent zone** at whatever DNS host serves `rickycaballero.com`.

This is intentional: Ironforge's Terraform consumes the existing zone via `data "aws_route53_zone"` but **never creates or modifies** it. The `infra/modules/dns/` module exists only to add records inside the existing zone — currently the validation CNAMEs for the wildcard ACM cert; later, per-service CNAME records from the provisioning workflow.

## Why not Terraform-managed?

1. **The parent zone is unmanaged by Ironforge.** `rickycaballero.com` itself is the maintainer's portfolio domain — out of scope. The NS-delegation at the parent is a one-time manual operation; not worth Terraform-orchestrating.
2. **Hosted zone destruction is irreversible.** A `terraform destroy` that included the hosted zone would nuke DNS for everything depending on the subdomain. Keeping the zone outside Terraform makes destruction safer.

## Look up the zone ID

If you need the zone ID for IAM scoping, debugging, or AWS CLI work:

```bash
aws route53 list-hosted-zones \
  --query 'HostedZones[?Name==`ironforge.rickycaballero.com.`].Id' \
  --output text
```

The output is in the form `/hostedzone/ZXXXXXXXXXXXXX`. Strip the `/hostedzone/` prefix when using it as a Route53 zone ID; keep the raw ID in ARNs (`arn:aws:route53:::hostedzone/ZXXXXXXXXXXXXX`).

## What the Ironforge Terraform does

`infra/modules/dns/` consumes the existing zone and creates the cert:

- `data "aws_route53_zone" "ironforge"` — looks up the zone by name (`ironforge.rickycaballero.com`)
- `aws_acm_certificate.ironforge` — creates a SAN cert covering `ironforge.rickycaballero.com` and `*.ironforge.rickycaballero.com`, DNS-validated, in us-east-1 (CloudFront requirement)
- `aws_route53_record.cert_validation` — writes validation CNAME records into the existing zone, with `allow_overwrite = true` for clean cert rotation
- `aws_acm_certificate_validation.ironforge` — waits for AWS to validate

No `aws_route53_zone` resource. No NS records. No modifications to the parent zone.

## What the Ironforge Lambdas will do (Phase 1+)

The provisioning workflow Lambdas (in `services/workflow/`) will create per-service CNAME records (e.g., `mysite.ironforge.rickycaballero.com → <CloudFront distribution domain>`). Their IAM grants must scope to the ironforge zone ARN only (`module.dns.hosted_zone_arn`). Provisioning Lambdas must never have `Resource: "*"` on Route53 actions.

## Setting it up from scratch (forking)

If you fork Ironforge and want to run it under your own subdomain:

1. Decide on a subdomain (e.g., `ironforge.example.com`).
2. Create a Route53 hosted zone for the subdomain in your AWS account.
3. At your parent DNS host (wherever `example.com`'s DNS lives), add NS records pointing the subdomain at the four AWS-provided NS values from the new hosted zone.
4. Wait for DNS propagation (usually < 30 minutes).
5. Update `infra/envs/shared/main.tf` to pass your subdomain to `module.dns`.
6. `terraform apply` the shared composition — the cert validates against your zone.

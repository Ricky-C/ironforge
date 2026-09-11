# ADR 012 — WAF as an opt-in toggle + portal concurrency cap as the real flood control

**Status:** Accepted

**Date:** 2026-06-29

## Context

A cost review of the live account (`aws ce get-cost-and-usage`, 6-month trend) found the monthly bill at **~$18.3/mo**, dominated by two line items that together are ~83% of the controllable spend:

- **AWS WAF — ~$9/mo.** One `CLOUDFRONT`-scoped web ACL ($5) + 4 rules ($4): `AWSManagedRulesCommonRuleSet`, `AWSManagedRulesKnownBadInputsRuleSet`, `AWSManagedRulesAmazonIpReputationList`, and a `RateLimitPerIP` rate-based rule. Always-on, unconditional. Defined in `infra/modules/cloudfront-frontend/main.tf`.
- **AWS KMS — ~$6.6/mo.** 8 customer-managed CMKs (see § Related for the cleanup of 2 that turned out to be foreign/orphan waste).

For a single-tenant portfolio project that is dormant the large majority of the time, ~$9/mo of always-on WAF is hard to justify on protective grounds. The review forced a precise threat-model question: **what does this WAF actually protect, and is it the control standing between the internet and the thing we care about — provisioning real AWS infrastructure?**

### Empirical input — current state, 2026-06-29

- The WAF web ACL is attached **only to the portal CloudFront distribution** (`web_acl_id` on `aws_cloudfront_distribution.portal`). It is **not** on the API. `docs/tech-debt.md` records that AWS WAF cannot attach to an HTTP API; the API relies on the API Gateway JWT authorizer + API-Gateway throttling instead. So the provisioning path was never behind this WAF.
- The provisioning path (`POST` → API Gateway HTTP API → Hono Lambda → Step Functions) is gated by: Cognito JWT authorizer (signature/iss/aud/exp) + the in-Lambda `token_use === "access"` check; the hard cap of 5 concurrent provisioning jobs; the template resource-type whitelist (nothing larger than `t3.micro`); and the $50 budget deny action. None of these is the WAF.
- The portal Lambda (`aws_lambda_function.portal`, 1024 MB, image-mode) had **no reserved concurrency** (`ReservedConcurrentExecutions: None`). The account concurrency limit is **400**. So a request flood on the public portal could scale the portal Lambda unbounded toward 400 concurrent executions.
- The live `$50` budget action (`ironforge-monthly-action-50`, `APPLY_IAM_POLICY`, status `STANDBY`) attaches `IronforgeBudgetActionDeny` to the roles `ironforge-dev-run-terraform-execution` and `ironforge-ci-apply`. That policy denies **resource creation** (`lambda:CreateFunction`, `cloudfront:CreateDistribution`, `rds:*`, `ec2:RunInstances`, IAM priv-esc, …). It is a control against **runaway provisioning**, not against inbound traffic.

### The reframe

Two facts change the decision:

1. **The WAF is edge defense-in-depth + a portfolio signal — not the provisioning gate.** Toggling it off does not expose the provisioning engine, the data plane, or the account. A bot cannot provision infrastructure without a valid Cognito access token, and that path is not behind this WAF.

2. **The WAF's one genuinely load-bearing function is per-IP rate limiting of the public portal — and the `$50` budget action cannot substitute for it.** A traffic flood drives cost through CloudFront requests/data-transfer + **portal Lambda invocations and compute** (the open-ended multiplier, since the function was uncapped). The budget action denies the provisioning/CI roles from *creating* resources; it has no effect on CloudFront receiving requests and invoking the already-existing portal Lambda. It also lags hours behind real spend. So relying on it to bound a flood's cost is a category error.

Therefore the WAF's protective value reduces to: (a) rate-limiting the portal frontend against a cost-driving flood, and (b) generic edge filtering of scanner noise. (a) is better and more cheaply provided by a Lambda concurrency cap; (b) is low marginal value on an obscure portfolio domain. The portfolio/senior signal of "we run a WAF with managed rule groups + rate limiting" lives in the Terraform existing and being one `apply` away — not in paying for it 24/7.

## Decision

**1. The portal WAF becomes opt-in, default off.** A `var.enable_waf` (module `cloudfront-frontend`) / `var.portal_waf_enabled` (composition `envs/shared`) bool, default `false`, gates the web ACL via `count`. When false the ACL is **not created** (a detached-but-existing ACL still bills $5+$4), and `web_acl_id` / the `waf_web_acl_arn` output resolve to `null` via `one(aws_wafv2_web_acl.portal[*].arn)`. Flip `true` for active demos/interviews — one `terraform apply`, ~5–15 min CloudFront propagation. The full rule set (3 managed groups + rate limit) is unchanged; only its existence is gated.

**2. The portal Lambda gets `reserved_concurrent_executions = 15` as the real flood-cost control.** This is the $0 replacement for the WAF rate rule's cost-protection role. Under a flood, excess requests are throttled (429) instead of invoking, capping both Lambda compute and full-response data transfer. 15 is ample for portfolio traffic (only a flood reaches it) and additionally prevents a portal flood from starving the provisioning Lambdas in the shared 400 pool. This applies **whether or not the WAF is on**, so the portal is better protected against a cost-DoS than it was with the always-on WAF but an uncapped Lambda.

## Why

### This is the correct cost/risk trade for a portfolio project

The dominant standing cost (WAF) was buying defense-in-depth on a surface that is not the sensitive one, while the actual open-ended cost exposure (uncapped portal Lambda) was unmitigated. Reversing that — drop the discretionary always-on spend, add the $0 control that closes the real gap — reduces cost **and** improves cost-resilience. Demonstrating that reasoning is itself the senior signal: cost-conscious threat-modeling over cargo-culted always-on security.

### Relationship to the CLAUDE.md WAF guardrail

CLAUDE.md lists "AWS WAF on the portal CloudFront with managed rule groups" under Security Guardrails. This ADR is the required ADR-level justification for departing from the always-on reading of that guardrail. The guardrail's intent — defense-in-depth on the public portal, and the demonstrated capability to run a managed-rules WAF — is preserved: the code, rules, and attachment remain intact and are one variable flip away. What changes is that the runtime is gated for cost on a dormant portfolio project. The guardrail is satisfied in capability; it is not satisfied as a 24/7 runtime guarantee while `portal_waf_enabled = false`.

### Alternatives considered

- **Keep WAF always-on (~$9/mo).** Rejected as the default: pays continuously for defense-in-depth on the non-sensitive surface. Still available by setting `portal_waf_enabled = true` during active interview season.
- **Trim managed rule groups 3 → 1 (~$7/mo, always-on).** Saves only ~$2 because the $5 ACL base is unavoidable for any rule, and it permanently weakens the demonstrated rule-set without addressing the uncapped-Lambda gap. Rejected.
- **Remove WAF entirely with no replacement.** Rejected: removes the only portal flood throttle with nothing in its place. The concurrency cap is what makes "WAF off" safe.
- **Rely on the $50 budget action to bound flood cost.** Rejected on mechanism: the action denies provisioning by IAM principals; it cannot stop traffic-driven invocation cost, and it lags hours.

## Consequences

- **Cost:** WAF → ~$0 while dormant (prorated hourly); ~$9 only during the days it's toggled on. Combined with the KMS/account cleanup (§ Related) and ECR retention trim, the dormant bill drops ~65% (≈$18.3 → ≈$6.5/mo).
- **Security posture (residual risk):** while `portal_waf_enabled = false`, the public portal has no edge managed-rule filtering or WAF rate limiting. Mitigations: the provisioning path remains Cognito-gated + job-capped + whitelisted + budget-guarded (unaffected); AWS Shield Standard still covers L3/L4 volumetric DDoS on CloudFront for free; and the concurrency cap bounds the cost of an L7 flood. The accepted residual is generic L7 scanner noise reaching the Next.js app and a bounded (not unbounded) flood cost. For any event that elevates this risk (e.g. a publicized live demo, an observed attack), flip the toggle on.
- **Operational:** turning WAF on is not instant — budget ~5–15 min for CloudFront to propagate the association. "Turn it on the morning of a demo," not at click time.

## Toggling off — two-phase teardown (added 2026-06-29)

The first toggle-off (PR #174) failed at apply: terraform attempted `DeleteWebACL` while the ACL was still associated with the distribution and returned `WAFAssociatedItemException`. Root cause is a terraform limitation — when a *kept* resource (the CloudFront distribution, updated to drop `web_acl_id`) and a *destroyed* resource (the WAF ACL) change in the same apply, terraform does **not** reliably update the keeper before destroying the referent. So CloudFront was never detached and the ACL stayed deletable-blocked. Plain re-runs (CI or `-target`) repeat this; only detaching CloudFront first breaks the deadlock, and AWS additionally needs the disassociation to propagate before the delete is accepted.

Fix: `enable_waf` (ACL **exists**, via `count`) is decoupled from `attach_waf` (ACL **attached** to CloudFront). `web_acl_id = var.enable_waf && var.attach_waf ? aws_wafv2_web_acl.portal[0].arn : null`. Toggle **off** in two applies:

1. **Detach:** `attach_waf = false` (keep `enable_waf = true`) → apply. Only CloudFront updates (drops `web_acl_id`); the ACL survives, detached. Wait ~5–15 min for CloudFront to reach `Deployed` so the WAFv2 association clears.
2. **Delete:** `enable_waf = false` → apply. The now-detached ACL deletes cleanly.

Toggle **on** is a single apply (`enable_waf = true`, `attach_waf = true` default): the ACL is created and attached together (no ordering hazard on create).

## Related

- **ADR-003** (CMK vs AWS-managed) governs the KMS keys. This cost sweep additionally deletes 2 KMS keys that are **not** Ironforge resources and bypass ADR-003 entirely: a foreign `alias/PPKSKKMSKEY` (created before Ironforge existed, a prior WordPress project's key) and an orphaned no-alias duplicate of the bootstrap Terraform-state key. Both are scheduled for deletion (30-day cancelable window) as live housekeeping, along with a foreign WordPress RDS snapshot and an 8 GB EBS snapshot + AMI. None is Terraform-managed. The ADR-003-justified CMKs are kept unchanged.
- **docs/tech-debt.md** — the portal-Lambda "reserved concurrency deliberately unset" note is revisited here with a cost-DoS rationale.

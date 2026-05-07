# ADR 010 — Auth flow integration: Cognito Hosted UI + `oidc-client-ts`

**Status:** Accepted

**Date:** 2026-05-04

## Context

Phase 2 introduces the authenticated portal UI for Ironforge. The portal (`apps/web`, Next.js 16 App Router) needs to:

- Authenticate users against the existing Cognito User Pool (`us-east-1_vnvU5BYwy`, app client `5q5dvippbnq8c7msupj1pi05e6` from Phase 0).
- Obtain tokens to pass to the API Gateway HTTP API JWT authorizer (per CLAUDE.md § Authentication, the in-Lambda middleware validates `token_use === "access"`, so `access_token` is the right one to send).
- Refresh tokens before expiry — Cognito's 30-minute access token lifetime would otherwise force re-login mid-session.
- Provide login / logout / password-reset / email-verification flows without re-implementing security-sensitive UI.

Three coupled decisions get locked together: (1) where does the login UI live (Hosted UI vs. custom), (2) which OIDC client library handles the redirect flow, (3) how are tokens stored and refreshed.

The auth flow lands across four authenticated surfaces in Phase 2 — service catalog (subphase 2.1), service-detail with DELETE (2.2), multi-step wizard (2.3), and real-time progress polling on the detail page (2.4). Subphase 2.6 layers an unauthenticated demo mode onto the same Next.js shell — same components, different API client target. ADR-010 governs the authenticated flow only; demo mode bypasses it cleanly. The dev workflow (synthetic test user + `mint-test-token` SRP-flow helper, retained per `docs/runbook.md`) continues unchanged for backend testing.

### Empirical input — Cognito app client state, 2026-05-04

`aws cognito-idp describe-user-pool-client --user-pool-id us-east-1_vnvU5BYwy --client-id 5q5dvippbnq8c7msupj1pi05e6` returned:

- `AllowedOAuthFlows`: `["code"]` — Authorization Code flow, correct for Hosted UI.
- `AllowedOAuthScopes`: `["email", "openid", "profile"]` — standard.
- `AccessTokenValidity`: 30 minutes; `IdTokenValidity`: 30 minutes; `RefreshTokenValidity`: 30 days.
- `ExplicitAuthFlows`: `["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]` — refresh enabled (required for our flow), SRP enabled for the `mint-test-token` dev helper (separate flow, not used by the portal).
- `PreventUserExistenceErrors`: `ENABLED`.
- `EnableTokenRevocation`: `true`.
- `CallbackURLs`: `["http://localhost:3000/api/auth/callback/cognito"]` — **NextAuth.js / Auth.js v5 convention**, not oidc-client-ts's. Suggests Phase 0 considered NextAuth and did not commit.
- `LogoutURLs`: `["http://localhost:3000"]` — dev only; prod URL absent.

The callback/logout allowlist needs updating regardless of library choice: the prod portal URL (`https://ironforge.rickycaballero.com`) is missing entirely.

A second call — `aws cognito-idp describe-user-pool --user-pool-id us-east-1_vnvU5BYwy` — confirmed the Hosted UI domain: `Domain: "ironforge-010438464240"` (Cognito-prefix), `CustomDomain: null`. Hosted UI is reachable at `https://ironforge-010438464240.auth.us-east-1.amazoncognito.com`. No domain-setup task is needed; only theming and URL-allowlist updates remain on the pre-implementation list.

## Decision

**Cognito Hosted UI for the login surface; `oidc-client-ts` for the OIDC client; `sessionStorage` for token storage by default.**

- Login / logout / password-reset / email-verification UI: Cognito Hosted UI, themed via the Cognito console's Hosted UI customization (logo, primary color, button styles).
- OIDC client library: `oidc-client-ts` (`UserManager` API) handles the Authorization Code redirect flow, token storage, automatic silent refresh against the 30-day refresh token, and logout redirect.
- Token storage: `sessionStorage` (default) — cleared on tab close. No "remember me" toggle until UX feedback says otherwise.
- Token passed to API: `access_token` as Bearer (CLAUDE.md mandates `token_use === "access"` validation; `id_token` would fail that check).
- Callback paths: `/auth/callback` (login redirect handler) and `/` (post-logout redirect). The existing NextAuth-pattern URL gets removed during subphase 2.5 (auth) setup.

## Why Hosted UI

### Security-sensitive flows are AWS's responsibility

Password handling, session token issuance, MFA prompts, password reset, email verification: each is a security-sensitive flow AWS already implements correctly behind Hosted UI. Re-implementing them in custom UI adds attack surface without portfolio signal. Per CLAUDE.md § "What This Project Is Optimizing For", security correctness is the #1 priority above ship velocity — picking the AWS-native pattern is the discipline this project rewards.

### Customization sufficient for portfolio polish

Hosted UI's customization surface (logo upload, primary color, button styling, CSS overrides via the Cognito console's CSS editor) is enough for portfolio quality. The portal's branded depth lives in the wizard, catalog, and detail page — not the login redirect.

### Future MFA / password-reset come for free

If MFA becomes a requirement (compliance, multi-tenant, sensitive operations), Hosted UI handles it without portal code changes. Same for password-reset emails, email verification, and any future Cognito-shipped flows.

## Why `oidc-client-ts`

### Fit-to-purpose — load-bearing argument

`oidc-client-ts` implements RFC 6749 + OpenID Connect Core 1.0; it does authentication and nothing else. `aws-amplify/auth` bundles authentication alongside Amplify-specific conventions — federated sign-in helpers, advanced-security helpers, group / role helpers, MFA UI hooks — that the portal doesn't need at portfolio scale (Hosted UI handles MFA UI; single Cognito provider; no group / role logic). Every line of `oidc-client-ts` we ship has a direct consumer; a meaningful fraction of `aws-amplify/auth` does not.

OIDC-standard implementation also gives portability across identity providers. Knowledge of the underlying OIDC spec and `oidc-client-ts`'s primitives transfers to Auth0, Okta, Azure AD, or any future Cognito alternative. Amplify-Cognito knowledge does not transfer outside AWS — a provider switch becomes a rewrite, not a configuration change.

### Bundle weight — secondary supporting evidence

Measured via the `bundlephobia.com/api` endpoint on 2026-05-04: `oidc-client-ts@3.5` is 69.85 KB minified / 17.69 KB gzipped; `@aws-amplify/auth@6.19.1` is 117.75 KB minified / 29.90 KB gzipped. The ~12 KB gzipped delta (~1.7× ratio) is real but not decisive at modern web scale. The fit-to-purpose argument above is what carries the decision; bundle weight supports it, not the other way around.

### Native silent refresh against the 30-day refresh token

`UserManager`'s `automaticSilentRenew: true` config refreshes the access token via the refresh-token grant ahead of expiry. With Cognito's 30-minute access lifetime + 30-day refresh, this gives the user "log in once, stay logged in for ~30 days without redirect" UX, with refresh handled invisibly.

### Client-side architecture aligns with how the portal works

The portal's data fetches happen client-side via TanStack Query against API Gateway directly. Next.js Server Components do not make per-user API calls (the catalog / detail / wizard are client components). `oidc-client-ts`'s browser-only token storage is the natural fit; NextAuth's cookie-based server-session strength has no consumer in this architecture.

## Why `sessionStorage`

`sessionStorage` clears on tab close; `localStorage` persists across sessions. Default to `sessionStorage` for tighter security posture — closing the portal tab on a shared machine clears the session. The 30-day refresh token still allows next-day re-login without re-entering credentials, because Hosted UI's own session cookie (separate from the portal's storage) survives; clicking "log in" silently completes the redirect flow.

If UX feedback says the tab-close-clears-session behavior is friction, revisit with a `localStorage`-backed "remember me" toggle. Don't pre-build the toggle.

## Alternatives considered

### NextAuth.js / Auth.js v5

Authentication framework for Next.js with a Cognito provider. **Rejected** for three reasons:

1. NextAuth's strength is server-side session management via cookies. The portal does not use server-side data fetching for per-user state — API calls go to API Gateway directly, not through Next.js routes. The cookie-session benefit has no consumer.
2. Framework lock-in. NextAuth's API would shape the portal's auth integration in ways a switch-out would touch every consumer. `oidc-client-ts` is OIDC-standard, so a future swap is mechanical.
3. Bundle weight (~50KB client + server adapter) without a clear architectural win.

The Phase 0 Cognito callback URL pattern (`/api/auth/callback/cognito`) is NextAuth's convention; ADR-010 explicitly diverges from that direction.

### `aws-amplify/auth`

AWS's official auth library for Cognito. **Rejected** primarily for fit-to-purpose: `aws-amplify/auth` bundles federated sign-in helpers, advanced-security mode helpers, group / role helpers, MFA UI hooks, and Auth UI components — none of which the portal uses (Hosted UI handles the UI surface; single Cognito provider; no group / role logic at portfolio scale). What remains is OIDC, which `oidc-client-ts` does directly without the surrounding surface. Vendor lock-in compounds the cost: Amplify wraps OIDC primitives in its own API, so a future provider switch becomes a rewrite, not a configuration change. Bundle weight (~12 KB gzipped extra, measured 2026-05-04) is a minor supporting consideration, not the lead.

### Custom UI talking directly to Cognito (`amazon-cognito-identity-js`)

Build login / signup / MFA / password-reset forms in-portal, talking to Cognito's SRP / SDK APIs. **Rejected** for the security-sensitive-reimplementation reason in § Why Hosted UI. The portfolio signal is "I picked the AWS-native pattern," not "I built a login form."

### Defer auth entirely to Phase 3 or later

Continue using the synthetic test user + `mint-test-token` helper through Phase 2. **Rejected** because subphase 2.5 (auth) in the Phase 2 sequencing plan commits to swapping the helper for production-shape auth before Phase 2 closes. Without auth, the deployed portal is unusable to anyone but the operator — the demo-mode work in subphase 2.6 then carries the entire visitor-facing surface, which is the wrong default. Auth at 2.5 lets demo mode be additive, not load-bearing.

### `localStorage` instead of `sessionStorage` (covered above)

Persist token across tab close. **Rejected as default** for the security-posture reason in § Why sessionStorage; revisitable via a "remember me" toggle if UX feedback warrants.

## When to reconsider

**Switch from `sessionStorage` to `localStorage`:**
- User feedback says the tab-close-clears-session behavior is friction.
- A multi-device "stay signed in" feature lands.

**Switch from `oidc-client-ts` to `aws-amplify/auth`:**
- A second AWS service the portal directly integrates with (Pinpoint analytics, AppSync, etc.) lands and Amplify provides meaningful integration over assembling pieces. Unlikely.
- Custom Cognito advanced-security features need first-class library support that `oidc-client-ts` does not expose.

**Switch from Hosted UI to custom UI:**
- Branding requirements exceed what Hosted UI's CSS editor supports (typography control, layout rework, multi-step custom flows).
- Multi-tenant per-tenant theming becomes a requirement (Hosted UI's per-app-client theming may or may not suffice).

**Add NextAuth / Auth.js:**
- Server-side per-user data fetching becomes a meaningful pattern (e.g., Server Components needing user identity for personalized rendering).
- Cookie-based session becomes preferable for CSRF / audit reasons.

**Multi-tenant token-claim shape change:**
- Today: single tenant, `aud` claim = the app client ID, no per-tenant claim.
- Future multi-tenant: would require either (a) a custom claim added via a Cognito Pre-Token-Generation Lambda trigger, or (b) per-tenant app clients with separate Hosted UI domains. Defer until multi-tenancy is on the roadmap; the API-side authorizer would need a claim-validation update at the same time.

## Pre-implementation tasks

One-time setup that happens during subphase 2.5 (auth):

1. **Update the Cognito app client URL allowlist** via terraform — `infra/modules/cognito/main.tf` defines `aws_cognito_user_pool_client "this"` with `for_each = var.clients`, so callback / logout URL changes flow through the per-env tfvars in `infra/envs/<env>/`:
   - `callback_urls`: `["http://localhost:3000/auth/callback", "https://ironforge.rickycaballero.com/auth/callback"]`
   - `logout_urls`: `["http://localhost:3000/", "https://ironforge.rickycaballero.com/"]`
   - Remove the existing NextAuth-pattern URL (`/api/auth/callback/cognito`) — it is not used by oidc-client-ts and a tighter allowlist is good security posture.
2. **Theme Hosted UI** via Cognito console's Hosted UI customization (logo, primary color, button styles).
3. **Verify refresh-token grant works end-to-end** — sign in, wait past 30 minutes (or force-expire by adjusting `AccessTokenValidity` temporarily for testing), confirm silent renewal succeeds without redirect.

## Related

- **ADR-007** — CI boundary asymmetry. Cognito user pool + app client are CI-provisioned via `infra/modules/cognito/`; URL allowlist updates flow through CI's terraform plan / apply against the per-env tfvars.
- **CLAUDE.md § Authentication** — the existing JWT validation contract: API Gateway HTTP API JWT authorizer for signature / `iss` / `aud` / `exp`; in-Lambda middleware validates `token_use === "access"`. ADR-010 ensures the portal passes access (not ID) tokens.
- **`services/api/src/middleware/`** — token-use validator that consumes the access token this ADR specifies.
- **`apps/web/lib/api-client/`** — the typed API client (subphase 2.2) reads the `oidc-client-ts` `UserManager`'s current access token and injects it as Bearer on every request.
- **`packages/shared-types/`** — the user-claim Zod schema (if added) lives here for type-sharing with the API.
- **`docs/runbook.md` § Synthetic test user** — the `mint-test-token` SRP-flow dev helper stays in place for backend testing; ADR-010 governs the production portal flow only.

## Amendments

### 2026-05-06 (PR-G) — Subphase 2.3 ships as single-step `CreateServiceForm` at single-template scope; refactors to multi-step wizard when template #2 introduces non-trivial inputs

**What was changed.** ADR-010 § "the auth flow lands across four authenticated surfaces in Phase 2 — service catalog (subphase 2.1), service-detail with DELETE (2.2), multi-step wizard (2.3), and real-time progress polling on the detail page (2.4)" framed 2.3 as a "multi-step wizard." 2.3 ships in PR-G as a **single-step `CreateServiceForm`**. Component naming reflects current scope (`CreateServiceForm`, not `CreateServiceWizard` or `WizardStep1`); future multi-step expansion is a refactor with a clear trigger.

**Why.** Empirical state at PR-G time: `StaticSiteInputsSchema = z.object({}).strict()` per `packages/shared-types/src/templates/static-site.ts`. The static-site template has zero user inputs beyond the service `name` (which lives on the Service entity, not in template inputs). The comment at the source is explicit: "MVP intentionally has zero inputs… substantive future inputs (custom domain mapping, privacy mode) are real platform features added when the platform supports them." A multi-step wizard for static-site would have a dead inputs step ("no additional inputs needed") — user-hostile UX in service of infrastructure for hypothetical future templates.

**The original framing wasn't wrong; it just assumed a future state that didn't materialize.** A multi-step wizard is the correct shape for an IDP supporting multiple templates with varied input shapes. At single-template-with-zero-inputs scope, the multi-step shape is YAGNI per CLAUDE.md § "Anti-Patterns" ("Building a generic plugin system before the second template exists. No. YAGNI. Build for the static-site template. When the second template arrives, refactor."). When template #2 introduces non-trivial inputs, the single-step `CreateServiceForm` refactors into a multi-step wizard at that point — and the original framing in this ADR becomes correct.

**What this preserves.** Every other Phase 2 sequencing decision survives untouched: 2.1 catalog (shipped #116), 2.2 detail + DELETE (shipped #114 + #115), 2.4 polling, 2.5 auth, 2.6 demo. 2.3's user-funnel role (provisioning kickoff entry) is fully delivered by the single-step form — `name + templateId="static-site" + inputs={}` is the complete payload to `POST /api/services`, validated against `CreateServiceRequestSchema` which supports the request shape unchanged.

**Component-naming companion lesson.** Captured at `feedback_naming_reflects_current_scope.md`: name for what the code IS today, not what it MIGHT BECOME. Aspirational naming (`CreateServiceWizard` for a single-step form) makes the code lie about current behavior; honest naming makes future expansion a clean refactor with a clear trigger.

**Tracked.** This amendment documents the framing correction in-place, per `docs/conventions.md § "ADR/tech-debt empirical claims require verification"`. Empirical claims in design docs are checked against reality before committing UI complexity; when reality contradicts framing, the amendment captures the correction.

### 2026-05-07 (PR-B) — Three refinements landed during 2.5 implementation

**1. Redirect URIs computed from `window.location.origin`, not env-baked.**

ADR-010 § Pre-implementation listed the callback / logout URLs explicitly per env. PR #123 (PR-A infra prep) set them in the Cognito allowlist accordingly. PR-B's UserManager config takes the cleaner shape:

```ts
redirect_uri: `${window.location.origin}/auth/callback`,
post_logout_redirect_uri: `${window.location.origin}/`,
```

Same JS bundle works at `localhost:3000` and the prod domain — no rebuild required for env-shape parity. Reduces the build-arg surface from four env vars to three (authority, client_id, API base URL). The trailing-slash on `post_logout_redirect_uri` matches PR-A's allowlist exactly per the contract documented in PR #123.

**2. Hosted UI theming deferred to subphase 2.6 (demo polish), not done between PR-A and PR-B.**

ADR-010 § Pre-implementation step #2 ("Theme Hosted UI via Cognito console") was originally framed as a between-PR-A-and-PR-B step (and `docs/runbook.md § 16` documents the procedure for that timing). Empirically: theming's audience is real users polishing demo experience; PR-B verification works functionally with unstyled Hosted UI. Deferring to 2.6 (demo-mode polish) batches it with the other portfolio-polish work where the audience and aesthetic effort align. PR-A's runbook section stays in place; the procedure is documented for whenever it's exercised. No ADR-010 commitment is broken — the manual step still happens before any external demo audience.

**3. NEXT_PUBLIC_* env vars threaded via Docker `--build-arg`, sourced from repo `vars`.**

The portal builds in CI via a multi-stage Docker build; `next build` reads `NEXT_PUBLIC_*` from `process.env` at build time and inlines the values into the client JS bundle. Three options were considered:

- (a) `--build-arg` in CI workflow, declared as `ARG` in Dockerfile, re-exported as `ENV` before `next build` — chosen
- (b) CI generates `apps/web/.env.production` (gitignored) before the docker build
- (c) Hardcode dev values in the Dockerfile as `ARG` defaults; defer env-split

Option (a) keeps the Dockerfile env-agnostic (no committed env-specific defaults) and keeps the CI workflow as the single source of truth for per-env config. Repo `vars` (not `secrets`) hold the values: the Cognito client_id, OIDC authority URL, and API Gateway URL are all non-sensitive (public Cognito client_ids designed for browser use; API Gateway URL discoverable from any deployed asset). `secrets` would be misleading.

**Tracked:** ADR-010's original "Pre-implementation tasks" list captures the ideal sequence; this amendment captures the empirical choices made during PR-B implementation. Future-you running 2.5 against another env: build-args are the integration point, not env-baked redirects.

import { UserManager, WebStorageStateStore } from "oidc-client-ts";

// Browser-only OIDC client. Lazy-instantiates on first call so server-
// side rendering and Node-side imports don't blow up trying to read
// `window` / `sessionStorage`.
//
// Config sources:
//   - Authority + client_id come from build-time env (NEXT_PUBLIC_*) so
//     the bundle is env-specific. The authority URL drives OIDC discovery
//     for endpoints (authorization, token, end_session, userinfo); we
//     don't have to hardcode any of those.
//   - redirect_uri + post_logout_redirect_uri are computed at runtime
//     from window.location.origin, so the same JS bundle works at
//     localhost:3000 and the prod domain. Build-arg threading stays at
//     three vars instead of four.
//   - sessionStorage (per ADR-010); cleared on tab close. Refresh-token
//     grant + automaticSilentRenew handle the tab-open lifetime.
//
// The post_logout_redirect_uri trailing slash is load-bearing: Cognito
// allowlists logout URLs as exact-match strings, and PR #123 set
// logout_urls with a trailing slash for both dev + prod clients.

let _manager: UserManager | null = null;

const requireEnv = (name: "NEXT_PUBLIC_COGNITO_AUTHORITY" | "NEXT_PUBLIC_COGNITO_CLIENT_ID"): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} not set at build time. Configure as a Docker --build-arg in CI (.github/workflows/app-deploy.yml) and in apps/web/.env.local for local dev.`,
    );
  }
  return value;
};

export const getUserManager = (): UserManager => {
  if (typeof window === "undefined") {
    throw new Error(
      "getUserManager() called from server-side context. UserManager is browser-only — call from a client component or inside useEffect.",
    );
  }
  if (_manager === null) {
    _manager = new UserManager({
      authority: requireEnv("NEXT_PUBLIC_COGNITO_AUTHORITY"),
      client_id: requireEnv("NEXT_PUBLIC_COGNITO_CLIENT_ID"),
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/`,
      response_type: "code",
      scope: "openid email profile",
      // Refresh the access token via the refresh-token grant ahead of
      // expiry. Cognito's 30-min access lifetime + 30-day refresh window
      // gives "log in once, stay logged in for a tab session, plus
      // ~30-day Cognito session for re-login without credentials."
      automaticSilentRenew: true,
      userStore: new WebStorageStateStore({ store: window.sessionStorage }),
      // signoutRedirect() relies on the OIDC discovery doc's
      // end_session_endpoint, which Cognito populates pointing at its
      // Hosted UI /logout endpoint. id_token_hint is sent automatically
      // from the stored id_token (we request scope=openid which gets
      // us one). post_logout_redirect_uri matches the allowlist set in
      // PR #123 (trailing slash); together this completes Cognito's
      // OIDC-shaped logout without needing the Cognito domain as a
      // separate env var.
    });
  }
  return _manager;
};

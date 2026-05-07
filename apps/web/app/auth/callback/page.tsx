"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getUserManager } from "@/lib/auth/user-manager";

// Cognito Hosted UI redirects here after sign-in; oidc-client-ts's
// signinRedirectCallback() consumes the authorization code from the URL,
// exchanges it for tokens at Cognito's token endpoint, and stores the
// User in sessionStorage. We then push to "/" (or a stored intended
// path, future enhancement).
//
// Errors visible at this layer: Cognito-side (state mismatch, expired
// code) and network. Both surface as "couldn't sign you in" with the
// underlying message; the user can retry from the home page.

export default function AuthCallbackPage(): React.ReactNode {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        await getUserManager().signinRedirectCallback();
        router.replace("/");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      }
    })();
    // router is stable; effect runs once on mount
  }, [router]);

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-md px-6 py-24">
        {error === null ? (
          <p className="text-sm text-muted-foreground">Completing sign-in…</p>
        ) : (
          <Alert variant="destructive">
            <AlertTitle>Sign-in failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}

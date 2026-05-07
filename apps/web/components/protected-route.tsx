"use client";

import Link from "next/link";
import { useEffect, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth/auth-provider";

// Client-side gate around routes that require authentication. Wraps
// the protected page content; on mount, if there's no user and we're
// not still loading initial state, kicks off the Cognito redirect
// flow. While loading or pending redirect, shows a skeleton — never
// flashes protected content to unauthenticated users.
//
// Why client-side: tokens live in sessionStorage (per ADR-010), so
// Next.js middleware can't see them and can't gate server-side. The
// trade-off is a brief skeleton flash on first load; acceptable for
// portfolio-scope (and the same trade-off NextAuth + many SPA auth
// patterns make).
//
// Auth-unavailable degradation: when AuthProvider couldn't initialize
// the UserManager (Cognito NEXT_PUBLIC_* missing — local dev with
// stale .env.local, or a deploy where build-args weren't threaded),
// `isAvailable` is false. We render an Alert linking to /demo
// instead of calling signIn() — calling it would re-throw with
// "auth not configured" and surface as an uncaught promise rejection,
// while doing nothing useful for the visitor (the redirect target
// would 404 too). The escape hatch to /demo lets a visitor still
// reach the demo surface even when auth is misconfigured.

export function ProtectedRoute({ children }: { children: ReactNode }): ReactNode {
  const { user, isLoading, isAvailable, signIn } = useAuth();

  useEffect(() => {
    if (!isAvailable) return;
    if (!isLoading && user === null) {
      void signIn();
    }
  }, [user, isLoading, isAvailable, signIn]);

  if (!isAvailable) {
    return (
      <main className="min-h-screen">
        <div className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
          <Alert variant="destructive">
            <AlertTitle>Sign-in unavailable</AlertTitle>
            <AlertDescription>
              The portal's authentication isn't configured for this deployment.
              You can still explore the platform via{" "}
              <Link href="/demo" className="underline font-medium">
                the demo
              </Link>
              .
            </AlertDescription>
          </Alert>
        </div>
      </main>
    );
  }

  if (isLoading || user === null) {
    return (
      <main className="min-h-screen">
        <div className="mx-auto max-w-2xl px-6 py-16 sm:py-24 space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-64" />
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

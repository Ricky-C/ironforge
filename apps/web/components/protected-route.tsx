"use client";

import { useEffect, type ReactNode } from "react";

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

export function ProtectedRoute({ children }: { children: ReactNode }): ReactNode {
  const { user, isLoading, signIn } = useAuth();

  useEffect(() => {
    if (!isLoading && user === null) {
      void signIn();
    }
  }, [user, isLoading, signIn]);

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

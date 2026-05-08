"use client";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/auth-provider";

// Top-right floating auth control. Shows "Sign in" when no user; user
// email + "Sign out" when authenticated. Floats absolutely so existing
// page layouts (home / services / detail / wizard) don't have to make
// room for it.
//
// Sign-in click triggers Cognito Hosted UI redirect; user lands back
// at /auth/callback, which router-pushes to /. Sign-out triggers
// signoutRedirect → Cognito's /logout → post_logout_redirect_uri (/)
// → user is back at the home page, signed out.

export function AuthHeader(): React.ReactNode {
  const { user, isLoading, isAvailable, signIn, signOut } = useAuth();

  if (isLoading) {
    return null;
  }

  // Auth machinery offline (Cognito NEXT_PUBLIC_* build-args missing).
  // Demo paths still work; rendering no Sign-in button avoids handing
  // the visitor a control that errors on click. Production paths in
  // this state are misconfigured — operator surfaces the issue via
  // the console warning AuthProvider logs.
  if (!isAvailable) {
    return null;
  }

  const email = user?.profile.email;

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-3">
      {user === null ? (
        <Button size="sm" onClick={() => void signIn()}>
          Sign in
        </Button>
      ) : (
        <>
          {email !== undefined ? (
            <span className="hidden max-w-[14rem] truncate text-sm text-muted-foreground sm:inline">
              {email}
            </span>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      )}
    </div>
  );
}

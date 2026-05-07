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
  const { user, isLoading, signIn, signOut } = useAuth();

  if (isLoading) {
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
            <span className="text-sm text-muted-foreground">{email}</span>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      )}
    </div>
  );
}

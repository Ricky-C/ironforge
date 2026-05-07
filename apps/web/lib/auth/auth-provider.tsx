"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "oidc-client-ts";

import { getUserManager } from "./user-manager";

// Auth state propagation via React context. Hooks into oidc-client-ts's
// UserManager event lifecycle so consumers re-render on user load,
// silent-renew, and signout.
//
// `isLoading` covers two distinct states: (1) the initial getUser()
// resolve, (2) the iframe-based silent renew. Consumers can render a
// loading shell during (1); (2) is invisible because the prior user
// stays in state until the renew completes.
//
// Auth-unavailable posture: when the Cognito NEXT_PUBLIC_* build-args
// aren't set (local dev with missing .env.local, or a deploy where
// build-args weren't threaded), getUserManager() throws. AuthProvider
// catches that and degrades gracefully: `user` stays null, `isLoading`
// resolves false, sign-in/out attempts re-throw with the original
// helpful message. This keeps unauthenticated paths (subphase 2.6
// `/demo/*`) functional even when auth machinery is broken — visitors
// browsing the demo never depend on the auth surface working.

type AuthState = {
  user: User | null;
  isLoading: boolean;
  isAvailable: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAvailable, setIsAvailable] = useState(true);

  useEffect(() => {
    let manager;
    try {
      manager = getUserManager();
    } catch (err) {
      // Cognito env vars missing → auth machinery is offline. Demo
      // paths continue to work; production paths render a non-
      // functional Sign-in button (clicking it surfaces the original
      // error in the console). Per docs/runbook.md / .env.example —
      // ensure NEXT_PUBLIC_COGNITO_AUTHORITY + _CLIENT_ID are set in
      // apps/web/.env.local (local dev) or threaded via Docker
      // --build-arg (CI build).
      console.warn("Auth unavailable:", err);
      setIsAvailable(false);
      setIsLoading(false);
      return;
    }

    void manager.getUser().then((current) => {
      setUser(current);
      setIsLoading(false);
    });

    const onUserLoaded = (loaded: User): void => {
      setUser(loaded);
    };
    const onUserUnloaded = (): void => {
      setUser(null);
    };
    const onSilentRenewError = (error: Error): void => {
      console.error("oidc silent renew failed", error);
      setUser(null);
    };

    manager.events.addUserLoaded(onUserLoaded);
    manager.events.addUserUnloaded(onUserUnloaded);
    manager.events.addSilentRenewError(onSilentRenewError);

    return () => {
      manager.events.removeUserLoaded(onUserLoaded);
      manager.events.removeUserUnloaded(onUserUnloaded);
      manager.events.removeSilentRenewError(onSilentRenewError);
    };
  }, []);

  const signIn = async (): Promise<void> => {
    // Re-throws with the original helpful message if auth wasn't
    // configured at module-load time. UI consumers (AuthHeader)
    // gate the click via isAvailable so this throw is unreachable
    // in practice — defense-in-depth for unexpected callers.
    await getUserManager().signinRedirect();
  };

  const signOut = async (): Promise<void> => {
    await getUserManager().signoutRedirect();
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, isAvailable, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

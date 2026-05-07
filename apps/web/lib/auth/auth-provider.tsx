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

type AuthState = {
  user: User | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const manager = getUserManager();

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
    await getUserManager().signinRedirect();
  };

  const signOut = async (): Promise<void> => {
    await getUserManager().signoutRedirect();
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signOut }}>
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

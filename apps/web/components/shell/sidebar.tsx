"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Home,
  Layers,
  LogIn,
  LogOut,
  PlayCircle,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/auth-provider";
import { cn } from "@/lib/utils";

// App sidebar — left chrome rail, app-wide on user-destination routes
// (see app/(shell)/layout.tsx for the route gate). Auth-aware footer:
// signed-in users see avatar + email + Sign out; unauthenticated users
// see a Sign in button. Active-state highlighting derived from
// usePathname.
//
// Nav items reflect ONLY working routes — no aspirational placeholders.
// Per the project's "naming reflects current scope" convention,
// disabled "Audit log" / "Teams" / etc. items would lie about scope.
// External Documentation link points at the GitHub repo's docs/ folder
// (where ADRs and the runbook live) — substantive destination, honest
// about what we have today.

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/services", label: "Services", icon: Layers },
  { href: "/services/new", label: "New service", icon: Plus },
  { href: "/demo", label: "Demo", icon: PlayCircle },
];

const DOCS_URL = "https://github.com/Ricky-C/ironforge/tree/main/docs";

// Active-state matching is item-specific because /services/new is a
// sibling-of-prefix to /services. Without the explicit exclusion,
// being on /services/new would highlight BOTH "Services" and "New
// service." Hardcoded here against the four-item nav — if the nav
// grows, generalize to a priority-match scheme.
function isActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/services/new") return pathname === "/services/new";
  if (href === "/services") {
    return (
      (pathname === "/services" || pathname.startsWith("/services/")) &&
      pathname !== "/services/new"
    );
  }
  if (href === "/demo") {
    return pathname === "/demo" || pathname.startsWith("/demo/");
  }
  return pathname === href;
}

export function Sidebar(): React.ReactNode {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-screen flex-col border-r border-sidebar-border bg-sidebar">
      <BrandBlock />

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <SectionLabel>Platform</SectionLabel>
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavItemLink item={item} active={isActive(item.href, pathname)} />
            </li>
          ))}
        </ul>

        <div className="mt-4">
          <SectionLabel>Resources</SectionLabel>
          <ul className="flex flex-col gap-0.5">
            <li>
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-normal text-muted-foreground transition-colors",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <BookOpen className="size-4 shrink-0 text-fg-subtle" />
                <span>Documentation</span>
              </a>
            </li>
          </ul>
        </div>
      </nav>

      <SidebarFooter />
    </aside>
  );
}

function BrandBlock(): React.ReactNode {
  return (
    <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-md text-[12px] font-bold tracking-tight text-primary-foreground"
        style={{
          background:
            "linear-gradient(135deg, oklch(0.62 0.22 17), oklch(0.45 0.18 17))",
        }}
      >
        IF
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-tight">Ironforge</div>
        <div className="text-[11px] leading-tight text-fg-subtle">
          self-service IDP
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <div className="px-2 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-fg-faint">
      {children}
    </div>
  );
}

function NavItemLink({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}): React.ReactNode {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "font-normal text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-fg-subtle",
        )}
      />
      <span>{item.label}</span>
    </Link>
  );
}

function SidebarFooter(): React.ReactNode {
  // Auth state branches: loading shows nothing (avoids layout flicker
  // during initial Cognito callback restoration); offline (env vars
  // missing) shows a static placeholder so demo paths still surface
  // a sidebar even with auth machinery down; signed-out shows a Sign-in
  // button; signed-in shows email + Sign out.
  const { user, isLoading, isAvailable, signIn, signOut } = useAuth();

  if (isLoading) {
    return <div className="h-[57px] border-t border-sidebar-border" aria-hidden="true" />;
  }

  if (!isAvailable) {
    return (
      <div className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5">
        <div className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] text-muted-foreground">
          ?
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-fg-subtle">Auth offline</div>
        </div>
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-2.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void signIn()}
          className="w-full"
        >
          <LogIn className="size-3.5" />
          Sign in
        </Button>
      </div>
    );
  }

  const email = user.profile.email;
  const initials = email !== undefined ? email.slice(0, 2).toUpperCase() : "??";

  return (
    <div className="flex items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5">
      <div
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
        style={{
          background:
            "linear-gradient(135deg, oklch(0.5 0.15 280), oklch(0.5 0.15 200))",
        }}
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        {email !== undefined ? (
          <div className="truncate text-[12px] font-medium" title={email}>
            {email}
          </div>
        ) : (
          <div className="text-[12px] text-fg-subtle">Signed in</div>
        )}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => void signOut()}
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="size-3.5" />
      </Button>
    </div>
  );
}

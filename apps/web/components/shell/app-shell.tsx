import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";

// App shell — sidebar + topbar wrapping page content. Mounted by the
// (shell) route group's layout (apps/web/app/(shell)/layout.tsx); does
// not appear on utility routes like /auth/callback.
//
// Mobile (<lg, <1024px): sidebar collapses; users get a single-column
// view with a slim topbar. PR-2 ships the desktop two-column shell
// + a single-column collapse on mobile (sidebar simply hides). A
// hamburger drawer is deferred to a follow-up — stationary mobile
// users primarily land via the demo public flow, where the catalog
// + detail surfaces are the load-bearing experience anyway, not nav.

export function AppShell({ children }: { children: React.ReactNode }): React.ReactNode {
  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[248px_1fr]">
      <div className="hidden lg:block">
        <Sidebar />
      </div>
      <div className="flex min-w-0 flex-col">
        <TopBar />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}

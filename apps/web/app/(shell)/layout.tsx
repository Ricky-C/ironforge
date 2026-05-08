import { AppShell } from "@/components/shell/app-shell";

// Route-group layout that mounts the AppShell on user-destination
// routes (/, /services/*, /demo/*). Utility routes outside the
// (shell) group — currently /auth/callback and /api/* — render
// without the shell.
//
// Audit gate (per PR-2 sequencing convention): any new top-level
// route in apps/web/app/ should be classified as either a user
// destination (place under (shell)/) or a utility route (place at
// the app/ root). Utility routes deserve a brief comment justifying
// their no-shell status when added.

export default function ShellLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return <AppShell>{children}</AppShell>;
}

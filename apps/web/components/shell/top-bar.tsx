"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

// App top bar — sticky header inside the shell main column. Renders
// breadcrumbs derived from pathname; segments are humanized and dynamic
// values (UUIDs) are truncated to first 8 chars. The breadcrumb chain
// is always rooted at "Home" (`/`).
//
// PR-2 keeps the topbar minimal — breadcrumbs only. The design's search
// input + ⌘K kbd hint + notifications are intentionally deferred:
// non-functional chrome lies about scope (per "naming reflects current
// scope" — applies at the chrome level too). They land when the
// underlying features ship, not before.

type Crumb = {
  label: string;
  href?: string;
};

function deriveBreadcrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }];
  if (pathname === "/") return crumbs;

  const segments = pathname.split("/").filter(Boolean);
  let acc = "";
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] as string;
    acc += `/${seg}`;
    const isLast = i === segments.length - 1;
    crumbs.push({
      label: humanize(seg),
      ...(isLast ? {} : { href: acc }),
    });
  }
  return crumbs;
}

// Per-segment humanization. UUIDs render as their first 8 chars + "…"
// so the breadcrumb stays scannable; "new" capitalizes; everything
// else stays lowercase since service names are lowercase by convention.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function humanize(seg: string): string {
  if (UUID_RE.test(seg)) return `${seg.slice(0, 8)}…`;
  if (seg === "new") return "New";
  if (seg === "demo") return "Demo";
  if (seg === "services") return "Services";
  return seg;
}

export function TopBar(): React.ReactNode {
  const pathname = usePathname();
  const crumbs = deriveBreadcrumbs(pathname);

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-[13px]">
        <ol className="flex flex-wrap items-center gap-1.5">
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <li key={`${c.href ?? c.label}-${i}`} className="flex items-center gap-1.5">
                {i > 0 ? (
                  <ChevronRight
                    className="size-3.5 text-fg-faint"
                    aria-hidden="true"
                  />
                ) : null}
                {c.href !== undefined && !isLast ? (
                  <Link
                    href={c.href}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span
                    className={isLast ? "font-medium text-foreground" : "text-muted-foreground"}
                    aria-current={isLast ? "page" : undefined}
                  >
                    {c.label}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </header>
  );
}

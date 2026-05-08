"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  Globe,
  Layers,
  Rocket,
  Trash2,
  Zap,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAuth } from "@/lib/auth/auth-provider";
import { cn } from "@/lib/utils";
import type { ServiceListResponse } from "@ironforge/shared-types";
import type { ListServicesParams } from "@/lib/api-client";

// Shared landing surface. Mounted by:
//   - app/(shell)/page.tsx          (variant="production"; production apiClient)
//   - app/(shell)/demo/page.tsx     (variant="demo"; demo apiClient)
//
// What the variant controls:
//   - eyebrow chip ("Public demo · read-only" on demo only)
//   - hero CTAs (signed-out production redirects to demo; signed-in
//     production hits /services routes; demo always hits /demo/services)
//   - "Try it" action cards (demo links at the three static services
//     with known statuses; production cards open auth-gated routes
//     and a demo escape hatch)
//
// Counts in the KPI strip come from listServices' first page only —
// portfolio scope (0–5 services typical) makes the lie acceptable. If
// the KPI ever needs to be exact, add a dedicated `/services/count`
// endpoint and switch this query.

type LandingClient = {
  listServices: (params?: ListServicesParams) => Promise<ServiceListResponse>;
};

type Variant = "production" | "demo";

export function LandingContent({
  variant,
  apiClient,
  basePath,
}: {
  variant: Variant;
  apiClient: LandingClient;
  basePath: string;
}): React.ReactNode {
  const auth = useAuth();
  const signedIn = auth.user !== null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 sm:py-12">
      <Hero variant={variant} basePath={basePath} signedIn={signedIn} signIn={auth.signIn} />

      <KpiStrip
        variant={variant}
        apiClient={apiClient}
        signedIn={signedIn}
        basePath={basePath}
      />

      <FeatureGrid />

      <ActionGrid variant={variant} basePath={basePath} />
    </div>
  );
}

// ===== Hero =====
// Two-tone radial gradients (rose top-right, violet bottom-left) over a
// muted grid pattern with a centered ellipse mask. Inline styles because
// Tailwind utilities can't express the layered backgrounds + mask
// cleanly; the values are stable per the design tokens. If accent-color
// theming returns post-PR, these get refactored to CSS custom-property
// references.

function Hero({
  variant,
  basePath,
  signedIn,
  signIn,
}: {
  variant: Variant;
  basePath: string;
  signedIn: boolean;
  signIn: () => Promise<void>;
}): React.ReactNode {
  const isDemo = variant === "demo";
  // Production CTAs branch on auth state. Signed-out users get pushed
  // toward the demo and the sign-in button, since /services is gated.
  // Signed-in users get the same pair as the demo path (provision +
  // catalog), just at the production basePath.
  const primaryCta =
    isDemo || signedIn
      ? { href: `${basePath}/new`, label: "Provision a service", icon: <Zap className="size-4" /> }
      : null;
  const secondaryCta =
    isDemo || signedIn
      ? { href: basePath, label: "View catalog", icon: null }
      : { href: "/demo", label: "View the demo", icon: null };

  return (
    <section
      className="relative overflow-hidden rounded-2xl border p-8 sm:p-12"
      style={{
        background: [
          "radial-gradient(800px 400px at 90% -10%, oklch(0.62 0.22 17 / 0.12), transparent 50%)",
          "radial-gradient(600px 300px at 0% 110%, oklch(0.5 0.15 280 / 0.1), transparent 60%)",
          "var(--card)",
        ].join(", "),
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          backgroundPosition: "-1px -1px",
          maskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 70%)",
        }}
      />

      <div className="relative">
        {isDemo ? (
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11.5px] font-medium uppercase tracking-[0.08em] text-primary">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-primary"
              style={{ boxShadow: "0 0 6px var(--primary)" }}
            />
            Public demo · read-only
          </div>
        ) : null}

        <h1 className="max-w-[18ch] text-4xl font-semibold leading-[1.1] tracking-[-0.025em] sm:text-5xl">
          A self-service developer platform for AWS.
        </h1>

        <p className="mt-3.5 max-w-[60ch] text-[15px] text-muted-foreground">
          Ironforge provisions production-ready static sites — S3 +
          CloudFront + Route53 + IAM — from a single name. GitHub repo,
          TLS, and CI/CD pipeline included.{" "}
          {isDemo ? (
            <>Tour the demo to watch the workflow play out in ~30 seconds.</>
          ) : signedIn ? (
            <>Click through to provision your next site, or open the catalog.</>
          ) : (
            <>Try the demo, or sign in to provision your own.</>
          )}
        </p>

        <div className="mt-6 flex flex-wrap gap-2.5">
          {primaryCta !== null ? (
            <Link
              href={primaryCta.href}
              className={cn(buttonVariants({ size: "lg" }))}
            >
              {primaryCta.icon}
              {primaryCta.label}
            </Link>
          ) : (
            <Button size="lg" onClick={() => void signIn()}>
              Sign in
            </Button>
          )}
          <Link
            href={secondaryCta.href}
            className={cn(buttonVariants({ variant: "outline", size: "lg" }))}
          >
            {secondaryCta.label}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}

// ===== KPI Strip =====
// Renders a 3-stat panel under the hero. Demo always has data (3 static
// services); production shows the strip only for signed-in users since
// /services data isn't accessible otherwise. Counts come from the
// first listServices page — see the comment at the top of this file.

function KpiStrip({
  variant,
  apiClient,
  signedIn,
  basePath,
}: {
  variant: Variant;
  apiClient: LandingClient;
  signedIn: boolean;
  basePath: string;
}): React.ReactNode {
  const enabled = variant === "demo" || signedIn;
  const query = useQuery({
    queryKey: ["landing-kpi", basePath],
    queryFn: () => apiClient.listServices(),
    enabled,
  });

  if (!enabled) return null;

  const services = query.data?.items ?? [];
  const total = services.length;
  const live = services.filter((s) => s.status === "live").length;
  const livePct = total === 0 ? null : Math.round((live / total) * 100);

  return (
    <section className="mt-6 overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">
          {variant === "demo" ? "What's running in this demo" : "Your services"}
        </h2>
        <Link
          href={basePath}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Open catalog
          <ArrowRight className="size-3.5" />
        </Link>
      </header>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <Stat
          label="Services"
          value={query.isPending ? "—" : String(total)}
          sub={query.isPending ? "loading…" : `${total === 1 ? "service" : "services"} total`}
        />
        <Stat
          label="Live"
          value={query.isPending ? "—" : String(live)}
          sub={livePct === null ? "—" : `${livePct}% healthy`}
          bordered
        />
        <Stat label="Templates" value="1" sub="static-site" bordered />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  bordered,
}: {
  label: string;
  value: string;
  sub: string;
  bordered?: boolean;
}): React.ReactNode {
  return (
    <div className={cn("px-5 py-4", bordered && "sm:border-l")}>
      <div className="text-[11px] font-medium uppercase tracking-[0.05em] text-fg-subtle">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// ===== Feature Grid =====
// Three feature cards summarizing the platform's pillars. Static copy
// since these are platform-level facts, not data-driven. Icons use
// lucide; the icon container picks up the rose accent via primary
// token.

function FeatureGrid(): React.ReactNode {
  return (
    <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
      <Feature
        icon={<Zap className="size-4" />}
        title="Self-service in a Step Function"
        body="Eight-step workflow — validate → repo → code → terraform → CloudFront → deploy → finalize. No tickets."
      />
      <Feature
        icon={<Layers className="size-4" />}
        title="Catalog of what you own"
        body="One row per service. Status, live URL, owner, and provisioning lineage at a glance — no spreadsheets."
      />
      <Feature
        icon={<Trash2 className="size-4" />}
        title="Clean teardown"
        body="Deprovision destroys infra, repo, and DNS in three steps. Nothing is left dangling in your AWS bill."
      />
    </section>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactNode {
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="grid size-7 place-items-center rounded-md border bg-surface-2 text-primary">
        {icon}
      </div>
      <h3 className="mt-2.5 text-[13.5px] font-semibold">{title}</h3>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-muted-foreground">{body}</p>
    </article>
  );
}

// ===== Action Grid =====
// Three "Try it" cards. Demo path links to the three static demo
// services with their known statuses (so visitors can immediately
// see live / triage failure / inspect provisioning UI). Production
// path swaps to action-oriented destinations + a demo escape hatch.

const DEMO_LIVE_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_FAILED_ID = "33333333-3333-4333-8333-333333333333";

function ActionGrid({
  variant,
  basePath,
}: {
  variant: Variant;
  basePath: string;
}): React.ReactNode {
  const cards =
    variant === "demo"
      ? [
          {
            href: `${basePath}/new`,
            title: "Provision a service",
            body: "Watch the 8-step state machine run end-to-end in ~20 seconds.",
            icon: <Rocket className="size-4" />,
            primary: true,
          },
          {
            href: `${basePath}/${DEMO_LIVE_ID}`,
            title: "Inspect a live service",
            body: "Open marketing-site to see metadata, live URL, and workflow lineage.",
            icon: <Globe className="size-4" />,
          },
          {
            href: `${basePath}/${DEMO_FAILED_ID}`,
            title: "Triage a failure",
            body: "docs failed at deploy — see the failure reason and retry path.",
            icon: <AlertTriangle className="size-4" />,
          },
        ]
      : [
          {
            href: `${basePath}/new`,
            title: "Provision a service",
            body: "Walk through the wizard. Eight-step workflow runs in ~5 minutes.",
            icon: <Rocket className="size-4" />,
            primary: true,
          },
          {
            href: basePath,
            title: "Open the catalog",
            body: "See every service you've provisioned. Status, live URL, lineage.",
            icon: <Layers className="size-4" />,
          },
          {
            href: "/demo",
            title: "Tour the public demo",
            body: "Read-only walkthrough — same surfaces, no auth, mocked data.",
            icon: <Globe className="size-4" />,
          },
        ];

  return (
    <section className="mt-8">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold">Try it</h2>
        <span className="text-xs text-fg-subtle">3 actions</span>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <ActionCard key={c.href + c.title} {...c} />
        ))}
      </div>
    </section>
  );
}

function ActionCard({
  href,
  title,
  body,
  icon,
  primary,
}: {
  href: string;
  title: string;
  body: string;
  icon: React.ReactNode;
  primary?: boolean;
}): React.ReactNode {
  return (
    <Link
      href={href}
      className={cn(
        "group block rounded-lg border bg-card p-4 transition-colors",
        "hover:border-border-strong hover:bg-accent",
      )}
    >
      <div
        className={cn(
          "grid size-7 place-items-center rounded-md border",
          primary
            ? "border-primary/30 bg-primary/10 text-primary"
            : "bg-surface-2 text-primary",
        )}
      >
        {icon}
      </div>
      <h3 className="mt-2.5 text-[13.5px] font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      <div
        className={cn(
          "mt-2.5 inline-flex items-center gap-1 text-xs font-medium",
          primary ? "text-primary" : "text-muted-foreground",
        )}
      >
        Open
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

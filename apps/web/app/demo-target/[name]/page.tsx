import Link from "next/link";
import { ArrowLeft, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

// Placeholder served when a demo visitor clicks "Visit site" on a live
// demo service. The demo backend's listed liveUrl points at this route
// (apps/web/app/demo-target/[name]) so visitors land on a real working
// page instead of the previous .demo.ironforge.example URL that didn't
// resolve.
//
// Outside the (shell) route group on purpose: when a visitor clicks
// through to a "deployed site," they expect to leave the portal chrome
// behind. Sidebar + topbar would break that mental model. The page
// inherits the root layout's dark class + Geist fonts, and adds a
// minimal centered card with a back-link to /demo for visitors who
// want to keep exploring.
//
// The [name] segment comes straight from the URL path. React's auto-
// escaping makes display safe; no extra sanitization needed.

type Props = {
  params: Promise<{ name: string }>;
};

export default async function DemoTargetPage({ params }: Props): Promise<React.ReactNode> {
  const { name } = await params;
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 py-12">
      <div className="w-full max-w-xl">
        <div className="rounded-xl border bg-card p-8 sm:p-10">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.08em] text-primary">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            Demo placeholder
          </div>

          <div className="mt-5 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-md border bg-surface-2 text-primary"
            >
              <Globe className="size-4" />
            </span>
            <h1 className="break-all font-mono text-2xl font-semibold tracking-tight">
              {name}
            </h1>
          </div>

          <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
            This is a placeholder for the static site that Ironforge would
            provision for <span className="font-mono text-foreground">{name}</span>.
            In production, this URL serves content deployed from your GitHub
            repository via the auto-generated CI/CD pipeline (S3 + CloudFront
            + Route53 + IAM role).
          </p>

          <p className="mt-3 text-[13px] text-fg-subtle">
            Demo runs don&rsquo;t actually provision AWS infrastructure — the
            workflow you watched runs against a mock state machine. This page
            stands in for what the real deployment would serve.
          </p>

          <div className="mt-7 flex flex-wrap gap-2">
            <Link
              href="/demo"
              className={cn(buttonVariants({ size: "sm" }))}
            >
              <ArrowLeft className="size-3.5" />
              Back to Ironforge demo
            </Link>
            <Link
              href={`/demo/services`}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              Open catalog
            </Link>
          </div>
        </div>

        <p className="mt-4 text-center text-[11.5px] text-fg-faint">
          Served by the Ironforge portal at ironforge.rickycaballero.com
        </p>
      </div>
    </main>
  );
}

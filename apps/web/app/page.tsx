import Link from "next/link";
import { CheckCircle2, Clock, ExternalLink } from "lucide-react";

type PhaseStatus = "completed" | "in-progress" | "not-started";

type Phase = {
  title: string;
  status: PhaseStatus;
  summary: string;
};

const phases: Phase[] = [
  {
    title: "Phase 0 — Foundations",
    status: "completed",
    summary:
      "Monorepo, Terraform infrastructure, GitHub Actions CI/CD, portal placeholder.",
  },
  {
    title: "Phase 1 — End-to-end provisioning",
    status: "completed",
    summary:
      "Step Functions workflow and Lambda task functions. Provisioning + deprovisioning verified end-to-end against a live service.",
  },
  {
    title: "Phase 2 — Portal UI",
    status: "completed",
    summary:
      "Service catalog, create wizard, real-time progress polling, Cognito-authenticated CRUD, unauthenticated demo mode. Shared components across both surfaces.",
  },
  {
    title: "Phase 3 — Additional templates",
    status: "not-started",
    summary:
      "Beyond static-site: API services, scheduled jobs. Each new template is a curated module + per-template inputs schema; the platform's pattern is fixed, the surface area expands.",
  },
  {
    title: "Phase 4 — Drift detection and audit",
    status: "not-started",
    summary:
      "Scheduled drift detector comparing deployed AWS state against Terraform-declared state. Audit log views.",
  },
];

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Ironforge
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
          A self-service Internal Developer Platform on AWS. Authenticated
          users fill out a wizard, click Provision, and within ~5 minutes get
          a fully deployed static site with a custom subdomain, TLS
          certificate, GitHub repository with starter code, and CI/CD
          pipeline.
        </p>

        <section className="mt-12">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-500">
            Status
          </h2>
          <p className="mt-2 text-zinc-700 dark:text-zinc-300">
            Phases 0 through 2 are shipped. The platform provisions real
            AWS infrastructure end-to-end via Step Functions; the portal
            exposes that as a Cognito-authenticated wizard + service
            catalog with real-time progress, plus an unauthenticated{" "}
            <Link
              href="/demo"
              className="font-medium text-zinc-900 underline decoration-zinc-400 underline-offset-4 transition hover:decoration-zinc-700 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:decoration-zinc-300"
            >
              demo mode
            </Link>{" "}
            that walks visitors through the same UI without sign-in.
          </p>
          <p className="mt-3">
            <Link
              href="/demo"
              className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 transition hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
            >
              Try the demo →
            </Link>
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-500">
            Roadmap
          </h2>
          <ul className="mt-4 space-y-5">
            {phases.map((phase) => (
              <li key={phase.title} className="flex gap-3">
                <span
                  className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  {phase.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : phase.status === "in-progress" ? (
                    <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                  )}
                </span>
                <div>
                  <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                    {phase.title}
                    {phase.status === "completed" && (
                      <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                        complete
                      </span>
                    )}
                    {phase.status === "in-progress" && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        in progress
                      </span>
                    )}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {phase.summary}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-500">
            See it in action
          </h2>
          <p className="mt-2 text-zinc-700 dark:text-zinc-300">
            <Link
              href="/demo"
              className="font-medium text-zinc-900 underline decoration-zinc-400 underline-offset-4 transition hover:decoration-zinc-700 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:decoration-zinc-300"
            >
              Demo mode
            </Link>{" "}
            shows the platform's full state machine without sign-in: a
            static catalog spanning live / provisioning / failed states,
            plus an ephemeral provisioning theater that runs a 30-second
            timer-faked workflow when you create a service. For the real
            thing, sign in and visit{" "}
            <Link
              href="/services"
              className="font-medium text-zinc-900 underline decoration-zinc-400 underline-offset-4 transition hover:decoration-zinc-700 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:decoration-zinc-300"
            >
              services
            </Link>{" "}
            — provisioning takes ~5 minutes through the full Step
            Functions workflow.
          </p>
        </section>

        <section className="mt-12 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <a
            href="https://github.com/Ricky-C/ironforge"
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 transition hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>github.com/Ricky-C/ironforge</span>
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </section>
      </div>
    </main>
  );
}

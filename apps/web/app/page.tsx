import { CheckCircle2, Clock, ExternalLink, Github } from "lucide-react";

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
    status: "in-progress",
    summary:
      "Step Functions workflow and Lambda task functions. Real provisioning end-to-end via API call.",
  },
  {
    title: "Phase 2 — Wizard UI and service catalog",
    status: "not-started",
    summary:
      "Multi-step wizard, real-time progress polling, catalog and service-detail views.",
  },
  {
    title: "Phase 3 — Demo mode and polish",
    status: "not-started",
    summary:
      "Mock provisioning flow for unauthenticated visitors, landing page, service deletion.",
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
            Phase 0 (foundations) is complete. This page is served by the
            same CloudFront + S3 stack the rest of the project will use.
            Phase 1 — the API, Step Functions workflow, and static-site
            template — is the next milestone.
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

        <section className="mt-12 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <a
            href="https://github.com/Ricky-C/ironforge"
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-700 transition hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="h-4 w-4" aria-hidden="true" />
            <span>github.com/Ricky-C/ironforge</span>
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </section>
      </div>
    </main>
  );
}

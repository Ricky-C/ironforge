"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import type {
  Job,
  JobStep,
  ServiceJobResponse,
  ServiceJobStepListResponse,
} from "@ironforge/shared-types";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

// Narrow client interface — JobProgress only needs the two polling
// methods. Both the production apiClient and the demo apiClient
// satisfy this shape; the demo path passes its client via prop and
// the component renders the same UI regardless of source. Optional
// `deprovisionJobId` is the URL-encoded demo deprovision lifecycle
// context; production ignores it.
export type JobProgressClient = {
  getServiceJob: (
    id: string,
    deprovisionJobId?: string,
  ) => Promise<ServiceJobResponse>;
  listJobSteps: (
    id: string,
    jobId: string,
    deprovisionJobId?: string,
  ) => Promise<ServiceJobStepListResponse>;
};

// Real-time progress polling for a Service's most-recent Job.
// Backed by the polling endpoints landed in PR #121 (subphase 2.4-A.2):
//   GET /api/services/:id/job             — most-recent Job
//   GET /api/services/:id/jobs/:jobId/steps — JobStep[] for that Job
//
// Polling cadence: 2s while the Job is non-terminal; stops on terminal
// (succeeded | failed | cancelled). When the Job transitions to terminal
// we refetch the parent ["service", serviceId] query so the page picks
// up the Service's status flip (provisioning → live, deprovisioning →
// archived, etc.) without an extra user action.
//
// Step rendering: items returned in DynamoDB SK-alphabetic order; we
// sort client-side by `startedAt` so the checklist reads in workflow
// order. Duration (completedAt - startedAt) shown for terminal steps;
// running steps show an animated spinner.

const POLL_MS = 2000;

// Human-friendly labels for each workflow step. Keys MUST match the
// stepName values written by SFN task Lambdas (see provision-definition.json.tpl
// and deprovision-definition.json.tpl). When a new step lands, add it
// here; missing labels fall back to the technical stepName, which is
// honest but uglier than the curated label.
const STEP_LABELS: Record<string, string> = {
  ValidateInputs: "Validate inputs",
  CreateRepo: "Create GitHub repo",
  GenerateCode: "Generate template code",
  RunTerraform: "Run Terraform (S3 + CloudFront + Route53)",
  WaitForCloudFront: "Wait for CloudFront",
  TriggerDeploy: "Trigger initial deploy",
  WaitForDeploy: "Wait for deploy",
  Finalize: "Finalize",
  InitDeprovisionSteps: "Initialize teardown",
  DeprovisionTerraform: "Destroy infrastructure",
  DeleteExternalResources: "Delete repo + DNS",
};

// Steps that drive a poll loop in SFN. When running, the user benefits
// from knowing the step is intentionally long-lived (waiting on AWS),
// not stalled. We surface a "polling…" sublabel for these specifically.
const POLL_STEPS = new Set(["WaitForCloudFront", "WaitForDeploy"]);

const isJobTerminal = (job: Job | null): boolean =>
  job === null ||
  job.status === "succeeded" ||
  job.status === "failed" ||
  job.status === "cancelled";

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
};

const sortByStartedAt = (steps: JobStep[]): JobStep[] =>
  [...steps].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );

export function JobProgress({
  serviceId,
  apiClient,
  deprovisionJobId,
}: {
  serviceId: string;
  apiClient: JobProgressClient;
  deprovisionJobId?: string | undefined;
}): React.ReactNode {
  const queryClient = useQueryClient();

  // Cache key includes deprovisionJobId so a transition (no deprov →
  // post-DELETE deprov) starts a fresh query rather than overlaying
  // stale provision-state cache. URL changes drive the prop change
  // drives the queryKey change.
  const jobQuery = useQuery({
    queryKey: ["service", serviceId, "job", deprovisionJobId ?? null],
    queryFn: () => apiClient.getServiceJob(serviceId, deprovisionJobId),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data === undefined) return POLL_MS;
      return isJobTerminal(data.job) ? false : POLL_MS;
    },
  });

  const job = jobQuery.data?.job ?? null;
  const jobId = job?.id ?? null;

  const stepsQuery = useQuery({
    queryKey: [
      "service",
      serviceId,
      "jobs",
      jobId,
      "steps",
      deprovisionJobId ?? null,
    ],
    queryFn: () =>
      apiClient.listJobSteps(serviceId, jobId as string, deprovisionJobId),
    enabled: jobId !== null,
    refetchInterval: () => (isJobTerminal(job) ? false : POLL_MS),
  });

  // When the Job transitions to terminal, the parent Service's status
  // has flipped (provisioning → live | failed; deprovisioning → archived
  // | failed). Refetch the exact parent query so the page reflects the
  // new Service status. `exact: true` avoids invalidating our own
  // ["service", id, "job", ...] / ["service", id, "jobs", ...] queries
  // (which would cause a flash of "loading" right at the cleanest moment).
  // Parent's queryKey includes deprovisionJobId, so we mirror that here
  // — the demo deprovision lifecycle has its own parent cache slot.
  useEffect(() => {
    if (job !== null && isJobTerminal(job)) {
      void queryClient.refetchQueries({
        queryKey: ["service", serviceId, deprovisionJobId ?? null],
        exact: true,
      });
    }
    // job.status is the load-bearing identity; React's reference equality
    // on the Job object would re-fire on every poll tick.
  }, [job?.status, serviceId, deprovisionJobId, queryClient]);

  if (jobQuery.isPending) {
    return <JobProgressSkeleton />;
  }

  if (jobQuery.isError) {
    return <JobProgressError error={jobQuery.error} />;
  }

  if (job === null) {
    // Service has no Jobs yet — transitional pending state, very brief
    // window before the kickoff workflow's first Job item is written.
    return (
      <div className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline size-4 animate-spin" />
        Starting up…
      </div>
    );
  }

  const steps = sortByStartedAt(stepsQuery.data?.items ?? []);
  const totalDuration =
    job.status === "succeeded"
      ? new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
      : job.status === "failed"
      ? new Date(job.failedAt).getTime() - new Date(job.startedAt).getTime()
      : job.status === "cancelled"
      ? new Date(job.cancelledAt).getTime() - new Date(job.startedAt).getTime()
      : null;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">Workflow</h3>
        <p className="text-xs text-fg-subtle">
          <JobStatusLabel status={job.status} />
          {totalDuration !== null ? (
            <span className="tabular-nums"> · {formatDuration(totalDuration)}</span>
          ) : null}
        </p>
      </header>

      <div className="p-4">
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {job.status === "queued"
              ? "Queued — waiting for kickoff."
              : "No step events reported yet."}
          </p>
        ) : (
          <ol className="relative">
            {steps.map((step, i) => (
              <StepRow
                key={step.stepName}
                step={step}
                index={i}
                isLast={i === steps.length - 1}
              />
            ))}
          </ol>
        )}
      </div>

      {job.status === "failed" ? (
        <div className="border-t p-4">
          <Alert variant="destructive">
            <AlertTitle className="font-mono text-xs">{job.failedStep}</AlertTitle>
            <AlertDescription className="font-mono text-xs">
              {job.failureReason}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

function JobStatusLabel({ status }: { status: Job["status"] }): React.ReactNode {
  // Render-friendly status text. Job["status"] is exhaustive so the
  // record forces a compile-time error if a new variant is added.
  const labels: Record<Job["status"], string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return <span>{labels[status]}</span>;
}

function StepRow({
  step,
  index,
  isLast,
}: {
  step: JobStep;
  index: number;
  isLast: boolean;
}): React.ReactNode {
  const duration =
    step.status === "succeeded"
      ? formatDuration(
          new Date(step.completedAt).getTime() -
            new Date(step.startedAt).getTime(),
        )
      : null;

  const label = STEP_LABELS[step.stepName] ?? step.stepName;
  const isPolling = step.status === "running" && POLL_STEPS.has(step.stepName);

  return (
    <li className="relative grid grid-cols-[28px_1fr_auto] items-start gap-3 py-2">
      {/* Connecting rail to next step. Hidden on the last row.
          Color flips per step status — succeeded steps get a solid rail
          to their successor. */}
      {!isLast ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-[13px] top-[30px] -bottom-2 w-px",
            step.status === "succeeded" ? "bg-success" : "bg-border-strong",
          )}
        />
      ) : null}

      <StepIcon status={step.status} index={index} />

      <div className="min-w-0">
        <div className="flex min-h-[28px] items-center gap-2 text-[13px] font-medium">
          <span className="break-all">{label}</span>
          {isPolling ? (
            <span className="font-mono text-xs font-normal text-fg-subtle">
              polling…
            </span>
          ) : null}
        </div>
      </div>

      <div className="self-center text-[11.5px] tabular-nums text-fg-subtle">
        {duration !== null ? (
          duration
        ) : step.status === "running" ? (
          <span>running…</span>
        ) : step.status === "failed" ? (
          <span className="text-destructive">failed</span>
        ) : null}
      </div>
    </li>
  );
}

function StepIcon({
  status,
  index,
}: {
  status: JobStep["status"];
  index: number;
}): React.ReactNode {
  const base =
    "z-10 grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] text-[11px] font-semibold";
  switch (status) {
    case "succeeded":
      return (
        <span
          className={cn(base, "border-success bg-success-soft text-success")}
          aria-label={`step ${index + 1} succeeded`}
        >
          <Check className="size-3.5" strokeWidth={2.5} />
        </span>
      );
    case "running":
      return (
        <span
          className={cn(base, "border-warning bg-warning-soft text-warning")}
          aria-label={`step ${index + 1} running`}
        >
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      );
    case "failed":
      return (
        <span
          className={cn(base, "border-destructive bg-destructive-soft text-destructive")}
          aria-label={`step ${index + 1} failed`}
        >
          <X className="size-3.5" strokeWidth={2.5} />
        </span>
      );
  }
}

function JobProgressSkeleton(): React.ReactNode {
  return (
    <div className="rounded-lg border bg-card p-4">
      <Skeleton className="mb-3 h-4 w-24" />
      <Skeleton className="mb-1.5 h-4 w-full" />
      <Skeleton className="mb-1.5 h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

function JobProgressError({ error }: { error: unknown }): React.ReactNode {
  const isApiError = error instanceof ApiClientError;
  return (
    <Alert variant="destructive">
      <AlertTitle>{isApiError ? error.code : "Workflow status unavailable"}</AlertTitle>
      <AlertDescription>
        {isApiError ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

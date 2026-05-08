"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type {
  Job,
  JobStep,
  ServiceJobResponse,
  ServiceJobStepListResponse,
} from "@ironforge/shared-types";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api-client";

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
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
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
    <div className="rounded-md border p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Workflow</h3>
        <p className="text-xs text-muted-foreground">
          <JobStatusLabel status={job.status} />
          {totalDuration !== null ? (
            <span> · {formatDuration(totalDuration)}</span>
          ) : null}
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {job.status === "queued"
            ? "Queued — waiting for kickoff."
            : "No step events reported yet."}
        </p>
      ) : (
        <ol className="space-y-1.5">
          {steps.map((step) => (
            <StepRow key={step.stepName} step={step} />
          ))}
        </ol>
      )}

      {job.status === "failed" ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Failed at {job.failedStep}</AlertTitle>
          <AlertDescription>{job.failureReason}</AlertDescription>
        </Alert>
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

function StepRow({ step }: { step: JobStep }): React.ReactNode {
  const duration =
    step.status === "succeeded"
      ? formatDuration(
          new Date(step.completedAt).getTime() -
            new Date(step.startedAt).getTime(),
        )
      : null;

  return (
    <li className="flex items-center gap-2 text-sm">
      <StepIcon status={step.status} />
      <span className="font-mono text-xs">{step.stepName}</span>
      {duration !== null ? (
        <span className="ml-auto text-xs text-muted-foreground">{duration}</span>
      ) : step.status === "running" ? (
        <span className="ml-auto text-xs text-muted-foreground">running…</span>
      ) : step.status === "failed" ? (
        <span className="ml-auto text-xs text-red-600">failed</span>
      ) : null}
    </li>
  );
}

function StepIcon({ status }: { status: JobStep["status"] }): React.ReactNode {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />;
    case "running":
      return <Loader2 className="h-4 w-4 text-amber-600 shrink-0 animate-spin" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-600 shrink-0" />;
  }
}

function JobProgressSkeleton(): React.ReactNode {
  return (
    <div className="rounded-md border p-4">
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

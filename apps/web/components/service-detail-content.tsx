"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ApiClientError } from "@/lib/api-client";
import { BackLink } from "@/components/back-link";
import { JobProgress, type JobProgressClient } from "@/components/job-progress";
import { StatusBadge } from "@/components/status-badge";
import type {
  DeprovisionServiceResponse,
  Service,
} from "@ironforge/shared-types";

// Shared service-detail rendering. Used by both /services/[id]
// (authenticated production) and /demo/services/[id] (unauthenticated
// demo). Differences flow through props:
//   - apiClient: production or demo variant; same method shape
//   - canDeprovision: default rejects in-flight / archived; demo can
//     additionally reject static-catalog IDs (defense in depth alongside
//     backend's 404 on those)
//   - displayNameOverride: demo wrapper supplies the visitor-typed name
//     from sessionStorage when the backend's synthetic ephemeral name
//     would otherwise show

export type ServiceDetailClient = JobProgressClient & {
  getService: (id: string, deprovisionJobId?: string) => Promise<Service>;
  deprovisionService: (id: string) => Promise<DeprovisionServiceResponse>;
};

export function ServiceDetailContent({
  params,
  apiClient,
  backHref,
  backLabel,
  canDeprovision,
  displayNameOverride,
  deprovisionJobId,
  onDeprovisionSuccess,
}: {
  params: Promise<{ id: string }>;
  apiClient: ServiceDetailClient;
  /** Back-link href — points to the catalog surface for this context. Production: "/services". Demo: "/demo". */
  backHref: string;
  backLabel: string;
  canDeprovision?: (service: Service) => boolean;
  displayNameOverride?: string | undefined;
  /** Demo deprovision-lifecycle context (URL-encoded). Production is unaware. */
  deprovisionJobId?: string | undefined;
  /**
   * Demo wrapper hook fired after a successful Deprovision click. Mirrors
   * `onCreated` from CreateServiceContent — same `(response) => void`
   * shape, exposes the full {service, job} composite for hook flexibility.
   * Demo's hook calls router.replace to encode the deprovisionJobId in
   * the URL; production passes nothing (existing setQueryData behavior
   * is sufficient — production's real workflow is what drives state).
   */
  onDeprovisionSuccess?: (response: DeprovisionServiceResponse) => void;
}): React.ReactNode {
  const { id } = use(params);

  // Cache key includes deprovisionJobId so the post-DELETE URL (with
  // the param set) starts a fresh query rather than reusing the
  // pre-DELETE service-state cache slot. Same shape JobProgress uses.
  const query = useQuery({
    queryKey: ["service", id, deprovisionJobId ?? null],
    queryFn: () => apiClient.getService(id, deprovisionJobId),
  });

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
        <BackLink href={backHref} label={backLabel} className="mb-6" />
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Service detail
        </h1>
        <p className="mt-2 break-all font-mono text-sm text-muted-foreground">{id}</p>

        <div className="mt-10">
          {query.isPending ? (
            <ServiceDetailSkeleton />
          ) : query.isError ? (
            <ServiceDetailError error={query.error} />
          ) : (
            <ServiceDetailCard
              service={query.data}
              apiClient={apiClient}
              canDeprovision={canDeprovision ?? defaultCanDeprovision}
              displayNameOverride={displayNameOverride}
              deprovisionJobId={deprovisionJobId}
              onDeprovisionSuccess={onDeprovisionSuccess}
            />
          )}
        </div>
      </div>
    </main>
  );
}

const defaultCanDeprovision = (service: Service): boolean =>
  service.status === "live" || service.status === "failed";

function ServiceDetailSkeleton(): React.ReactNode {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-4 w-56" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-3/4" />
      </CardContent>
    </Card>
  );
}

function ServiceDetailError({ error }: { error: unknown }): React.ReactNode {
  const isApiError = error instanceof ApiClientError;
  return (
    <Alert variant="destructive">
      <AlertTitle>{isApiError ? error.code : "Unknown error"}</AlertTitle>
      <AlertDescription>{isApiError ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}

function ServiceDetailCard({
  service,
  apiClient,
  canDeprovision,
  displayNameOverride,
  deprovisionJobId,
  onDeprovisionSuccess,
}: {
  service: Service;
  apiClient: ServiceDetailClient;
  canDeprovision: (service: Service) => boolean;
  displayNameOverride: string | undefined;
  deprovisionJobId: string | undefined;
  onDeprovisionSuccess: ((response: DeprovisionServiceResponse) => void) | undefined;
}): React.ReactNode {
  const displayName = displayNameOverride ?? service.name;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3">
          <span className="break-all">{displayName}</span>
          <StatusBadge status={service.status} />
        </CardTitle>
        <CardDescription>Template: {service.templateId}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {service.status === "live" ? (
          <a
            href={service.liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-2 break-all text-sm font-medium text-primary hover:underline"
          >
            <span className="break-all">{service.liveUrl}</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            Live URL unavailable for status: {service.status}
          </p>
        )}

        <JobProgress
          serviceId={service.id}
          apiClient={apiClient}
          deprovisionJobId={deprovisionJobId}
        />

        {canDeprovision(service) ? (
          <DeprovisionAction
            service={service}
            displayName={displayName}
            apiClient={apiClient}
            deprovisionJobId={deprovisionJobId}
            onDeprovisionSuccess={onDeprovisionSuccess}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeprovisionAction({
  service,
  displayName,
  apiClient,
  deprovisionJobId,
  onDeprovisionSuccess,
}: {
  service: Service;
  displayName: string;
  apiClient: ServiceDetailClient;
  deprovisionJobId: string | undefined;
  onDeprovisionSuccess: ((response: DeprovisionServiceResponse) => void) | undefined;
}): React.ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => apiClient.deprovisionService(service.id),
    onSuccess: (data) => {
      // Seed BOTH cache slots: the pre-DELETE one (no deprovisionJobId)
      // and the post-DELETE one (with response.job.id). The post-
      // DELETE seed is what the URL-changed-via-onDeprovisionSuccess
      // re-render reads — avoids a flash of "loading" before the next
      // poll tick comes back.
      queryClient.setQueryData(
        ["service", service.id, deprovisionJobId ?? null],
        data.service,
      );
      queryClient.setQueryData(
        ["service", service.id, data.job.id],
        data.service,
      );
      setOpen(false);
      onDeprovisionSuccess?.(data);
    },
  });

  return (
    <div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button variant="destructive" size="sm">
              Deprovision
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-all">Deprovision {displayName}?</DialogTitle>
            <DialogDescription>This will destroy:</DialogDescription>
          </DialogHeader>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            <li>The AWS infrastructure (S3 + CloudFront + Route53 + IAM)</li>
            <li>
              The GitHub repo (
              <code className="break-all font-mono text-xs">ironforge-svc/{displayName}</code>)
            </li>
            <li>
              The live URL (
              <code className="break-all font-mono text-xs">
                {displayName}.ironforge.rickycaballero.com
              </code>
              )
            </li>
          </ul>
          <p className="text-sm font-medium text-foreground">This cannot be undone.</p>

          {mutation.isError ? (
            <Alert variant="destructive">
              <AlertTitle>
                {mutation.error instanceof ApiClientError
                  ? mutation.error.code
                  : "Unknown error"}
              </AlertTitle>
              <AlertDescription>
                {mutation.error instanceof ApiClientError
                  ? mutation.error.message
                  : String(mutation.error)}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Deprovisioning..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

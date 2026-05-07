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
import { ApiClientError, apiClient } from "@/lib/api-client";
import { JobProgress } from "@/components/job-progress";
import { StatusBadge } from "@/components/status-badge";
import type { Service } from "@ironforge/shared-types";

type ServiceDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default function ServiceDetailPage({
  params,
}: ServiceDetailPageProps): React.ReactNode {
  const { id } = use(params);

  const query = useQuery({
    queryKey: ["service", id],
    queryFn: () => apiClient.getService(id),
  });

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-2xl px-6 py-16 sm:py-24">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Service detail
        </h1>
        <p className="mt-2 font-mono text-sm text-muted-foreground">{id}</p>

        <div className="mt-10">
          {query.isPending ? (
            <ServiceDetailSkeleton />
          ) : query.isError ? (
            <ServiceDetailError error={query.error} />
          ) : (
            <ServiceDetailCard service={query.data} />
          )}
        </div>
      </div>
    </main>
  );
}

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
      <AlertDescription>
        {isApiError ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

function ServiceDetailCard({ service }: { service: Service }): React.ReactNode {
  // Deprovision is offered only for terminal-but-restorable statuses.
  // - live | failed: kicks off a deprovisioning workflow.
  // - deprovisioning: in-flight; backend is idempotent on re-DELETE but
  //   the UX value of a button is low — the badge already conveys state.
  // - pending | provisioning: blocked by backend (409 SERVICE_IN_FLIGHT)
  //   until terminal state is reached.
  // - archived: already deprovisioned (404 from backend).
  const canDeprovision = service.status === "live" || service.status === "failed";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3">
          <span>{service.name}</span>
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
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            {service.liveUrl}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : (
          <p className="text-sm text-muted-foreground">
            Live URL unavailable for status: {service.status}
          </p>
        )}

        <JobProgress serviceId={service.id} />

        {canDeprovision ? <DeprovisionAction service={service} /> : null}
      </CardContent>
    </Card>
  );
}

function DeprovisionAction({ service }: { service: Service }): React.ReactNode {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: () => apiClient.deprovisionService(service.id),
    onSuccess: (data) => {
      // Backend returns the new {service, job} composite. Seed the
      // ["service", id] cache directly so the page reflects the new
      // deprovisioning status without an extra fetch. Job goes
      // unsurfaced here (subphase 2.4 polling will consume it).
      queryClient.setQueryData(["service", service.id], data.service);
      setOpen(false);
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
            <DialogTitle>Deprovision {service.name}?</DialogTitle>
            <DialogDescription>
              This will destroy:
            </DialogDescription>
          </DialogHeader>
          <ul className="ml-4 list-disc space-y-1 text-sm text-muted-foreground">
            <li>The AWS infrastructure (S3 + CloudFront + Route53 + IAM)</li>
            <li>
              The GitHub repo (
              <code className="font-mono text-xs">
                ironforge-svc/{service.name}
              </code>
              )
            </li>
            <li>
              The live URL (
              <code className="font-mono text-xs">
                {service.name}.ironforge.rickycaballero.com
              </code>
              )
            </li>
          </ul>
          <p className="text-sm font-medium text-foreground">
            This cannot be undone.
          </p>

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


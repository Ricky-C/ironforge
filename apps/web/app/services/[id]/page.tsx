"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { ApiClientError, apiClient } from "@/lib/api-client";
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
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3">
          <span>{service.name}</span>
          <StatusBadge status={service.status} />
        </CardTitle>
        <CardDescription>Template: {service.templateId}</CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  status,
}: {
  status: Service["status"];
}): React.ReactNode {
  const colorMap: Record<Service["status"], string> = {
    pending:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    provisioning:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    deprovisioning:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    live: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    archived:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[status]}`}
    >
      {status}
    </span>
  );
}

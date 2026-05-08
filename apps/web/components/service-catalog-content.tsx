"use client";

import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
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
import { ApiClientError, type ListServicesParams } from "@/lib/api-client";
import { BackLink } from "@/components/back-link";
import { StatusBadge } from "@/components/status-badge";
import type { Service, ServiceListResponse } from "@ironforge/shared-types";

// Shared catalog rendering. Used by both the authenticated /services
// page and the unauthenticated /demo page (subphase 2.6) — the
// difference is which apiClient variant gets passed in. ProtectedRoute
// wrapping is a per-page concern, not the content component's.
//
// `basePath` controls intra-app links (the detail and create-service
// targets). Passing "/services" gives production routing; passing
// "/demo/services" gives demo routing.

type CatalogClient = {
  listServices: (params?: ListServicesParams) => Promise<ServiceListResponse>;
};

type ServiceListParam = ListServicesParams | undefined;

export function ServiceCatalogContent({
  apiClient,
  basePath,
  queryKey = ["services"],
  heading = "Services",
  subheading = "Static sites provisioned via Ironforge. Click into any service for its detail and deprovision options.",
}: {
  apiClient: CatalogClient;
  basePath: string;
  queryKey?: readonly unknown[];
  heading?: string;
  subheading?: string;
}): React.ReactNode {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => {
      const params: ServiceListParam = pageParam ? { cursor: pageParam } : undefined;
      return apiClient.listServices(params);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.cursor,
  });

  const services = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
        <BackLink href="/" label="Home" className="mb-6" />
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{subheading}</p>
          </div>
          <Link
            href={`${basePath}/new`}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Create service
          </Link>
        </header>

        <div className="mt-10">
          {query.isPending ? (
            <CatalogSkeleton />
          ) : query.isError ? (
            <CatalogError error={query.error} />
          ) : services.length === 0 ? (
            <CatalogEmpty />
          ) : (
            <>
              <CatalogGrid services={services} basePath={basePath} />
              {query.hasNextPage ? (
                <div className="mt-8 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function CatalogGrid({
  services,
  basePath,
}: {
  services: Service[];
  basePath: string;
}): React.ReactNode {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => (
        <li key={service.id}>
          <Link
            href={`${basePath}/${service.id}`}
            className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="transition-colors hover:bg-muted/40">
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-3">
                  <span className="truncate">{service.name}</span>
                  <StatusBadge status={service.status} />
                </CardTitle>
                <CardDescription>Template: {service.templateId}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="break-all font-mono text-xs text-muted-foreground">{service.id}</p>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CatalogSkeleton(): React.ReactNode {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i}>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="mt-2 h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-4 w-full" />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function CatalogEmpty(): React.ReactNode {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No services yet</CardTitle>
        <CardDescription>
          Provisioned services will appear here.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function CatalogError({ error }: { error: unknown }): React.ReactNode {
  const isApiError = error instanceof ApiClientError;
  return (
    <Alert variant="destructive">
      <AlertTitle>{isApiError ? error.code : "Unknown error"}</AlertTitle>
      <AlertDescription>{isApiError ? error.message : String(error)}</AlertDescription>
    </Alert>
  );
}

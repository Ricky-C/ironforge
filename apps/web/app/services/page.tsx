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
import { ApiClientError, apiClient } from "@/lib/api-client";
import { StatusBadge } from "@/components/status-badge";
import type { Service } from "@ironforge/shared-types";

export default function ServiceCatalogPage(): React.ReactNode {
  const query = useInfiniteQuery({
    queryKey: ["services"],
    queryFn: ({ pageParam }) =>
      apiClient.listServices(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.cursor,
  });

  const services = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
        <header>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Services
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Static sites provisioned via Ironforge. Click into any service for
            its detail and deprovision options.
          </p>
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
              <CatalogGrid services={services} />
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

function CatalogGrid({ services }: { services: Service[] }): React.ReactNode {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => (
        <li key={service.id}>
          <Link
            href={`/services/${service.id}`}
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
                <p className="font-mono text-xs text-muted-foreground">
                  {service.id}
                </p>
              </CardContent>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CatalogSkeleton(): React.ReactNode {
  // Six placeholder cards mirror the grid's responsive layout (one
  // column mobile, two md, three lg). Same Card shell as CatalogGrid
  // so the skeleton-to-data swap is layout-stable (no jump on load).
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
  // Subphase 2.3 will replace the static placeholder with an actual
  // /wizard CTA. For now, the empty state is descriptive — explains
  // what's missing without dangling a button that goes nowhere.
  return (
    <Card>
      <CardHeader>
        <CardTitle>No services yet</CardTitle>
        <CardDescription>
          Provisioned services will appear here. The wizard for creating new
          services lands in subphase 2.3.
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
      <AlertDescription>
        {isApiError ? error.message : String(error)}
      </AlertDescription>
    </Alert>
  );
}

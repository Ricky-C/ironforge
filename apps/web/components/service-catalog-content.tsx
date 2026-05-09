"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  Globe,
  Layers,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiClientError, type ListServicesParams } from "@/lib/api-client";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import type { Service, ServiceListResponse } from "@ironforge/shared-types";

// Shared catalog rendering. Used by both the authenticated /services
// page and the unauthenticated /demo/services page (subphase 2.6 +
// PR-2 IA reshuffle) — the difference is which apiClient variant gets
// passed in. ProtectedRoute wrapping is a per-page concern, not the
// content component's.
//
// `basePath` controls intra-app links (the detail and create-service
// targets). Passing "/services" gives production routing; passing
// "/demo/services" gives demo routing.
//
// PR-3 redesign: dense table replaces the card grid. Segmented filter
// pills (All / Live / Provisioning / Failed) for quick triage. Filter
// chips for owner/template + "Group" button from the design are
// intentionally NOT here — they'd lie about scope (no owner-filter
// dimension shipped yet, no grouping). When those features land, they
// land alongside the controls.

type CatalogClient = {
  listServices: (params?: ListServicesParams) => Promise<ServiceListResponse>;
};

type ServiceListParam = ListServicesParams | undefined;

// Filter pill values. "provisioning" matches both provisioning and
// deprovisioning since both are "in-flight" from a triage standpoint —
// one filter for both keeps the pill set tight. Pending and archived
// show only in the "all" view because they're rare/transient and
// don't earn their own pill.
type StatusFilter = "all" | "live" | "provisioning" | "failed";

export function ServiceCatalogContent({
  apiClient,
  basePath,
  queryKey = ["services"],
  heading = "Service catalog",
  subheading = "Static sites provisioned via Ironforge. Click into any service for its detail and deprovision options.",
}: {
  apiClient: CatalogClient;
  basePath: string;
  queryKey?: readonly unknown[];
  heading?: string;
  subheading?: string;
}): React.ReactNode {
  const [filter, setFilter] = useState<StatusFilter>("all");

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
  const filtered = filterByStatus(services, filter);
  const counts = countByFilter(services);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 sm:py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {heading}
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-sm text-muted-foreground">
            {subheading}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
            Refresh
          </Button>
          <Link
            href={`${basePath}/new`}
            className={cn(buttonVariants({ size: "sm" }))}
          >
            <Plus className="size-3.5" />
            New service
          </Link>
        </div>
      </header>

      <section className="mt-6 overflow-hidden rounded-lg border bg-card">
        <Toolbar filter={filter} onFilterChange={setFilter} counts={counts} />

        <CatalogBody
          state={
            query.isPending
              ? "loading"
              : query.isError
                ? "error"
                : services.length === 0
                  ? "empty"
                  : "ready"
          }
          services={filtered}
          totalServices={services.length}
          filter={filter}
          basePath={basePath}
          error={query.error}
          onRetry={() => void query.refetch()}
        />

        <CatalogFooter
          shown={filtered.length}
          total={services.length}
          hasNextPage={query.hasNextPage}
          isFetchingNext={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
          isReady={!query.isPending && !query.isError && services.length > 0}
        />
      </section>
    </div>
  );
}

// ===== Filtering / counts =====

function filterByStatus(services: Service[], filter: StatusFilter): Service[] {
  if (filter === "all") return services;
  if (filter === "live") return services.filter((s) => s.status === "live");
  if (filter === "failed") return services.filter((s) => s.status === "failed");
  return services.filter(
    (s) => s.status === "provisioning" || s.status === "deprovisioning",
  );
}

function countByFilter(services: Service[]): Record<StatusFilter, number> {
  return {
    all: services.length,
    live: services.filter((s) => s.status === "live").length,
    provisioning: services.filter(
      (s) => s.status === "provisioning" || s.status === "deprovisioning",
    ).length,
    failed: services.filter((s) => s.status === "failed").length,
  };
}

// ===== Toolbar =====
// Segmented filter pills. Active pill gets a raised treatment (white
// surface + subtle shadow) against the inset toolbar background.

function Toolbar({
  filter,
  onFilterChange,
  counts,
}: {
  filter: StatusFilter;
  onFilterChange: (next: StatusFilter) => void;
  counts: Record<StatusFilter, number>;
}): React.ReactNode {
  const options: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "live", label: "Live" },
    { value: "provisioning", label: "Provisioning" },
    { value: "failed", label: "Failed" },
  ];

  return (
    <div className="flex items-center gap-2 border-b bg-card px-3 py-2.5">
      <div className="inline-flex rounded-md border bg-surface-2 p-0.5">
        {options.map((o) => {
          const isActive = filter === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onFilterChange(o.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-card text-foreground shadow-[0_1px_0_oklch(0_0_0_/_0.25)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={isActive}
            >
              {o.label}
              <span
                className={cn(
                  "tabular-nums text-[11px]",
                  isActive ? "text-fg-subtle" : "text-fg-faint",
                )}
              >
                {counts[o.value]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ===== Body — table / empty / loading / error =====

type BodyState = "ready" | "loading" | "empty" | "error";

function CatalogBody({
  state,
  services,
  totalServices,
  filter,
  basePath,
  error,
  onRetry,
}: {
  state: BodyState;
  services: Service[];
  totalServices: number;
  filter: StatusFilter;
  basePath: string;
  error: unknown;
  onRetry: () => void;
}): React.ReactNode {
  if (state === "error") {
    return <CatalogError error={error} onRetry={onRetry} />;
  }

  if (state === "empty") {
    return <CatalogEmpty basePath={basePath} />;
  }

  return (
    <>
      <CatalogTable services={services} basePath={basePath} loading={state === "loading"} />
      {state === "ready" && services.length === 0 && filter !== "all" ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          No services match status &ldquo;{filter}&rdquo;. {totalServices} total — try the
          {" "}
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => void 0}
          >
            All
          </button>
          {" "}filter.
        </p>
      ) : null}
    </>
  );
}

// ===== Table =====
// Click anywhere on the row to navigate via useRouter. The name cell
// has an embedded <Link> so keyboard users can Tab to it and Enter
// to activate. The Live URL anchor inside the row stopPropagation()s
// so clicking the URL opens the site rather than the detail page.

function CatalogTable({
  services,
  basePath,
  loading,
}: {
  services: Service[];
  basePath: string;
  loading: boolean;
}): React.ReactNode {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-surface-2">
            <Th className="w-[26%]">Name</Th>
            <Th className="w-[120px]">Status</Th>
            <Th>Live URL</Th>
            <Th className="w-[12%]">Owner</Th>
            <Th className="w-[10%]">Created</Th>
            <th className="w-9" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1, 2, 3].map((i) => <SkeletonRow key={i} />)
            : services.map((service) => (
                <CatalogRow key={service.id} service={service} basePath={basePath} />
              ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactNode {
  return (
    <th
      className={cn(
        "h-9 px-3 text-left text-[11.5px] font-medium uppercase tracking-[0.04em] text-fg-subtle",
        className,
      )}
    >
      {children}
    </th>
  );
}

function CatalogRow({
  service,
  basePath,
}: {
  service: Service;
  basePath: string;
}): React.ReactNode {
  const router = useRouter();
  const detailHref = `${basePath}/${service.id}`;
  const liveUrl = service.status === "live" ? service.liveUrl : null;

  return (
    <tr
      onClick={() => router.push(detailHref)}
      className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-accent"
    >
      <td className="h-9 px-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[22px] shrink-0 place-items-center rounded-[5px] border bg-surface-2 text-muted-foreground">
            <Globe className="size-3" />
          </span>
          <div className="min-w-0">
            <Link
              href={detailHref}
              onClick={(e) => e.stopPropagation()}
              className="block truncate font-medium text-foreground outline-none focus-visible:underline"
            >
              {service.name}
            </Link>
            <div className="font-mono text-[11.5px] leading-tight text-fg-faint">
              {service.id.slice(0, 8)}…
            </div>
          </div>
        </div>
      </td>
      <td className="h-9 px-3">
        <StatusBadge status={service.status} />
      </td>
      <td className="h-9 px-3 font-mono text-xs text-muted-foreground">
        {liveUrl !== null ? (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 hover:text-primary"
          >
            <span className="truncate">{liveUrl.replace(/^https?:\/\//, "")}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <span className="text-fg-faint">—</span>
        )}
      </td>
      <td
        className="h-9 px-3 tabular-nums text-[12.5px] text-muted-foreground"
        title={service.ownerId}
      >
        {formatOwnerCell(service.ownerId)}
      </td>
      <td className="h-9 px-3 tabular-nums text-[12.5px] text-muted-foreground">
        {formatRelative(service.createdAt)}
      </td>
      <td className="h-9 px-3 text-fg-faint" aria-hidden="true">
        ›
      </td>
    </tr>
  );
}

function SkeletonRow(): React.ReactNode {
  return (
    <tr className="border-b last:border-b-0">
      <td className="h-9 px-3">
        <Skeleton className="h-3.5 w-36" />
      </td>
      <td className="h-9 px-3">
        <Skeleton className="h-[18px] w-20 rounded-full" />
      </td>
      <td className="h-9 px-3">
        <Skeleton className="h-3.5 w-60" />
      </td>
      <td className="h-9 px-3">
        <Skeleton className="h-3.5 w-20" />
      </td>
      <td className="h-9 px-3">
        <Skeleton className="h-3.5 w-16" />
      </td>
      <td className="h-9 px-3" />
    </tr>
  );
}

// ===== Empty / Error states =====

function CatalogEmpty({ basePath }: { basePath: string }): React.ReactNode {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="grid size-11 place-items-center rounded-[10px] border bg-surface-2 text-fg-subtle">
        <Layers className="size-5" />
      </div>
      <h3 className="mt-3.5 text-sm font-semibold">No services yet</h3>
      <p className="mt-1 max-w-[40ch] text-[12.5px] text-muted-foreground">
        Provisioned services appear here. Create your first service to get started.
      </p>
      <Link
        href={`${basePath}/new`}
        className={cn(buttonVariants({ size: "sm" }), "mt-4")}
      >
        <Plus className="size-3.5" />
        Provision a service
      </Link>
    </div>
  );
}

function CatalogError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactNode {
  const isApiError = error instanceof ApiClientError;
  return (
    <div className="p-6">
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{isApiError ? error.code : "Catalog unavailable"}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{isApiError ? error.message : String(error)}</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

// ===== Footer =====
// Pagination + region indicator. Load-more lives in the footer to keep
// it out of the table flow. Region is a hardcoded fact ("everything in
// us-east-1" per CLAUDE.md) — honest, useful for visitors mentally
// modeling where their resources live.

function CatalogFooter({
  shown,
  total,
  hasNextPage,
  isFetchingNext,
  onLoadMore,
  isReady,
}: {
  shown: number;
  total: number;
  hasNextPage: boolean;
  isFetchingNext: boolean;
  onLoadMore: () => void;
  isReady: boolean;
}): React.ReactNode {
  return (
    <div className="flex items-center justify-between gap-3 border-t bg-surface-2 px-4 py-2 text-xs text-fg-subtle">
      <span className="tabular-nums">
        {isReady ? (
          <>
            {shown} of {total} {total === 1 ? "service" : "services"}
          </>
        ) : null}
      </span>
      <div className="flex items-center gap-3">
        {hasNextPage ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={onLoadMore}
            disabled={isFetchingNext}
          >
            {isFetchingNext ? "Loading…" : "Load more"}
          </Button>
        ) : null}
        <span className="font-mono tabular-nums">us-east-1</span>
      </div>
    </div>
  );
}

// ===== Cell helpers =====

// Owner column rule (catalog-specific — tighter than detail's
// OwnerDisplay because the cell is narrow). Email-shaped values render
// the local-part (before @); UUID-shaped values render first 8 chars
// + ellipsis. The full value is exposed via the cell's title attr.
function formatOwnerCell(ownerId: string): string {
  if (ownerId.includes("@")) {
    const local = ownerId.split("@")[0];
    return local ?? ownerId;
  }
  return `${ownerId.slice(0, 8)}…`;
}

// Relative time formatter — "2h ago", "3d ago", or absolute date for
// values older than 30 days. Same shape as the detail page's helper.
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

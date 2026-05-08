"use client";

import { use, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Globe, Trash2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { cn } from "@/lib/utils";
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
      <div className="mx-auto max-w-6xl px-6 py-10 sm:py-14">
        <BackLink href={backHref} label={backLabel} className="mb-6" />

        {query.isPending ? (
          <ServiceDetailSkeleton />
        ) : query.isError ? (
          <ServiceDetailError error={query.error} />
        ) : (
          <ServiceDetailLayout
            service={query.data}
            apiClient={apiClient}
            canDeprovision={canDeprovision ?? defaultCanDeprovision}
            displayNameOverride={displayNameOverride}
            deprovisionJobId={deprovisionJobId}
            onDeprovisionSuccess={onDeprovisionSuccess}
          />
        )}
      </div>
    </main>
  );
}

const defaultCanDeprovision = (service: Service): boolean =>
  service.status === "live" || service.status === "failed";

function ServiceDetailSkeleton(): React.ReactNode {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="mt-2 h-3 w-72" />
      <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    </div>
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

function ServiceDetailLayout({
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
  const isLive = service.status === "live";
  const isFailed = service.status === "failed";
  const isDeprovisioning = service.status === "deprovisioning";
  const showResources = isLive || isFailed || isDeprovisioning;

  // Repo URL convention: ironforge-svc/<name>. Derived; not a stored
  // field on Service (the repo is created by CreateRepo task Lambda
  // and identified by name post-fact). If the convention changes,
  // this is the single point to update.
  const repoUrl = `https://github.com/ironforge-svc/${service.name}`;

  return (
    <div>
      <DetailHeader
        service={service}
        displayName={displayName}
        repoUrl={repoUrl}
        canDeprovision={canDeprovision(service)}
        apiClient={apiClient}
        deprovisionJobId={deprovisionJobId}
        onDeprovisionSuccess={onDeprovisionSuccess}
      />

      <div className="mt-8 grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <LiveUrlPanel service={service} />
          <JobProgress
            serviceId={service.id}
            apiClient={apiClient}
            deprovisionJobId={deprovisionJobId}
          />
          {showResources ? <ResourcesPanel service={service} /> : null}
        </div>

        <div className="flex flex-col gap-4 lg:sticky lg:top-4">
          <MetadataPanel service={service} />
          <ActivityPanel service={service} />
        </div>
      </div>
    </div>
  );
}

function DetailHeader({
  service,
  displayName,
  repoUrl,
  canDeprovision,
  apiClient,
  deprovisionJobId,
  onDeprovisionSuccess,
}: {
  service: Service;
  displayName: string;
  repoUrl: string;
  canDeprovision: boolean;
  apiClient: ServiceDetailClient;
  deprovisionJobId: string | undefined;
  onDeprovisionSuccess: ((response: DeprovisionServiceResponse) => void) | undefined;
}): React.ReactNode {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-all text-2xl font-semibold tracking-tight sm:text-3xl">
            {displayName}
          </h1>
          <StatusBadge status={service.status} />
        </div>
        <p className="mt-1 break-all font-mono text-xs text-fg-subtle">{service.id}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <GithubMark />
          Open repo
        </a>
        {service.status === "live" ? (
          <a
            href={service.liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <ExternalLink className="size-3.5" />
            Visit site
          </a>
        ) : null}
        {canDeprovision ? (
          <DeprovisionDialogAction
            service={service}
            displayName={displayName}
            apiClient={apiClient}
            deprovisionJobId={deprovisionJobId}
            onDeprovisionSuccess={onDeprovisionSuccess}
          />
        ) : null}
      </div>
    </header>
  );
}

function LiveUrlPanel({ service }: { service: Service }): React.ReactNode {
  // Status-conditional copy. Live shows the URL with copy + open; other
  // statuses show a status-specific placeholder so the panel is always
  // present and the user knows where the URL will appear.
  const placeholder = (() => {
    switch (service.status) {
      case "provisioning":
      case "pending":
        return "Subdomain will appear once CloudFront is reachable…";
      case "deprovisioning":
        return "URL is being torn down…";
      case "failed":
        return "Live URL unavailable — provisioning failed.";
      case "archived":
        return "Service archived.";
      case "live":
        return null;
    }
  })();

  return (
    <Panel title="Live URL">
      {service.status === "live" ? (
        <div className="flex items-center gap-2 rounded-md border bg-surface-2 p-2.5 font-mono text-xs">
          <Globe className="size-4 shrink-0 text-success" />
          <a
            href={service.liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-primary hover:underline"
          >
            {service.liveUrl}
          </a>
          <CopyButton value={service.liveUrl} />
          <a
            href={service.liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open live URL"
            className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }))}
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-md border bg-surface-2 p-2.5 text-xs text-fg-subtle">
          <Globe className="size-4 shrink-0" />
          <span>{placeholder}</span>
        </div>
      )}
    </Panel>
  );
}

function ResourcesPanel({ service }: { service: Service }): React.ReactNode {
  // Three of the four resource IDs are deterministic from `service.name`
  // (S3 bucket, Route53 record, IAM deploy role) per the platform's
  // ironforge-svc-* naming convention. The CloudFront distribution ID is
  // generated by AWS at provision time and is not stored on the Service
  // entity (would require a schema change to surface).
  return (
    <Panel
      title="AWS resources"
      meta="us-east-1"
      footer="Resources are derived from the service name. CloudFront IDs are generated by AWS at provision time."
    >
      <div className="flex flex-col">
        <ResourceRow
          icon={<Globe className="size-3.5" />}
          label="S3 bucket"
          id={`ironforge-svc-${service.name}-content`}
        />
        <ResourceRow
          icon={<Globe className="size-3.5" />}
          label="CloudFront distribution"
          dynamicId
        />
        <ResourceRow
          icon={<Globe className="size-3.5" />}
          label="Route53 record"
          id={`${service.name}.ironforge.rickycaballero.com`}
        />
        <ResourceRow
          icon={<Globe className="size-3.5" />}
          label="IAM deploy role"
          id={`ironforge-svc-${service.name}-deploy`}
          last
        />
      </div>
    </Panel>
  );
}

function ResourceRow({
  icon,
  label,
  id,
  dynamicId,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  id?: string;
  dynamicId?: boolean;
  last?: boolean;
}): React.ReactNode {
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr] items-center gap-3 px-4 py-2.5",
        !last && "border-b",
      )}
    >
      <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {dynamicId ? (
          <div className="font-mono text-xs italic text-fg-subtle">
            (generated at provision time)
          </div>
        ) : (
          <div className="truncate font-mono text-xs text-fg-subtle">{id}</div>
        )}
      </div>
    </div>
  );
}

function MetadataPanel({ service }: { service: Service }): React.ReactNode {
  // Metadata KV list. Owner truncation rule (per Q1 in PR-1 review):
  //   - emails (contain "@") render as-is — demo's mock owner
  //   - UUID-shaped values truncate to first 8 chars + ellipsis with
  //     a native `title` tooltip exposing the full value. Honest about
  //     data shape without lying that it's an email.
  return (
    <Panel title="Metadata">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <Term>Service ID</Term>
        <Def className="break-all font-mono text-[11px]">{service.id}</Def>

        <Term>Template</Term>
        <Def className="font-mono">{service.templateId}</Def>

        <Term>Owner</Term>
        <Def>
          <OwnerDisplay ownerId={service.ownerId} />
        </Def>

        <Term>Region</Term>
        <Def className="font-mono">us-east-1</Def>

        <Term>Created</Term>
        <Def className="tabular-nums">{formatDateTime(service.createdAt)}</Def>

        {service.status === "live" ? (
          <>
            <Term>Live since</Term>
            <Def className="tabular-nums">{formatDateTime(service.provisionedAt)}</Def>
          </>
        ) : null}

        {service.status === "failed" ? (
          <>
            <Term>Failed at</Term>
            <Def className="tabular-nums text-destructive">
              {formatDateTime(service.failedAt)}
            </Def>
          </>
        ) : null}

        {service.status === "archived" ? (
          <>
            <Term>Archived at</Term>
            <Def className="tabular-nums">{formatDateTime(service.archivedAt)}</Def>
          </>
        ) : null}
      </dl>
    </Panel>
  );
}

function OwnerDisplay({ ownerId }: { ownerId: string }): React.ReactNode {
  if (ownerId.includes("@")) {
    return <span className="break-all">{ownerId}</span>;
  }
  // Truncate UUIDs to first 8 chars; native title attribute exposes
  // the full value on hover for debugging without occupying layout
  // space or requiring a tooltip dependency.
  return (
    <span title={ownerId} className="cursor-help font-mono">
      {ownerId.slice(0, 8)}…
    </span>
  );
}

function ActivityPanel({ service }: { service: Service }): React.ReactNode {
  // Activity timeline derived from existing schema timestamps. Each
  // Service status implies a known set of events; we render the ones
  // we have evidence for. No stored audit log is queried — these are
  // the canonical lifecycle moments visible from Service fields alone.
  type Event = { when: string; who: string; action: React.ReactNode; tone?: "success" | "danger" | "warning" };
  const events: Event[] = [
    {
      when: service.createdAt,
      who: "ownerId" in service ? service.ownerId : "—",
      action: (
        <>
          created service <strong>{service.name}</strong>
        </>
      ),
    },
  ];

  if (service.status === "live") {
    events.push({
      when: service.provisionedAt,
      who: "ironforge-bot",
      action: (
        <>
          workflow <strong className="text-success">succeeded</strong>
        </>
      ),
      tone: "success",
    });
  } else if (service.status === "failed") {
    events.push({
      when: service.failedAt,
      who: "ironforge-bot",
      action: (
        <>
          {service.failedWorkflow} <strong className="text-destructive">failed</strong>
        </>
      ),
      tone: "danger",
    });
  } else if (service.status === "archived") {
    events.push({
      when: service.archivedAt,
      who: "ironforge-bot",
      action: (
        <>
          service <strong>archived</strong>
        </>
      ),
    });
  } else if (service.status === "provisioning" || service.status === "deprovisioning") {
    events.push({
      when: service.updatedAt,
      who: "ironforge-bot",
      action: (
        <>
          workflow <strong className="text-warning">running</strong>
        </>
      ),
      tone: "warning",
    });
  }

  return (
    <Panel title="Activity">
      <div className="flex flex-col">
        {events.map((e, i) => (
          <ActivityRow
            key={`${e.when}-${i}`}
            when={e.when}
            who={e.who}
            action={e.action}
            last={i === events.length - 1}
          />
        ))}
      </div>
    </Panel>
  );
}

function ActivityRow({
  when,
  who,
  action,
  last,
}: {
  when: string;
  who: string;
  action: React.ReactNode;
  last: boolean;
}): React.ReactNode {
  return (
    <div
      className={cn(
        "grid grid-cols-[8px_1fr_auto] gap-3 px-4 py-2.5 text-[12.5px]",
        !last && "border-b",
      )}
    >
      <span className="mt-1.5 size-1.5 rounded-full bg-fg-faint" aria-hidden="true" />
      <div>
        <div>{action}</div>
        <div className="text-xs text-fg-subtle">
          by{" "}
          {who.includes("@") || !/^[0-9a-f-]{36}$/i.test(who) ? (
            <span className="font-mono">{who}</span>
          ) : (
            <span title={who} className="cursor-help font-mono">
              {who.slice(0, 8)}…
            </span>
          )}
        </div>
      </div>
      <span className="text-xs tabular-nums text-fg-subtle">{formatRelative(when)}</span>
    </div>
  );
}

function DeprovisionDialogAction({
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
  const [confirmText, setConfirmText] = useState("");
  const isConfirmed = confirmText === displayName;

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
      setConfirmText("");
      onDeprovisionSuccess?.(data);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirmText("");
      }}
    >
      <DialogTrigger
        render={
          <Button variant="destructive" size="sm">
            <Trash2 className="size-3.5" />
            Deprovision
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-all">Deprovision {displayName}?</DialogTitle>
          <DialogDescription>
            This destroys the AWS infrastructure (S3, CloudFront, Route53, IAM),
            the GitHub repo, and the live URL. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1 pl-5 text-sm text-muted-foreground [&>li]:list-disc">
          <li>
            Repo{" "}
            <code className="break-all font-mono text-xs text-foreground">
              ironforge-svc/{displayName}
            </code>
          </li>
          <li>
            URL{" "}
            <code className="break-all font-mono text-xs text-foreground">
              {displayName}.ironforge.rickycaballero.com
            </code>
          </li>
          <li>
            Infra{" "}
            <code className="font-mono text-xs text-foreground">
              S3 + CloudFront + Route53 + IAM
            </code>
          </li>
        </ul>

        <div className="space-y-1.5">
          <Label htmlFor="deprovision-confirm">
            Type{" "}
            <code className="font-mono text-destructive">{displayName}</code> to confirm
          </Label>
          <Input
            id="deprovision-confirm"
            autoFocus
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={displayName}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

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
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !isConfirmed}
          >
            {mutation.isPending ? "Deprovisioning…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===== shared in-file helpers =====

function Panel({
  title,
  meta,
  footer,
  children,
}: {
  title: string;
  meta?: string;
  footer?: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {meta ? <span className="text-xs text-fg-subtle">{meta}</span> : null}
      </header>
      <div className="p-4">{children}</div>
      {footer ? (
        <footer className="border-t bg-surface-2 px-4 py-2 text-xs text-fg-subtle">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

function Term({ children }: { children: React.ReactNode }): React.ReactNode {
  return <dt className="font-normal text-fg-subtle">{children}</dt>;
}

function Def({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactNode {
  return <dd className={cn("m-0 break-words text-foreground", className)}>{children}</dd>;
}

// lucide-react dropped its brand-icon set in v0.x; we inline the GitHub
// mark rather than add a separate icon dependency for one glyph.
function GithubMark(): React.ReactNode {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

function CopyButton({ value }: { value: string }): React.ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
      aria-label={copied ? "Copied" : "Copy"}
      className={cn(copied && "text-success")}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

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

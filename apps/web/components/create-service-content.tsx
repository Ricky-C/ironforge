"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import {
  Clock,
  Code2,
  Globe,
  Loader2,
  Server,
  Zap,
} from "lucide-react";
import {
  ServiceNameSchema,
  type CreateServiceRequest,
  type CreateServiceResponse,
} from "@ironforge/shared-types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiClientError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth/auth-provider";
import { cn } from "@/lib/utils";

// Shared create-service form. Used by both the authenticated
// /services/new page and the unauthenticated /demo/services/new
// (subphase 2.6). Both go through createService → detail page;
// the demo wrapper supplies an `onCreated` hook to cache the
// visitor-typed name in sessionStorage for display on the detail
// page (since the demo backend computes synthetic names from ID).
//
// Validation uses react-hook-form's native `validate` callback with
// ServiceNameSchema.safeParse (per docs/tech-debt.md "@hookform/
// resolvers/zod incompatible with pnpm strict node_modules layout").
//
// PR-4 redesign: visual hierarchy reads as a confirmation flow on a
// single page (template tiles → name input with subdomain preview →
// summary block → submit). This is deliberately NOT a 3-step wizard:
// the static-site template has zero user inputs beyond the name, so
// a "configure" step with nothing to configure would be theater. A
// 3-step wizard becomes justified when a second template lands with
// per-template inputs — same component, more sections.

type FormValues = {
  name: string;
};

const validateName = (value: string): true | string => {
  const result = ServiceNameSchema.safeParse(value);
  if (result.success) return true;
  return result.error.issues[0]?.message ?? "invalid service name";
};

type CreateServiceClient = {
  createService: (
    body: CreateServiceRequest,
    idempotencyKey: string,
  ) => Promise<CreateServiceResponse>;
};

// Workflow steps shown in the confirmation block. Mirrors the actual
// SFN definition (infra/modules/step-functions/provision-definition.json.tpl).
// Hardcoded here rather than imported from job-progress.tsx because the
// wizard's "what will run" preview is part of the commitment-to-run
// surface — it should change deliberately when steps change, not
// silently follow a refactor of the runtime stepper. If the steps
// drift, both places update.
const PROVISION_STEPS: readonly { name: string; label: string }[] = [
  { name: "ValidateInputs", label: "Validate inputs" },
  { name: "CreateRepo", label: "Create GitHub repo" },
  { name: "GenerateCode", label: "Generate template code" },
  { name: "RunTerraform", label: "Run Terraform" },
  { name: "WaitForCloudFront", label: "Wait for CloudFront" },
  { name: "TriggerDeploy", label: "Trigger initial deploy" },
  { name: "WaitForDeploy", label: "Wait for deploy" },
  { name: "Finalize", label: "Finalize" },
];

export function CreateServiceContent({
  apiClient,
  basePath,
  backHref,
  catalogQueryKey = ["services"],
  onCreated,
}: {
  apiClient: CreateServiceClient;
  /** Routing prefix for success redirect (`${basePath}/${id}`). Production: "/services". Demo: "/demo/services". */
  basePath: string;
  /** Cancel target (the catalog surface). Production: "/services". Demo: "/demo/services". */
  backHref: string;
  /** Back-link label, retained in props for callers but no longer rendered as an in-page link — sidebar provides app-level nav. */
  backLabel?: string;
  catalogQueryKey?: readonly unknown[];
  onCreated?: (response: CreateServiceResponse) => void;
}): React.ReactNode {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const form = useForm<FormValues>({
    defaultValues: { name: "" },
  });
  const name = form.watch("name");

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      apiClient.createService(
        { name: values.name, templateId: "static-site", inputs: {} },
        idempotencyKey,
      ),
    onSuccess: (data) => {
      queryClient.setQueryData(["service", data.service.id], data.service);
      queryClient.invalidateQueries({ queryKey: catalogQueryKey });
      onCreated?.(data);
      router.push(`${basePath}/${data.service.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "CONFLICT") {
        form.setError(
          "name",
          { type: "server", message: error.message },
          { shouldFocus: true },
        );
      }
    },
  });

  const nameInputId = useId();
  const nameErrorId = useId();
  const nameHintId = useId();
  const fieldError = form.formState.errors.name?.message;
  const isSubmitting = mutation.isPending;

  const formError =
    mutation.isError &&
    !(mutation.error instanceof ApiClientError && mutation.error.code === "CONFLICT")
      ? mutation.error
      : null;

  // Owner displayed in the summary. Email if available (production
  // signed-in or demo's mock); falls back to "—" otherwise.
  const ownerDisplay = user?.profile.email ?? "demo@ironforge.io";

  return (
    <div className="mx-auto max-w-3xl px-6 py-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Provision a new service
        </h1>
        <p className="mt-1.5 max-w-[60ch] text-sm text-muted-foreground">
          Within ~5 minutes you&rsquo;ll have a subdomain, TLS certificate,
          GitHub repository, and CI/CD pipeline.
        </p>
      </header>

      <form
        className="mt-6"
        onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
        noValidate
      >
        <div className="overflow-hidden rounded-lg border bg-card">
          {/* ===== Section: Template ===== */}
          <SectionHeader
            title="Choose a template"
            meta="1 available"
          />
          <div className="p-4 pt-3 sm:p-5 sm:pt-3">
            <TemplateGrid />
          </div>

          {/* ===== Section: Service name ===== */}
          <SectionHeader title="Service name" />
          <div className="space-y-2 p-4 pt-3 sm:p-5 sm:pt-3">
            <Label htmlFor={nameInputId} className="sr-only">
              Service name
            </Label>
            <SubdomainInput
              id={nameInputId}
              describedBy={fieldError ? nameErrorId : nameHintId}
              invalid={fieldError !== undefined}
              disabled={isSubmitting}
              {...form.register("name", { validate: validateName })}
            />
            {fieldError ? (
              <p
                id={nameErrorId}
                className="text-[12.5px] font-medium text-destructive"
              >
                {fieldError}
              </p>
            ) : (
              <p id={nameHintId} className="text-[12px] text-fg-subtle">
                3&ndash;63 characters; lowercase alphanumeric with optional
                hyphens. Becomes your subdomain, GitHub repo name, and IAM
                role name. Cannot be changed later.
              </p>
            )}
          </div>

          {/* ===== Section: Confirm ===== */}
          <SectionHeader title="Confirm and provision" />
          <div className="p-4 pt-3 sm:p-5 sm:pt-3">
            <SummaryBlock name={name} owner={ownerDisplay} />
          </div>

          {formError !== null ? (
            <div className="border-t p-4 sm:p-5">
              <Alert variant="destructive">
                <AlertTitle>
                  {formError instanceof ApiClientError
                    ? formError.code
                    : "Unknown error"}
                </AlertTitle>
                <AlertDescription>
                  {formError instanceof ApiClientError
                    ? formError.message
                    : String(formError)}
                </AlertDescription>
              </Alert>
            </div>
          ) : null}

          {/* ===== Footer: actions ===== */}
          <div className="flex items-center justify-end gap-2 border-t bg-surface-2 px-4 py-2.5 sm:px-5">
            <Link
              href={backHref}
              aria-disabled={isSubmitting || undefined}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                isSubmitting && "pointer-events-none opacity-50",
              )}
            >
              Cancel
            </Link>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Provisioning&hellip;
                </>
              ) : (
                <>
                  <Zap className="size-3.5" />
                  Provision
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ===== Section header (within the form panel) =====

function SectionHeader({
  title,
  meta,
}: {
  title: string;
  meta?: string;
}): React.ReactNode {
  return (
    <header className="flex items-center justify-between gap-3 border-b bg-surface-2/60 px-4 py-2.5 sm:px-5 [&:not(:first-child)]:border-t">
      <h2 className="text-sm font-semibold">{title}</h2>
      {meta !== undefined ? (
        <span className="text-xs text-fg-subtle">{meta}</span>
      ) : null}
    </header>
  );
}

// ===== Template grid =====
// Static site is the only available template at MVP scope. The
// disabled tiles aren't aspirational placeholders for the sidebar
// (a chrome-level scope lie) — they're educational context within
// a feature that visibly accepts a template choice. The "Soon"
// pill makes intent explicit without pretending the option works.

function TemplateGrid(): React.ReactNode {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <TemplateTile
        icon={<Globe className="size-4" />}
        name="Static site"
        desc="S3 + CloudFront + Route53 + IAM. Auto-deploys from main on push."
        selected
      />
      <TemplateTile
        icon={<Server className="size-4" />}
        name="Containerized API"
        desc="ECS Fargate behind ALB with autoscaling."
        soon
      />
      <TemplateTile
        icon={<Code2 className="size-4" />}
        name="Lambda function"
        desc="API Gateway + Lambda + DynamoDB scaffold."
        soon
      />
      <TemplateTile
        icon={<Clock className="size-4" />}
        name="Scheduled job"
        desc="EventBridge-triggered Lambda or Fargate task."
        soon
      />
    </div>
  );
}

function TemplateTile({
  icon,
  name,
  desc,
  selected,
  soon,
}: {
  icon: React.ReactNode;
  name: string;
  desc: string;
  selected?: boolean;
  soon?: boolean;
}): React.ReactNode {
  return (
    <div
      className={cn(
        "relative rounded-lg border p-3.5 transition-colors",
        soon
          ? "cursor-not-allowed bg-surface-2/60 opacity-50"
          : selected
            ? "border-primary bg-primary/[0.06]"
            : "bg-surface-2",
      )}
      aria-disabled={soon || undefined}
    >
      <div
        className={cn(
          "grid size-8 place-items-center rounded-md",
          selected ? "bg-primary/15 text-primary" : "bg-card text-muted-foreground",
        )}
      >
        {icon}
      </div>
      <div className="mt-2 text-[13px] font-medium">{name}</div>
      <div className="mt-0.5 text-[11.5px] leading-snug text-fg-subtle">
        {desc}
      </div>
      {soon ? (
        <span className="absolute right-2.5 top-2.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Soon
        </span>
      ) : null}
    </div>
  );
}

// ===== Subdomain input =====
// `https://` prefix + `.ironforge.rickycaballero.com` suffix wrap the
// input so the user sees the full URL shape they're committing to.
// The wrap shares its border + focus ring with the inner input by
// applying focus-within styling at the wrap level.

const SubdomainInput = ({
  id,
  describedBy,
  invalid,
  disabled,
  ...registerProps
}: {
  id: string;
  describedBy: string;
  invalid: boolean;
  disabled: boolean;
} & ReturnType<ReturnType<typeof useForm<FormValues>>["register"]>) => {
  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border bg-surface-2 transition-colors",
        invalid
          ? "border-destructive focus-within:border-destructive focus-within:ring-2 focus-within:ring-destructive/20"
          : "focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20",
        disabled && "opacity-50",
      )}
    >
      <span className="grid place-items-center border-r bg-card/40 px-2.5 font-mono text-[12px] text-fg-subtle">
        https://
      </span>
      <Input
        id={id}
        type="text"
        placeholder="my-portfolio-site"
        autoComplete="off"
        autoFocus
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        className="flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
        {...registerProps}
      />
      <span className="grid place-items-center border-l bg-card/40 px-2.5 font-mono text-[12px] text-fg-subtle">
        .ironforge.rickycaballero.com
      </span>
    </div>
  );
};

// ===== Summary block =====
// Live preview of what will be created. Name slot is bound to the form
// input — typing updates the subdomain / repo / IAM role fields in
// real time, which is the load-bearing affordance the user's "feels
// like a confirmation flow" guidance asked for. Empty slot shows a
// dimmed placeholder so the layout stays stable.

function SummaryBlock({
  name,
  owner,
}: {
  name: string;
  owner: string;
}): React.ReactNode {
  const placeholder = "<service-name>";
  const display = name.length > 0 ? name : placeholder;
  const isPlaceholder = name.length === 0;

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted-foreground">
        Review what will be created. The 8-step workflow takes about 5 minutes
        in production; ~20 seconds in the demo.
      </p>

      <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <Term>Name</Term>
        <Def value={display} mono dim={isPlaceholder} />

        <Term>Template</Term>
        <Def value="static-site" mono />

        <Term>Subdomain</Term>
        <dd className="m-0 break-all">
          <span className={cn("font-mono", isPlaceholder ? "text-fg-faint" : "text-primary")}>
            https://{display}.ironforge.rickycaballero.com
          </span>
        </dd>

        <Term>GitHub repo</Term>
        <Def value={`ironforge-svc/${display}`} mono dim={isPlaceholder} />

        <Term>IAM role</Term>
        <Def value={`ironforge-svc-${display}-deploy`} mono dim={isPlaceholder} />

        <Term>Region</Term>
        <Def value="us-east-1" mono />

        <Term>Owner</Term>
        <Def value={owner} />
      </dl>

      <div>
        <div className="mb-2 text-[12.5px] font-medium">Workflow that will run</div>
        <ol className="grid grid-cols-1 gap-y-1 sm:grid-cols-2">
          {PROVISION_STEPS.map((step, i) => (
            <li
              key={step.name}
              className="flex items-center gap-2 text-[12px] text-muted-foreground"
            >
              <span className="w-4 tabular-nums text-fg-faint">{i + 1}.</span>
              <span className="font-mono text-[11.5px]">{step.name}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Term({ children }: { children: React.ReactNode }): React.ReactNode {
  return <dt className="font-normal text-fg-subtle">{children}</dt>;
}

function Def({
  value,
  mono,
  dim,
}: {
  value: string;
  mono?: boolean;
  dim?: boolean;
}): React.ReactNode {
  return (
    <dd
      className={cn(
        "m-0 break-all",
        mono && "font-mono",
        dim ? "text-fg-faint" : "text-foreground",
      )}
    >
      {value}
    </dd>
  );
}

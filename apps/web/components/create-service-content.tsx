"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import {
  ServiceNameSchema,
  type CreateServiceRequest,
  type CreateServiceResponse,
} from "@ironforge/shared-types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BackLink } from "@/components/back-link";
import { ApiClientError } from "@/lib/api-client";

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

export function CreateServiceContent({
  apiClient,
  basePath,
  backHref,
  backLabel,
  catalogQueryKey = ["services"],
  onCreated,
}: {
  apiClient: CreateServiceClient;
  /** Routing prefix for success redirect (`${basePath}/${id}`). Production: "/services". Demo: "/demo/services". */
  basePath: string;
  /** Back-link + Cancel target (the catalog surface). Production: "/services". Demo: "/demo". */
  backHref: string;
  backLabel: string;
  catalogQueryKey?: readonly unknown[];
  onCreated?: (response: CreateServiceResponse) => void;
}): React.ReactNode {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const form = useForm<FormValues>({
    defaultValues: { name: "" },
  });

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
  const fieldError = form.formState.errors.name?.message;

  const formError =
    mutation.isError &&
    !(mutation.error instanceof ApiClientError && mutation.error.code === "CONFLICT")
      ? mutation.error
      : null;

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-xl px-6 py-16 sm:py-24">
        <BackLink href={backHref} label={backLabel} className="mb-6" />
        <header>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Create service
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Provision a new static site. Within ~5 minutes you'll have a
            subdomain, TLS certificate, GitHub repository, and CI/CD pipeline.
          </p>
        </header>

        <form
          className="mt-10"
          onSubmit={form.handleSubmit((values) => mutation.mutate(values))}
          noValidate
        >
          <Card>
            <CardHeader>
              <CardTitle>Service details</CardTitle>
              <CardDescription>
                The service name becomes your subdomain
                (&lt;name&gt;.ironforge.rickycaballero.com), the GitHub repo
                name, and the IAM role name. It cannot be changed after
                creation.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor={nameInputId}>Name</Label>
                <Input
                  id={nameInputId}
                  type="text"
                  placeholder="my-portfolio-site"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? nameErrorId : undefined}
                  disabled={mutation.isPending}
                  {...form.register("name", { validate: validateName })}
                />
                <p className="text-xs text-muted-foreground">
                  3–63 characters; lowercase alphanumeric with optional
                  hyphens; cannot start or end with a hyphen.
                </p>
                {fieldError ? (
                  <p
                    id={nameErrorId}
                    className="text-sm font-medium text-destructive"
                  >
                    {fieldError}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label>Template</Label>
                <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
                  static-site
                </p>
                <p className="text-xs text-muted-foreground">
                  The static-site template is the only option at MVP scope.
                  Additional templates (API services, scheduled jobs) land in
                  later phases.
                </p>
              </div>

              {formError ? (
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
              ) : null}
            </CardContent>
          </Card>

          <div className="mt-6 flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(backHref)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Provisioning…" : "Provision"}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}

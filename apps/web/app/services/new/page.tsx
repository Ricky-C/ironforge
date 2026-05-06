"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { ServiceNameSchema } from "@ironforge/shared-types";
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
import { ApiClientError, apiClient } from "@/lib/api-client";

// Form values: only `name` is user-collected at single-template scope.
// `templateId` is hard-coded to "static-site" at submit (the only
// registered template; per ADR-010 amendment 2026-05-06, the form
// stays single-step until template #2 introduces non-trivial inputs
// that motivate multi-step shape). `inputs` is `{}` per
// StaticSiteInputsSchema (zero inputs).
//
// Validation uses react-hook-form's native `validate` callback with
// ServiceNameSchema.safeParse rather than @hookform/resolvers/zod.
// The resolver package's pnpm-strict packaging is broken for zod v4
// sub-path imports (`zod/v4/core`); native validate sidesteps the
// dep entirely and keeps the validation logic centralized in the
// shared schema.
type FormValues = {
  name: string;
};

const validateName = (value: string): true | string => {
  const result = ServiceNameSchema.safeParse(value);
  if (result.success) return true;
  return result.error.issues[0]?.message ?? "invalid service name";
};

export default function CreateServicePage(): React.ReactNode {
  const router = useRouter();
  const queryClient = useQueryClient();

  // Idempotency-Key per form mount. Stable across re-renders within
  // the same form attempt; refreshes when the user navigates away
  // and back (i.e., genuinely new submission). Per the project's
  // two-pattern idempotency convention (HTTP-level via header +
  // backend DynamoDB lookup; workflow-level handled separately by
  // SFN execution-name).
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
      // Seed the detail-page cache so the destination route renders
      // the new service without a fetch round-trip. Mirrors the
      // pattern used by the deprovision flow.
      queryClient.setQueryData(["service", data.service.id], data.service);
      // Invalidate the catalog so the new service shows up on next
      // visit.
      queryClient.invalidateQueries({ queryKey: ["services"] });
      router.push(`/services/${data.service.id}`);
    },
    onError: (error) => {
      // CONFLICT (409: name already exists) maps to a field-level
      // error on `name`; other errors surface at form level via the
      // alert below. RHF's setError with shouldFocus pulls the user
      // back to the offending field.
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

  // Form-level error from mutation (excluding CONFLICT, which maps
  // to the field error above).
  const formError =
    mutation.isError &&
    !(mutation.error instanceof ApiClientError && mutation.error.code === "CONFLICT")
      ? mutation.error
      : null;

  return (
    <main className="min-h-screen">
      <div className="mx-auto max-w-xl px-6 py-16 sm:py-24">
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
              onClick={() => router.push("/services")}
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

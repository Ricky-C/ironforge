import {
  ApiResponseSchema,
  CreateServiceResponseSchema,
  DeprovisionServiceResponseSchema,
  ServiceJobResponseSchema,
  ServiceJobStepListResponseSchema,
  ServiceListResponseSchema,
  ServiceSchema,
  type CreateServiceRequest,
  type CreateServiceResponse,
  type DeprovisionServiceResponse,
  type Service,
  type ServiceJobResponse,
  type ServiceJobStepListResponse,
  type ServiceListResponse,
} from "@ironforge/shared-types";

import { ApiClientError } from "./index";

// Demo api-client — companion to subphase 2.6's `/api/demo/*` backend
// (PR #125). Same method surface as the production `apiClient`, but:
//   - paths target `/api/demo/*` (separate Hono router, no auth)
//   - NO Bearer header injection (gateway-level NONE auth on these
//     routes; backend doesn't read or expect Authorization)
//   - same response envelope + Zod validation as production (drift
//     protection — a demo response that doesn't parse against the
//     production schema is a backend bug, not a client compat hack)
//
// Inline `request` helper — small duplication vs the production
// `request` is acceptable at portfolio scope. Production needs the
// UserManager dependency for token injection; mixing into one helper
// would force the demo client to also depend on UserManager. Keep
// them separate.

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"];

const request = async <T>(
  path: string,
  init: RequestInit,
  dataSchema: Parameters<typeof ApiResponseSchema>[0],
): Promise<T> => {
  if (!API_BASE_URL) {
    throw new ApiClientError({
      code: "API_BASE_URL_UNSET",
      message:
        "NEXT_PUBLIC_API_BASE_URL not set at build time. Configure as a Docker --build-arg in CI and in apps/web/.env.local for local dev.",
      status: 0,
    });
  }

  const url = `${API_BASE_URL}${path}`;
  const response = await fetch(url, init);

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiClientError({
      code: "INVALID_RESPONSE",
      message: `non-JSON response from ${url} (status ${response.status})`,
      status: response.status,
    });
  }

  const parsed = ApiResponseSchema(dataSchema).safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError({
      code: "INVALID_ENVELOPE",
      message: `unexpected response envelope from ${url}: ${parsed.error.message}`,
      status: response.status,
    });
  }

  if (!parsed.data.ok) {
    throw new ApiClientError({
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      status: response.status,
    });
  }

  return parsed.data.data as T;
};

// Static catalog UUIDs — must mirror lib/demo-state.ts on the backend.
// The frontend uses these to gate the Deprovision button (defense in
// depth alongside the backend's 404 on DELETE for these IDs).
export const DEMO_STATIC_LIVE_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_STATIC_PROVISIONING_ID = "22222222-2222-4222-8222-222222222222";
export const DEMO_STATIC_FAILED_ID = "33333333-3333-4333-8333-333333333333";

const STATIC_DEMO_IDS = new Set<string>([
  DEMO_STATIC_LIVE_ID,
  DEMO_STATIC_PROVISIONING_ID,
  DEMO_STATIC_FAILED_ID,
]);

export const isStaticDemoId = (id: string): boolean => STATIC_DEMO_IDS.has(id);

// Visitor-typed names for ephemeral demo services live in
// sessionStorage. Backend computes synthetic names from ID prefix
// (stateless), so the visitor's chosen name only appears in the POST
// response. Cache it client-side so the detail page can display it.
// sessionStorage scope: tab-lifetime (matches "ephemeral resets on
// refresh" per the PR-A scope).

const NAME_CACHE_KEY = "ironforge-demo-ephemeral-names";

const readNameCache = (): Record<string, string> => {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(NAME_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
};

const writeNameCache = (cache: Record<string, string>): void => {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(NAME_CACHE_KEY, JSON.stringify(cache));
};

export const cacheDemoEphemeralName = (id: string, name: string): void => {
  const cache = readNameCache();
  cache[id] = name;
  writeNameCache(cache);
};

export const readDemoEphemeralName = (id: string): string | undefined => {
  return readNameCache()[id];
};

// `deprovisionJobId` query-param helper. URL-encoded state per the
// demo deprovision-theater design: visitors who refresh / share /
// bookmark `/demo/services/<id>?deprovisionJobId=<uuid>` continue to
// see correctly-elapsed deprovision state. Empty when not in the
// post-DELETE lifecycle phase.
const deprovQuery = (deprovisionJobId: string | undefined): string =>
  deprovisionJobId
    ? `?deprovisionJobId=${encodeURIComponent(deprovisionJobId)}`
    : "";

// Demo api-client — same shape as production apiClient. Methods that
// fetch service / job / steps accept an optional `deprovisionJobId`;
// when set, the demo backend computes deprovision-state-derived
// responses instead of provision-state. Production's apiClient accepts
// the same param signature for interface parity but ignores it (real
// workflow state lives in DynamoDB).

export const demoApiClient = {
  getService: (id: string, deprovisionJobId?: string): Promise<Service> =>
    request<Service>(
      `/api/demo/services/${id}${deprovQuery(deprovisionJobId)}`,
      { method: "GET" },
      ServiceSchema,
    ),

  deprovisionService: (id: string): Promise<DeprovisionServiceResponse> =>
    request<DeprovisionServiceResponse>(
      `/api/demo/services/${id}`,
      { method: "DELETE" },
      DeprovisionServiceResponseSchema,
    ),

  listServices: (): Promise<ServiceListResponse> =>
    request<ServiceListResponse>(
      `/api/demo/services`,
      { method: "GET" },
      ServiceListResponseSchema,
    ),

  createService: (
    body: CreateServiceRequest,
    idempotencyKey: string,
  ): Promise<CreateServiceResponse> =>
    request<CreateServiceResponse>(
      `/api/demo/services`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Demo backend accepts but ignores Idempotency-Key (state is
          // stateless; no dedup needed). Sending it keeps the request
          // shape identical to production for clean wire parity.
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      CreateServiceResponseSchema,
    ),

  getServiceJob: (
    id: string,
    deprovisionJobId?: string,
  ): Promise<ServiceJobResponse> =>
    request<ServiceJobResponse>(
      `/api/demo/services/${id}/job${deprovQuery(deprovisionJobId)}`,
      { method: "GET" },
      ServiceJobResponseSchema,
    ),

  listJobSteps: (
    id: string,
    jobId: string,
    deprovisionJobId?: string,
  ): Promise<ServiceJobStepListResponse> =>
    request<ServiceJobStepListResponse>(
      `/api/demo/services/${id}/jobs/${jobId}/steps${deprovQuery(deprovisionJobId)}`,
      { method: "GET" },
      ServiceJobStepListResponseSchema,
    ),
};

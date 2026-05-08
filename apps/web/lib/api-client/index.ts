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

// Direct fetch to API Gateway with the access token from oidc-client-ts
// UserManager. PR-A landed CORS for the dev SPA origin; PR-B (this) drops
// the dev BFF in favor of browser-direct calls.
//
// The base URL is build-time config: NEXT_PUBLIC_API_BASE_URL. Build-arg
// threading per the PR description (.github/workflows/app-deploy.yml).
// Local dev reads from apps/web/.env.local.

import { getUserManager } from "@/lib/auth/user-manager";

const API_BASE_URL = process.env["NEXT_PUBLIC_API_BASE_URL"];

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor({
    code,
    message,
    status,
  }: {
    code: string;
    message: string;
    status: number;
  }) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

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

  const user = await getUserManager().getUser();
  if (user === null || user.expired) {
    throw new ApiClientError({
      code: "UNAUTHENTICATED",
      message: "no signed-in user; sign in via the header to continue",
      status: 401,
    });
  }

  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${user.access_token}`);
  const response = await fetch(url, { ...init, headers });

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

// Optional query params for listServices; cursor + limit map to the
// backend's GET /api/services?cursor=&limit=. cursor is the opaque
// base64url-encoded string returned in the previous response (or null
// for the first page). limit defaults server-side to 20 (range 1-100);
// frontend can omit. Designed to compose with TanStack Query's
// useInfiniteQuery — pass `cursor` directly from `pageParam`.
export type ListServicesParams = {
  cursor?: string | null;
  limit?: number;
};

const buildListServicesQuery = (params: ListServicesParams): string => {
  const search = new URLSearchParams();
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  return qs ? `?${qs}` : "";
};

export const apiClient = {
  getService: (id: string, _deprovisionJobId?: string): Promise<Service> =>
    request<Service>(`/api/services/${id}`, { method: "GET" }, ServiceSchema),

  // DELETE /api/services/:id — kicks off deprovisioning (or returns the
  // existing in-flight Job if status is already deprovisioning). Returns
  // the full {service, job} composite so callers can link to job-status
  // polling (subphase 2.4) without an extra fetch. Errors flow through
  // the standard ApiClientError path: SERVICE_IN_FLIGHT (409 — caller
  // is expected to wait), NOT_FOUND (404 — archived or never existed),
  // INTERNAL (500) all surface with code/message/status.
  deprovisionService: (id: string): Promise<DeprovisionServiceResponse> =>
    request<DeprovisionServiceResponse>(
      `/api/services/${id}`,
      { method: "DELETE" },
      DeprovisionServiceResponseSchema,
    ),

  // GET /api/services — owner-scoped, cursor-paginated list. Default
  // order newest_first, limit 20. Returns { items, cursor }; cursor is
  // null on the last page (use that to short-circuit useInfiniteQuery's
  // hasNextPage). Errors flow through ApiClientError as usual.
  listServices: (params: ListServicesParams = {}): Promise<ServiceListResponse> =>
    request<ServiceListResponse>(
      `/api/services${buildListServicesQuery(params)}`,
      { method: "GET" },
      ServiceListResponseSchema,
    ),

  // POST /api/services — kicks off provisioning. Returns the new
  // {service, job} composite. Idempotency-Key prevents double-create
  // on retry per the project's two-pattern idempotency convention
  // (HTTP-level here; the workflow-level pattern uses the SFN
  // execution name). Caller passes a stable key per submit attempt
  // (typically a crypto.randomUUID generated when the form mounts).
  // Errors:
  //   - INVALID_REQUEST (400): body shape failed CreateServiceRequestSchema
  //   - UNKNOWN_TEMPLATE (400): templateId not in registry
  //   - INVALID_INPUTS (400): inputs failed per-template schema
  //   - CONFLICT (409): a service with the same name already exists
  //   - INTERNAL (500): server error
  createService: (
    body: CreateServiceRequest,
    idempotencyKey: string,
  ): Promise<CreateServiceResponse> =>
    request<CreateServiceResponse>(
      `/api/services`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      CreateServiceResponseSchema,
    ),

  // GET /api/services/:id/job — most recently-created Job for the
  // service. `data.job` is null when the Service has no Jobs yet
  // (transitional pending → first-kickoff window). Polled by the
  // detail page's JobProgress component on a 2s cadence while the
  // Job is non-terminal; the polling consumer detects terminal
  // status by `data.job?.status` ∈ {succeeded, failed, cancelled}
  // and stops polling.
  //
  // The trailing `_deprovisionJobId` is signature-shape parity with
  // demoApiClient (which uses it as a URL query param to compute
  // deprovision-state). Production has real workflow state; the
  // param is accepted but ignored. Keeps JobProgressClient one
  // interface across both clients without forcing demo-specific
  // narrowing.
  getServiceJob: (
    id: string,
    _deprovisionJobId?: string,
  ): Promise<ServiceJobResponse> =>
    request<ServiceJobResponse>(
      `/api/services/${id}/job`,
      { method: "GET" },
      ServiceJobResponseSchema,
    ),

  // GET /api/services/:id/jobs/:jobId/steps — JobStep[] for the
  // given Job. Items come back in DynamoDB SK-alphabetic order
  // (STEP#<name>); presentation sort by `startedAt` happens
  // client-side because workflow ordering is the meaningful one
  // for users. Returns `{ items: [] }` cleanly when no steps have
  // been written yet (workflow kickoff window, deprovisioning's
  // long deprovision-terraform stage). The trailing
  // `_deprovisionJobId` is signature parity with demoApiClient;
  // ignored here.
  listJobSteps: (
    id: string,
    jobId: string,
    _deprovisionJobId?: string,
  ): Promise<ServiceJobStepListResponse> =>
    request<ServiceJobStepListResponse>(
      `/api/services/${id}/jobs/${jobId}/steps`,
      { method: "GET" },
      ServiceJobStepListResponseSchema,
    ),
};

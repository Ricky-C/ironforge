import {
  ApiResponseSchema,
  CreateServiceResponseSchema,
  DeprovisionServiceResponseSchema,
  ServiceListResponseSchema,
  ServiceSchema,
  type CreateServiceRequest,
  type CreateServiceResponse,
  type DeprovisionServiceResponse,
  type Service,
  type ServiceListResponse,
} from "@ironforge/shared-types";

// Where API calls go:
// - Dev: /api/dev/proxy/[...path] forwards server-side with Bearer token.
// - Prod (subphase 2.5): direct fetch to the API with the access token
//   from oidc-client-ts UserManager. Replaces the dev proxy.
//
// The transport branch lives here so callers (components, hooks) stay
// stable across the 2.5 swap.

const PROXY_BASE = "/api/dev/proxy";

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
  const url = `${PROXY_BASE}${path}`;
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
  getService: (id: string): Promise<Service> =>
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
};

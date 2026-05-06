import {
  ApiResponseSchema,
  ServiceSchema,
  type Service,
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

export const apiClient = {
  getService: (id: string): Promise<Service> =>
    request<Service>(`/api/services/${id}`, { method: "GET" }, ServiceSchema),
};

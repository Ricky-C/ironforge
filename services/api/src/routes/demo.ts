import {
  CreateServiceRequestSchema,
  ServiceSchema,
  type ApiFailure,
  type ApiResponse,
  type Job,
  type JobStep,
  type Service,
} from "@ironforge/shared-types";
import { Hono } from "hono";

import type { AppEnv } from "../env.js";
import {
  DEMO_OWNER_ID,
  PROVISION_TOTAL_MS,
  computeDeprovisionJob,
  computeDeprovisionService,
  computeDeprovisionSteps,
  generateEphemeralServiceId,
  getDemoCatalog,
  getDemoJob,
  getDemoService,
  getDemoSteps,
  isDemoId,
  isEphemeralDemoId,
  isStaticDemoId,
} from "../lib/demo-state.js";

// Public demo router mounted at /api/demo. Companion to subphase 2.6
// (per ADR-010's "different API client target" pattern). Backend
// behavior:
//
// - State is computed deterministically by lib/demo-state from (id, now);
//   no DynamoDB reads or writes. Lambda stays stateless for demo paths.
// - Same Zod schemas validate response shapes as the production routes
//   (per ADR-010 amendment 2026-05-07: "drift protection"). A demo
//   response that doesn't parse against ServiceSchema / JobSchema /
//   JobStepSchema is a bug in lib/demo-state, surfaced loudly.
// - Static catalog: 3 services (live + provisioning + failed) for
//   state-machine variety. DELETE on these returns 404 — they represent
//   "the platform's existing services" and aren't deprovisionable.
// - Ephemeral services: created via POST, ID encodes timestamp (UUID
//   v7), state advances over ~30s as elapsed time crosses the
//   PROVISION_TIMELINE offsets. DELETE on these returns archived
//   immediately (no deprovision timeline — demo doesn't need to fake
//   AWS cleanup time; production does because real AWS cleanup takes
//   minutes).
//
// Auth posture: this router runs without a Cognito-authenticated user.
// API Gateway routes /api/demo/{proxy+} with authorization_type=NONE,
// and handler.ts wraps the global /api/* auth middleware to skip when
// the request path starts with /api/demo/ (trailing slash, precision).

export const demoRoutes = new Hono<AppEnv>();

const NOT_FOUND_BODY: ApiFailure = {
  ok: false,
  error: { code: "NOT_FOUND", message: "service not found" },
};

const INVALID_REQUEST = (message: string): ApiFailure => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message },
});

// Wraps an entity in the canonical API success envelope. Helper exists
// to keep individual handlers tight; the envelope is uniform across
// the demo surface.
const ok = <T>(data: T): ApiResponse<T> => ({ ok: true, data });

// ---------------------------------------------------------------------
// GET /api/demo/health — auth-bypass smoke target
// ---------------------------------------------------------------------

demoRoutes.get("/health", (c) =>
  c.json(ok({ status: "ok" as const }), 200),
);

// ---------------------------------------------------------------------
// GET /api/demo/services — static catalog (3 entries, no pagination)
// ---------------------------------------------------------------------

demoRoutes.get("/services", (c) => {
  const services = getDemoCatalog();
  // Validate against the same schemas production uses. A drift here is
  // a demo-state bug; surface as 500 rather than a malformed envelope.
  for (const s of services) {
    const parsed = ServiceSchema.safeParse(s);
    if (!parsed.success) {
      c.get("logger").error("demo catalog entry failed schema validation", {
        id: s.id,
        zodErrors: parsed.error.format(),
      });
      return c.json<ApiFailure>(
        { ok: false, error: { code: "INTERNAL", message: "internal server error" } },
        500,
      );
    }
  }
  return c.json(ok({ items: services, cursor: null }), 200);
});

// ---------------------------------------------------------------------
// POST /api/demo/services — create ephemeral; returns provisioning shape
// ---------------------------------------------------------------------

demoRoutes.post("/services", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(INVALID_REQUEST("request body is not valid JSON"), 400);
  }

  const parsed = CreateServiceRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      INVALID_REQUEST(`request body failed validation: ${parsed.error.message}`),
      400,
    );
  }

  const now = Date.now();
  const serviceId = generateEphemeralServiceId(now);
  const service = getDemoService(serviceId, now);
  const job = getDemoJob(serviceId, now);
  if (service === null || job === null) {
    // Unreachable: we just generated a v7 UUID; getDemoService /
    // getDemoJob should both resolve. Fail-loud if not.
    c.get("logger").error("freshly-generated ephemeral demo id failed lookup", {
      serviceId,
    });
    return c.json<ApiFailure>(
      { ok: false, error: { code: "INTERNAL", message: "internal server error" } },
      500,
    );
  }

  // Override name from the request body so the visitor sees the name
  // they typed reflected in the response. ownerId stays DEMO_OWNER_ID
  // — demo never touches real ownership.
  const responseService: Service = {
    ...service,
    name: parsed.data.name,
    ownerId: DEMO_OWNER_ID,
  };

  return c.json(ok({ service: responseService, job }), 201);
});

// ---------------------------------------------------------------------
// GET /api/demo/services/:id — service detail (static or ephemeral);
// optional ?deprovisionJobId=<v7-uuid> returns deprovision-state-
// computed response instead. URL-encoded state per the design: visitors
// who refresh / share the URL during deprovisioning continue to see
// correctly-elapsed state. Malformed deprovisionJobId falls through to
// the standard provision-state path (graceful degradation).
// ---------------------------------------------------------------------

demoRoutes.get("/services/:id", (c) => {
  const id = c.req.param("id");
  if (!isDemoId(id)) {
    return c.json(NOT_FOUND_BODY, 404);
  }
  const now = Date.now();

  const deprovisionJobId = c.req.query("deprovisionJobId");
  if (deprovisionJobId !== undefined) {
    const deprovService = computeDeprovisionService(id, deprovisionJobId, now);
    if (deprovService !== null) {
      return c.json(ok(deprovService), 200);
    }
    // Malformed deprovisionJobId — fall through to standard path.
  }

  const service = getDemoService(id, now);
  if (service === null) {
    return c.json(NOT_FOUND_BODY, 404);
  }
  return c.json(ok(service), 200);
});

// ---------------------------------------------------------------------
// DELETE /api/demo/services/:id — ephemeral only; static returns 404
// ---------------------------------------------------------------------

demoRoutes.delete("/services/:id", (c) => {
  const id = c.req.param("id");

  // Static catalog services are not deprovisionable — they represent
  // platform-side existing services in the demo narrative. Frontend
  // gates the button as defense in depth; backend enforces here.
  if (isStaticDemoId(id)) {
    return c.json(NOT_FOUND_BODY, 404);
  }

  if (!isEphemeralDemoId(id)) {
    return c.json(NOT_FOUND_BODY, 404);
  }

  // Ephemeral DELETE: kicks off the deprovision theater. Generate a
  // fresh UUID v7 for the deprovision Job ID (timestamp-encoded with
  // `now`); subsequent polls carrying the deprovisionJobId via query
  // param compute current deprovision phase from elapsed-since-now.
  // Response shape mirrors production's DELETE — service in
  // `deprovisioning` status, Job in `running` with the deprovision-
  // terraform step starting. The frontend reads response.job.id and
  // navigates to /demo/services/<id>?deprovisionJobId=<that-id>; URL-
  // encoded state preserves the lifecycle view across refresh / share
  // / bookmark.
  const now = Date.now();
  const deprovJobId = generateEphemeralServiceId(now);

  const deprovService = computeDeprovisionService(id, deprovJobId, now);
  const deprovJob = computeDeprovisionJob(id, deprovJobId, now);
  if (deprovService === null || deprovJob === null) {
    // Unreachable: id was just confirmed ephemeral, deprovJobId was
    // just generated as a valid v7 UUID. Fail-loud if not.
    c.get("logger").error("freshly-generated deprovision IDs failed compute", {
      serviceId: id,
      deprovJobId,
    });
    return c.json<ApiFailure>(
      { ok: false, error: { code: "INTERNAL", message: "internal server error" } },
      500,
    );
  }

  return c.json(ok({ service: deprovService, job: deprovJob }), 202);
});

// ---------------------------------------------------------------------
// GET /api/demo/services/:id/job — most-recent Job; ?deprovisionJobId=
// switches to deprovision-state-computed Job
// ---------------------------------------------------------------------

demoRoutes.get("/services/:id/job", (c) => {
  const id = c.req.param("id");
  if (!isDemoId(id)) {
    return c.json(NOT_FOUND_BODY, 404);
  }
  const now = Date.now();

  const deprovisionJobId = c.req.query("deprovisionJobId");
  if (deprovisionJobId !== undefined) {
    const deprovJob = computeDeprovisionJob(id, deprovisionJobId, now);
    if (deprovJob !== null) {
      return c.json<ApiResponse<{ job: Job | null }>>(ok({ job: deprovJob }), 200);
    }
    // Malformed param — fall through.
  }

  const job = getDemoJob(id, now);
  return c.json<ApiResponse<{ job: Job | null }>>(ok({ job }), 200);
});

// ---------------------------------------------------------------------
// GET /api/demo/services/:id/jobs/:jobId/steps — JobStep[] for a Job;
// ?deprovisionJobId= switches to deprovision-step-list. The :jobId path
// param is the Job ID the client is asking about; deprovisionJobId is
// the lifecycle context (which timeline to compute against).
// ---------------------------------------------------------------------

demoRoutes.get("/services/:id/jobs/:jobId/steps", (c) => {
  const id = c.req.param("id");
  if (!isDemoId(id)) {
    return c.json(NOT_FOUND_BODY, 404);
  }
  const now = Date.now();

  const deprovisionJobId = c.req.query("deprovisionJobId");
  if (deprovisionJobId !== undefined) {
    const deprovSteps = computeDeprovisionSteps(deprovisionJobId, now);
    // Deprovision steps array is non-empty when at least one timeline
    // entry has elapsed past its startMs; empty during the initial
    // sub-500ms window. Return empty array honestly; matches the
    // production polling shape (no "I don't know" fallback).
    return c.json<ApiResponse<{ items: JobStep[] }>>(ok({ items: deprovSteps }), 200);
  }

  const items = getDemoSteps(id, now);
  return c.json<ApiResponse<{ items: JobStep[] }>>(ok({ items }), 200);
});

// PROVISION_TOTAL_MS export reaffirms the contract with the frontend's
// timer-based UI (PR-B may render its own progress indicator anchored
// to this total). Re-exported here so consumers don't have to dig into
// lib/demo-state for the constant.
export { PROVISION_TOTAL_MS };

import { randomBytes } from "node:crypto";

import {
  STEP_NAMES,
  type Job,
  type JobStep,
  type Service,
} from "@ironforge/shared-types";

// Pure state computation for the unauthenticated demo surface (subphase
// 2.6). No I/O, no DynamoDB — every demo response is computed from
// (id, now). That keeps the demo Lambda stateless and refresh-resilient:
// each poll recomputes from the same inputs and lands at the same
// answer. State variety + deterministic timeline give visitors a
// realistic feel without any real provisioning side-effects.
//
// ID conventions:
//   - STATIC catalog entries: three fixed UUIDs (DEMO_STATIC_*),
//     hand-picked. Each has a fixed status (live / provisioning /
//     failed) so the catalog demonstrates state variety. State is
//     literal — no time advancement on poll.
//   - EPHEMERAL services: UUID v7 generated at POST. The first 48 bits
//     encode the millisecond timestamp; computeEphemeralServiceState
//     parses it and derives current state from elapsed time. Ephemeral
//     services are NOT persisted anywhere; poll responses recompute on
//     each call.
//
// All Service / Job / JobStep responses validate against the same Zod
// schemas as production (per ADR-010 amendment 2026-05-07: "same Zod
// schemas validate demo responses — drift protection"). Demo state's
// shape can never silently diverge from production state's shape.

// ---------------------------------------------------------------------
// Constants — owner, IDs, baselines
// ---------------------------------------------------------------------

// Fake ownerId for all demo services. Cognito sub is a UUID; this one
// is a literal placeholder ("nil"-shape) that doesn't collide with any
// real Cognito user. Demo services never interact with the production
// ownership model — they live behind an unauthenticated API path.
export const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000000";

// Static catalog UUIDs — hand-picked, recognizable patterns.
export const DEMO_STATIC_LIVE_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_STATIC_PROVISIONING_ID = "22222222-2222-4222-8222-222222222222";
export const DEMO_STATIC_FAILED_ID = "33333333-3333-4333-8333-333333333333";

// Static job UUIDs — paired with the service IDs above. Distinct so the
// demo response shape mirrors production (where service.id != job.id).
const DEMO_STATIC_LIVE_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEMO_STATIC_PROVISIONING_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEMO_STATIC_FAILED_JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Fixed reference timestamp for static catalog entries. Far enough in
// the past that "createdAt: yesterday" looks plausible for the live /
// failed entries; close enough to feel like recent platform activity.
// Picked deterministically — never changes on poll, never drifts.
const STATIC_BASELINE_ISO = "2026-05-07T00:00:00.000Z";
const STATIC_BASELINE_MS = Date.parse(STATIC_BASELINE_ISO);

// ---------------------------------------------------------------------
// Provisioning timeline — 30s total, 10x compression of the real ~5min
// workflow. Preserves the "feel" of the real run: short kickoff steps,
// a long run-terraform phase, then a deploy + finalize tail.
// ---------------------------------------------------------------------

type StepOffset = {
  stepName: (typeof STEP_NAMES)[number];
  startMs: number;
  endMs: number;
};

export const EPHEMERAL_PROVISION_TIMELINE: readonly StepOffset[] = [
  { stepName: "validate-inputs", startMs: 1000, endMs: 2000 },
  { stepName: "create-repo", startMs: 2000, endMs: 4000 },
  { stepName: "generate-code", startMs: 4000, endMs: 7000 },
  { stepName: "run-terraform", startMs: 7000, endMs: 22000 },
  { stepName: "wait-for-cloudfront", startMs: 22000, endMs: 23000 },
  { stepName: "trigger-deploy", startMs: 23000, endMs: 25000 },
  { stepName: "wait-for-deploy", startMs: 25000, endMs: 29000 },
  { stepName: "finalize", startMs: 29000, endMs: 30000 },
];

export const PROVISION_TOTAL_MS = 30_000;

export const EPHEMERAL_DEPROVISION_TIMELINE: readonly StepOffset[] = [
  { stepName: "deprovision-terraform", startMs: 500, endMs: 8000 },
  { stepName: "deprovision-external-resources", startMs: 8000, endMs: 10000 },
];

export const DEPROVISION_TOTAL_MS = 10_000;

// ---------------------------------------------------------------------
// ID generation + parsing (UUID v7 for ephemeral)
// ---------------------------------------------------------------------

// UUID v7: 48-bit timestamp (ms) + 4-bit version (7) + 12-bit random
// + 2-bit variant (10) + 62-bit random. Time-ordered, parseable.
// Production schemas accept any UUID version (Zod's .uuid() validates
// format only, not version), so v7 passes ServiceSchema validation.
//
// Implementation: build the canonical 16-byte UUID layout in a buffer,
// then format. Avoids off-by-one errors from byte-boundary fiddling
// with hex strings.
export const generateEphemeralServiceId = (now: number): string => {
  if (now < 0 || !Number.isInteger(now)) {
    throw new Error(
      `generateEphemeralServiceId requires a non-negative integer ms; got ${now}`,
    );
  }
  const buf = Buffer.alloc(16);
  // Bytes 0-5: 48-bit timestamp (ms), big-endian.
  buf.writeUIntBE(now, 0, 6);
  // Bytes 6-15: 10 random bytes.
  randomBytes(10).copy(buf, 6);
  // Byte 6: version nibble (7) in high 4 bits; low 4 bits stay random.
  buf[6] = 0x70 | (buf[6]! & 0x0f);
  // Byte 8: variant nibble (10) in top 2 bits; bottom 6 bits stay random.
  buf[8] = 0x80 | (buf[8]! & 0x3f);

  const hex = buf.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const parseEphemeralTimestamp = (id: string): number | null => {
  if (!UUID_V7_PATTERN.test(id)) return null;
  const tsHex = id.slice(0, 8) + id.slice(9, 13);
  const ts = parseInt(tsHex, 16);
  return Number.isFinite(ts) ? ts : null;
};

const STATIC_IDS = new Set<string>([
  DEMO_STATIC_LIVE_ID,
  DEMO_STATIC_PROVISIONING_ID,
  DEMO_STATIC_FAILED_ID,
]);

export const isStaticDemoId = (id: string): boolean => STATIC_IDS.has(id);

export const isEphemeralDemoId = (id: string): boolean => UUID_V7_PATTERN.test(id);

export const isDemoId = (id: string): boolean =>
  isStaticDemoId(id) || isEphemeralDemoId(id);

// Ephemeral Job ID: derived from service ID by flipping the UUID
// version nibble from 7 to 4. Same uniqueness, distinct from service
// id, deterministic. Static job IDs are hand-picked above.
const ephemeralJobIdFromServiceId = (serviceId: string): string =>
  serviceId.slice(0, 14) + "4" + serviceId.slice(15);

export const getJobIdForServiceId = (serviceId: string): string => {
  switch (serviceId) {
    case DEMO_STATIC_LIVE_ID:
      return DEMO_STATIC_LIVE_JOB_ID;
    case DEMO_STATIC_PROVISIONING_ID:
      return DEMO_STATIC_PROVISIONING_JOB_ID;
    case DEMO_STATIC_FAILED_ID:
      return DEMO_STATIC_FAILED_JOB_ID;
    default:
      return ephemeralJobIdFromServiceId(serviceId);
  }
};

// ---------------------------------------------------------------------
// Service / Job / JobStep computation
// ---------------------------------------------------------------------

const isoFromMs = (ms: number): string => new Date(ms).toISOString();

// Static catalog: returns a fixed Service entity for each known
// static ID. Returns null for unknown / non-static IDs.
const buildStaticService = (id: string): Service | null => {
  switch (id) {
    case DEMO_STATIC_LIVE_ID:
      return {
        id,
        name: "marketing-site",
        ownerId: DEMO_OWNER_ID,
        templateId: "static-site",
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + PROVISION_TOTAL_MS),
        inputs: {},
        currentJobId: null,
        status: "live",
        liveUrl: "https://marketing-site.demo.ironforge.example/",
        provisionedAt: isoFromMs(STATIC_BASELINE_MS + PROVISION_TOTAL_MS),
      };
    case DEMO_STATIC_PROVISIONING_ID:
      return {
        id,
        name: "blog",
        ownerId: DEMO_OWNER_ID,
        templateId: "static-site",
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + 14_000),
        inputs: {},
        currentJobId: DEMO_STATIC_PROVISIONING_JOB_ID,
        status: "provisioning",
        jobId: DEMO_STATIC_PROVISIONING_JOB_ID,
      };
    case DEMO_STATIC_FAILED_ID:
      return {
        id,
        name: "docs",
        ownerId: DEMO_OWNER_ID,
        templateId: "static-site",
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + 28_000),
        inputs: {},
        currentJobId: null,
        status: "failed",
        failureReason: "GitHub Actions deploy run did not complete within budget",
        failedAt: isoFromMs(STATIC_BASELINE_MS + 28_000),
        failedWorkflow: "provisioning",
      };
    default:
      return null;
  }
};

// Ephemeral service: state derived from elapsed time since the
// timestamp encoded in the UUID v7. Returns null if the ID isn't a
// recognized ephemeral demo ID.
//
// Phases:
//   elapsed < 1000ms       — pending (Job not yet kicked off)
//   1000ms <= elapsed < 30000ms — provisioning (Job running, steps advancing)
//   elapsed >= 30000ms     — live (provisionedAt = baseline + 30000ms)
const buildEphemeralService = (id: string, now: number): Service | null => {
  const ts = parseEphemeralTimestamp(id);
  if (ts === null) return null;
  const elapsed = now - ts;
  const createdAt = isoFromMs(ts);
  const baseService = {
    id,
    name: `demo-${id.slice(0, 8)}`,
    ownerId: DEMO_OWNER_ID,
    templateId: "static-site",
    createdAt,
    inputs: {},
  };

  if (elapsed < 1000) {
    return {
      ...baseService,
      updatedAt: createdAt,
      currentJobId: null,
      status: "pending",
    };
  }

  if (elapsed < PROVISION_TOTAL_MS) {
    const jobId = ephemeralJobIdFromServiceId(id);
    return {
      ...baseService,
      updatedAt: isoFromMs(ts + Math.min(elapsed, PROVISION_TOTAL_MS)),
      currentJobId: jobId,
      status: "provisioning",
      jobId,
    };
  }

  const provisionedMs = ts + PROVISION_TOTAL_MS;
  return {
    ...baseService,
    updatedAt: isoFromMs(provisionedMs),
    currentJobId: null,
    status: "live",
    liveUrl: `https://demo-${id.slice(0, 8)}.demo.ironforge.example/`,
    provisionedAt: isoFromMs(provisionedMs),
  };
};

export const getDemoService = (id: string, now: number): Service | null => {
  if (isStaticDemoId(id)) return buildStaticService(id);
  if (isEphemeralDemoId(id)) return buildEphemeralService(id, now);
  return null;
};

export const getDemoCatalog = (): Service[] => {
  const ids = [
    DEMO_STATIC_LIVE_ID,
    DEMO_STATIC_PROVISIONING_ID,
    DEMO_STATIC_FAILED_ID,
  ];
  return ids.map((id) => {
    const service = buildStaticService(id);
    if (service === null) {
      throw new Error(`buildStaticService returned null for known id ${id}`);
    }
    return service;
  });
};

// Job for a static service: fixed Job entity matching the service's
// status. For ephemeral: derived from elapsed time same as the service.
const buildStaticJob = (id: string): Job | null => {
  switch (id) {
    case DEMO_STATIC_LIVE_ID:
      return {
        id: DEMO_STATIC_LIVE_JOB_ID,
        serviceId: id,
        ownerId: DEMO_OWNER_ID,
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + PROVISION_TOTAL_MS),
        status: "succeeded",
        startedAt: STATIC_BASELINE_ISO,
        completedAt: isoFromMs(STATIC_BASELINE_MS + PROVISION_TOTAL_MS),
        executionArn:
          "arn:aws:states:us-east-1:000000000000:execution:ironforge-demo-provisioning:" +
          DEMO_STATIC_LIVE_JOB_ID,
      };
    case DEMO_STATIC_PROVISIONING_ID:
      return {
        id: DEMO_STATIC_PROVISIONING_JOB_ID,
        serviceId: id,
        ownerId: DEMO_OWNER_ID,
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + 14_000),
        status: "running",
        startedAt: STATIC_BASELINE_ISO,
        executionArn:
          "arn:aws:states:us-east-1:000000000000:execution:ironforge-demo-provisioning:" +
          DEMO_STATIC_PROVISIONING_JOB_ID,
      };
    case DEMO_STATIC_FAILED_ID:
      return {
        id: DEMO_STATIC_FAILED_JOB_ID,
        serviceId: id,
        ownerId: DEMO_OWNER_ID,
        createdAt: STATIC_BASELINE_ISO,
        updatedAt: isoFromMs(STATIC_BASELINE_MS + 28_000),
        status: "failed",
        startedAt: STATIC_BASELINE_ISO,
        failedAt: isoFromMs(STATIC_BASELINE_MS + 28_000),
        executionArn:
          "arn:aws:states:us-east-1:000000000000:execution:ironforge-demo-provisioning:" +
          DEMO_STATIC_FAILED_JOB_ID,
        failureReason: "GitHub Actions deploy run did not complete within budget",
        failedStep: "wait-for-deploy",
      };
    default:
      return null;
  }
};

const buildEphemeralJob = (id: string, now: number): Job | null => {
  const ts = parseEphemeralTimestamp(id);
  if (ts === null) return null;
  const elapsed = now - ts;
  const jobId = ephemeralJobIdFromServiceId(id);
  const createdAt = isoFromMs(ts);
  const executionArn =
    "arn:aws:states:us-east-1:000000000000:execution:ironforge-demo-provisioning:" +
    jobId;
  const base = { id: jobId, serviceId: id, ownerId: DEMO_OWNER_ID, createdAt };

  if (elapsed < 1000) {
    return { ...base, updatedAt: createdAt, status: "queued" };
  }
  if (elapsed < PROVISION_TOTAL_MS) {
    return {
      ...base,
      updatedAt: isoFromMs(ts + elapsed),
      status: "running",
      startedAt: createdAt,
      executionArn,
    };
  }
  const completedMs = ts + PROVISION_TOTAL_MS;
  return {
    ...base,
    updatedAt: isoFromMs(completedMs),
    status: "succeeded",
    startedAt: createdAt,
    completedAt: isoFromMs(completedMs),
    executionArn,
  };
};

export const getDemoJob = (id: string, now: number): Job | null => {
  if (isStaticDemoId(id)) return buildStaticJob(id);
  if (isEphemeralDemoId(id)) return buildEphemeralJob(id, now);
  return null;
};

// JobStep[] for a static service: fixed list reflecting the service's
// status. For ephemeral: walks EPHEMERAL_PROVISION_TIMELINE, returns
// only entries whose startMs has elapsed.
const buildStaticSteps = (id: string): JobStep[] => {
  const baseStartMs = STATIC_BASELINE_MS;
  const jobIdFor = (svcId: string): string =>
    svcId === DEMO_STATIC_LIVE_ID
      ? DEMO_STATIC_LIVE_JOB_ID
      : svcId === DEMO_STATIC_PROVISIONING_ID
        ? DEMO_STATIC_PROVISIONING_JOB_ID
        : DEMO_STATIC_FAILED_JOB_ID;

  const succeededStep = (
    s: StepOffset,
    jobId: string,
  ): JobStep => ({
    jobId,
    stepName: s.stepName,
    attempts: 1,
    updatedAt: isoFromMs(baseStartMs + s.endMs),
    status: "succeeded",
    startedAt: isoFromMs(baseStartMs + s.startMs),
    completedAt: isoFromMs(baseStartMs + s.endMs),
    output: {},
  });

  if (id === DEMO_STATIC_LIVE_ID) {
    return EPHEMERAL_PROVISION_TIMELINE.map((s) => succeededStep(s, jobIdFor(id)));
  }

  if (id === DEMO_STATIC_PROVISIONING_ID) {
    // Mid-flight: 3 steps succeeded + run-terraform running.
    const result: JobStep[] = [];
    for (const s of EPHEMERAL_PROVISION_TIMELINE) {
      if (
        s.stepName === "validate-inputs" ||
        s.stepName === "create-repo" ||
        s.stepName === "generate-code"
      ) {
        result.push(succeededStep(s, jobIdFor(id)));
      } else if (s.stepName === "run-terraform") {
        result.push({
          jobId: jobIdFor(id),
          stepName: s.stepName,
          attempts: 1,
          updatedAt: isoFromMs(baseStartMs + 14_000),
          status: "running",
          startedAt: isoFromMs(baseStartMs + s.startMs),
        });
      }
    }
    return result;
  }

  if (id === DEMO_STATIC_FAILED_ID) {
    // Workflow ran through wait-for-deploy, then failed there.
    const result: JobStep[] = [];
    for (const s of EPHEMERAL_PROVISION_TIMELINE) {
      if (
        s.stepName === "validate-inputs" ||
        s.stepName === "create-repo" ||
        s.stepName === "generate-code" ||
        s.stepName === "run-terraform" ||
        s.stepName === "wait-for-cloudfront" ||
        s.stepName === "trigger-deploy"
      ) {
        result.push(succeededStep(s, jobIdFor(id)));
      } else if (s.stepName === "wait-for-deploy") {
        result.push({
          jobId: jobIdFor(id),
          stepName: s.stepName,
          attempts: 1,
          updatedAt: isoFromMs(baseStartMs + 28_000),
          status: "failed",
          startedAt: isoFromMs(baseStartMs + s.startMs),
          failedAt: isoFromMs(baseStartMs + 28_000),
          errorName: "DeployTimeoutError",
          errorMessage: "GitHub Actions deploy run did not complete within budget",
          retryable: false,
        });
      }
    }
    return result;
  }

  return [];
};

const buildEphemeralSteps = (id: string, now: number): JobStep[] => {
  const ts = parseEphemeralTimestamp(id);
  if (ts === null) return [];
  const elapsed = now - ts;
  const jobId = ephemeralJobIdFromServiceId(id);
  const result: JobStep[] = [];
  for (const s of EPHEMERAL_PROVISION_TIMELINE) {
    if (elapsed < s.startMs) break;
    if (elapsed < s.endMs) {
      result.push({
        jobId,
        stepName: s.stepName,
        attempts: 1,
        updatedAt: isoFromMs(ts + elapsed),
        status: "running",
        startedAt: isoFromMs(ts + s.startMs),
      });
    } else {
      result.push({
        jobId,
        stepName: s.stepName,
        attempts: 1,
        updatedAt: isoFromMs(ts + s.endMs),
        status: "succeeded",
        startedAt: isoFromMs(ts + s.startMs),
        completedAt: isoFromMs(ts + s.endMs),
        output: {},
      });
    }
  }
  return result;
};

export const getDemoSteps = (id: string, now: number): JobStep[] => {
  if (isStaticDemoId(id)) return buildStaticSteps(id);
  if (isEphemeralDemoId(id)) return buildEphemeralSteps(id, now);
  return [];
};

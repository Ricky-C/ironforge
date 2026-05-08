import { JobSchema, JobStepSchema, ServiceSchema } from "@ironforge/shared-types";
import { describe, expect, it } from "vitest";

import {
  DEMO_OWNER_ID,
  DEMO_STATIC_FAILED_ID,
  DEMO_STATIC_LIVE_ID,
  DEMO_STATIC_PROVISIONING_ID,
  DEPROVISION_TOTAL_MS,
  EPHEMERAL_DEPROVISION_TIMELINE,
  EPHEMERAL_PROVISION_TIMELINE,
  PROVISION_TOTAL_MS,
  computeDeprovisionJob,
  computeDeprovisionService,
  computeDeprovisionSteps,
  generateEphemeralServiceId,
  getDemoCatalog,
  getDemoJob,
  getDemoService,
  getDemoSteps,
  getJobIdForServiceId,
  isDemoId,
  isEphemeralDemoId,
  isStaticDemoId,
  parseEphemeralTimestamp,
} from "./demo-state.js";

const FIXED_NOW_MS = 1_780_000_000_000; // 2026-05-29-ish

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ===========================================================================
// generateEphemeralServiceId — UUID v7 shape + timestamp round-trip
// ===========================================================================

describe("generateEphemeralServiceId", () => {
  it("produces a UUID v7 shape", () => {
    const id = generateEphemeralServiceId(FIXED_NOW_MS);
    expect(id).toMatch(UUID_V7_PATTERN);
  });

  it("encodes the timestamp in the high 48 bits", () => {
    const id = generateEphemeralServiceId(FIXED_NOW_MS);
    expect(parseEphemeralTimestamp(id)).toBe(FIXED_NOW_MS);
  });

  it("produces distinct IDs for the same timestamp on repeated calls", () => {
    const a = generateEphemeralServiceId(FIXED_NOW_MS);
    const b = generateEphemeralServiceId(FIXED_NOW_MS);
    expect(a).not.toBe(b);
  });

  it("rejects non-integer timestamps", () => {
    expect(() => generateEphemeralServiceId(1.5)).toThrow();
  });

  it("rejects negative timestamps", () => {
    expect(() => generateEphemeralServiceId(-1)).toThrow();
  });
});

// ===========================================================================
// parseEphemeralTimestamp
// ===========================================================================

describe("parseEphemeralTimestamp", () => {
  it("returns null on a v4 UUID (production-shape)", () => {
    expect(parseEphemeralTimestamp("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("returns null on a malformed string", () => {
    expect(parseEphemeralTimestamp("not-a-uuid")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseEphemeralTimestamp("")).toBeNull();
  });

  it("returns the encoded timestamp for a generated v7 ID", () => {
    const id = generateEphemeralServiceId(1_700_000_000_000);
    expect(parseEphemeralTimestamp(id)).toBe(1_700_000_000_000);
  });
});

// ===========================================================================
// ID classifiers
// ===========================================================================

describe("isStaticDemoId / isEphemeralDemoId / isDemoId", () => {
  it("isStaticDemoId true for the three known static IDs", () => {
    expect(isStaticDemoId(DEMO_STATIC_LIVE_ID)).toBe(true);
    expect(isStaticDemoId(DEMO_STATIC_PROVISIONING_ID)).toBe(true);
    expect(isStaticDemoId(DEMO_STATIC_FAILED_ID)).toBe(true);
  });

  it("isStaticDemoId false for arbitrary UUIDs", () => {
    expect(isStaticDemoId("abcdef01-1234-4111-8111-111111111111")).toBe(false);
  });

  it("isEphemeralDemoId true for v7 UUIDs, false for static IDs", () => {
    const ephemeral = generateEphemeralServiceId(FIXED_NOW_MS);
    expect(isEphemeralDemoId(ephemeral)).toBe(true);
    expect(isEphemeralDemoId(DEMO_STATIC_LIVE_ID)).toBe(false);
  });

  it("isDemoId covers both static and ephemeral", () => {
    expect(isDemoId(DEMO_STATIC_LIVE_ID)).toBe(true);
    expect(isDemoId(generateEphemeralServiceId(FIXED_NOW_MS))).toBe(true);
    expect(isDemoId("not-a-demo-id")).toBe(false);
  });
});

// ===========================================================================
// getJobIdForServiceId
// ===========================================================================

describe("getJobIdForServiceId", () => {
  it("returns hand-picked job IDs for static services", () => {
    expect(getJobIdForServiceId(DEMO_STATIC_LIVE_ID)).toMatch(UUID_PATTERN);
    expect(getJobIdForServiceId(DEMO_STATIC_PROVISIONING_ID)).toMatch(UUID_PATTERN);
    expect(getJobIdForServiceId(DEMO_STATIC_FAILED_ID)).toMatch(UUID_PATTERN);
  });

  it("derives a v4-shape job ID from an ephemeral v7 service ID (version nibble flipped 7→4)", () => {
    const svc = generateEphemeralServiceId(FIXED_NOW_MS);
    const job = getJobIdForServiceId(svc);
    expect(job.charAt(14)).toBe("4");
    expect(svc.charAt(14)).toBe("7");
    // Same prefix + suffix; only version nibble flipped
    expect(job.slice(0, 14)).toBe(svc.slice(0, 14));
    expect(job.slice(15)).toBe(svc.slice(15));
  });
});

// ===========================================================================
// getDemoCatalog — 3 entries, all schema-valid, varied states
// ===========================================================================

describe("getDemoCatalog", () => {
  it("returns 3 entries", () => {
    expect(getDemoCatalog()).toHaveLength(3);
  });

  it("each entry validates against ServiceSchema", () => {
    const catalog = getDemoCatalog();
    for (const service of catalog) {
      const result = ServiceSchema.safeParse(service);
      expect(result.success).toBe(true);
    }
  });

  it("includes one live + one provisioning + one failed (state variety)", () => {
    const catalog = getDemoCatalog();
    const statuses = catalog.map((s) => s.status).sort();
    expect(statuses).toEqual(["failed", "live", "provisioning"]);
  });

  it("all entries have DEMO_OWNER_ID", () => {
    for (const service of getDemoCatalog()) {
      expect(service.ownerId).toBe(DEMO_OWNER_ID);
    }
  });
});

// ===========================================================================
// getDemoService — static + ephemeral phases
// ===========================================================================

describe("getDemoService — static IDs", () => {
  it("returns the live entry for the live static ID", () => {
    const service = getDemoService(DEMO_STATIC_LIVE_ID, FIXED_NOW_MS);
    expect(service?.status).toBe("live");
    expect(service?.id).toBe(DEMO_STATIC_LIVE_ID);
  });

  it("returns the provisioning entry for the provisioning static ID", () => {
    const service = getDemoService(DEMO_STATIC_PROVISIONING_ID, FIXED_NOW_MS);
    expect(service?.status).toBe("provisioning");
  });

  it("returns the failed entry for the failed static ID", () => {
    const service = getDemoService(DEMO_STATIC_FAILED_ID, FIXED_NOW_MS);
    expect(service?.status).toBe("failed");
  });

  it("returns identical state across two calls with different `now` values (state doesn't drift on poll)", () => {
    const a = getDemoService(DEMO_STATIC_LIVE_ID, FIXED_NOW_MS);
    const b = getDemoService(DEMO_STATIC_LIVE_ID, FIXED_NOW_MS + 60_000);
    expect(a).toEqual(b);
  });
});

describe("getDemoService — ephemeral phases", () => {
  const ephemeralAt = (ts: number): string => generateEphemeralServiceId(ts);

  it("returns pending when elapsed < 1000ms", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const service = getDemoService(id, FIXED_NOW_MS + 500);
    expect(service?.status).toBe("pending");
  });

  it("returns provisioning when 1000ms <= elapsed < 30000ms", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const service = getDemoService(id, FIXED_NOW_MS + 5_000);
    expect(service?.status).toBe("provisioning");
  });

  it("returns live when elapsed >= 30000ms (PROVISION_TOTAL_MS)", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const service = getDemoService(id, FIXED_NOW_MS + PROVISION_TOTAL_MS + 1);
    expect(service?.status).toBe("live");
  });

  it("ephemeral provisioning service has jobId set (per ServiceProvisioningSchema)", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const service = getDemoService(id, FIXED_NOW_MS + 5_000);
    expect(service?.status).toBe("provisioning");
    if (service?.status === "provisioning") {
      expect(service.jobId).toBeTruthy();
      expect(service.currentJobId).toBe(service.jobId);
    }
  });

  it("validates against ServiceSchema in each phase", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    for (const elapsed of [500, 5_000, PROVISION_TOTAL_MS + 1]) {
      const service = getDemoService(id, FIXED_NOW_MS + elapsed);
      expect(service).not.toBeNull();
      const result = ServiceSchema.safeParse(service);
      expect(result.success).toBe(true);
    }
  });

  it("returns null for a non-recognized id shape", () => {
    expect(getDemoService("not-a-demo-id", FIXED_NOW_MS)).toBeNull();
  });
});

// ===========================================================================
// getDemoJob — static + ephemeral phases
// ===========================================================================

describe("getDemoJob — static IDs", () => {
  it("returns succeeded Job for live static service", () => {
    const job = getDemoJob(DEMO_STATIC_LIVE_ID, FIXED_NOW_MS);
    expect(job?.status).toBe("succeeded");
  });

  it("returns running Job for provisioning static service", () => {
    const job = getDemoJob(DEMO_STATIC_PROVISIONING_ID, FIXED_NOW_MS);
    expect(job?.status).toBe("running");
  });

  it("returns failed Job for failed static service", () => {
    const job = getDemoJob(DEMO_STATIC_FAILED_ID, FIXED_NOW_MS);
    expect(job?.status).toBe("failed");
  });

  it("each static Job validates against JobSchema", () => {
    for (const id of [DEMO_STATIC_LIVE_ID, DEMO_STATIC_PROVISIONING_ID, DEMO_STATIC_FAILED_ID]) {
      const job = getDemoJob(id, FIXED_NOW_MS);
      const result = JobSchema.safeParse(job);
      expect(result.success).toBe(true);
    }
  });
});

describe("getDemoJob — ephemeral phases", () => {
  const ephemeralAt = (ts: number): string => generateEphemeralServiceId(ts);

  it("returns queued when elapsed < 1000ms", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const job = getDemoJob(id, FIXED_NOW_MS + 500);
    expect(job?.status).toBe("queued");
  });

  it("returns running when 1000ms <= elapsed < 30000ms", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const job = getDemoJob(id, FIXED_NOW_MS + 10_000);
    expect(job?.status).toBe("running");
  });

  it("returns succeeded when elapsed >= 30000ms", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const job = getDemoJob(id, FIXED_NOW_MS + PROVISION_TOTAL_MS + 1);
    expect(job?.status).toBe("succeeded");
  });

  it("validates against JobSchema in each phase", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    for (const elapsed of [500, 10_000, PROVISION_TOTAL_MS + 1]) {
      const job = getDemoJob(id, FIXED_NOW_MS + elapsed);
      expect(job).not.toBeNull();
      const result = JobSchema.safeParse(job);
      expect(result.success).toBe(true);
    }
  });

  it("returns null for non-demo IDs", () => {
    expect(getDemoJob("not-a-uuid", FIXED_NOW_MS)).toBeNull();
  });
});

// ===========================================================================
// getDemoSteps — static + ephemeral phases
// ===========================================================================

describe("getDemoSteps — static IDs", () => {
  it("live static service has all 8 happy-path steps as succeeded", () => {
    const steps = getDemoSteps(DEMO_STATIC_LIVE_ID, FIXED_NOW_MS);
    expect(steps).toHaveLength(EPHEMERAL_PROVISION_TIMELINE.length);
    for (const s of steps) {
      expect(s.status).toBe("succeeded");
    }
  });

  it("provisioning static service has 3 succeeded + 1 running (mid-flight)", () => {
    const steps = getDemoSteps(DEMO_STATIC_PROVISIONING_ID, FIXED_NOW_MS);
    const succeeded = steps.filter((s) => s.status === "succeeded");
    const running = steps.filter((s) => s.status === "running");
    expect(succeeded).toHaveLength(3);
    expect(running).toHaveLength(1);
    expect(running[0]?.stepName).toBe("run-terraform");
  });

  it("failed static service has 6 succeeded + 1 failed at wait-for-deploy", () => {
    const steps = getDemoSteps(DEMO_STATIC_FAILED_ID, FIXED_NOW_MS);
    const succeeded = steps.filter((s) => s.status === "succeeded");
    const failed = steps.filter((s) => s.status === "failed");
    expect(succeeded).toHaveLength(6);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.stepName).toBe("wait-for-deploy");
  });

  it("each step validates against JobStepSchema", () => {
    for (const id of [DEMO_STATIC_LIVE_ID, DEMO_STATIC_PROVISIONING_ID, DEMO_STATIC_FAILED_ID]) {
      const steps = getDemoSteps(id, FIXED_NOW_MS);
      for (const step of steps) {
        const result = JobStepSchema.safeParse(step);
        expect(result.success).toBe(true);
      }
    }
  });
});

describe("getDemoSteps — ephemeral phases", () => {
  const ephemeralAt = (ts: number): string => generateEphemeralServiceId(ts);

  it("returns empty array when elapsed < first-step start (1000ms)", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    expect(getDemoSteps(id, FIXED_NOW_MS + 500)).toEqual([]);
  });

  it("returns one running step when elapsed crosses first-step start but not end", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const steps = getDemoSteps(id, FIXED_NOW_MS + 1_500);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepName).toBe("validate-inputs");
    expect(steps[0]?.status).toBe("running");
  });

  it("returns succeeded steps + one running step mid-workflow", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    // At 5s elapsed, validate-inputs + create-repo done; generate-code running.
    const steps = getDemoSteps(id, FIXED_NOW_MS + 5_000);
    const succeeded = steps.filter((s) => s.status === "succeeded").map((s) => s.stepName);
    const running = steps.filter((s) => s.status === "running").map((s) => s.stepName);
    expect(succeeded).toEqual(["validate-inputs", "create-repo"]);
    expect(running).toEqual(["generate-code"]);
  });

  it("returns all 8 succeeded steps after PROVISION_TOTAL_MS", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    const steps = getDemoSteps(id, FIXED_NOW_MS + PROVISION_TOTAL_MS + 1);
    expect(steps).toHaveLength(EPHEMERAL_PROVISION_TIMELINE.length);
    for (const s of steps) {
      expect(s.status).toBe("succeeded");
    }
  });

  it("each step validates against JobStepSchema across phases", () => {
    const id = ephemeralAt(FIXED_NOW_MS);
    for (const elapsed of [1_500, 5_000, 22_500, PROVISION_TOTAL_MS + 1]) {
      const steps = getDemoSteps(id, FIXED_NOW_MS + elapsed);
      for (const step of steps) {
        const result = JobStepSchema.safeParse(step);
        expect(result.success).toBe(true);
      }
    }
  });

  it("returns [] for non-demo IDs", () => {
    expect(getDemoSteps("not-a-uuid", FIXED_NOW_MS)).toEqual([]);
  });
});

// ===========================================================================
// computeDeprovisionService — deprovision-state computation by phase
// ===========================================================================

describe("computeDeprovisionService", () => {
  const serviceId = generateEphemeralServiceId(FIXED_NOW_MS);
  const deprovStartMs = FIXED_NOW_MS + 60_000; // service was provisioned, then DELETE clicked 60s later
  const deprovJobId = generateEphemeralServiceId(deprovStartMs);

  it("returns deprovisioning when elapsed < DEPROVISION_TOTAL_MS", () => {
    const result = computeDeprovisionService(serviceId, deprovJobId, deprovStartMs + 5_000);
    expect(result?.status).toBe("deprovisioning");
    if (result?.status === "deprovisioning") {
      expect(result.jobId).toBe(deprovJobId);
      expect(result.currentJobId).toBe(deprovJobId);
    }
  });

  it("returns archived when elapsed >= DEPROVISION_TOTAL_MS", () => {
    const result = computeDeprovisionService(
      serviceId,
      deprovJobId,
      deprovStartMs + DEPROVISION_TOTAL_MS + 1,
    );
    expect(result?.status).toBe("archived");
    if (result?.status === "archived") {
      expect(result.archivedAt).toBeTruthy();
      expect(result.currentJobId).toBeNull();
    }
  });

  it("validates against ServiceSchema in each phase", () => {
    for (const elapsed of [5_000, DEPROVISION_TOTAL_MS + 1]) {
      const result = computeDeprovisionService(serviceId, deprovJobId, deprovStartMs + elapsed);
      expect(result).not.toBeNull();
      const parsed = ServiceSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    }
  });

  it("returns null on malformed deprovJobId (URL-controlled input)", () => {
    expect(computeDeprovisionService(serviceId, "not-a-uuid", FIXED_NOW_MS)).toBeNull();
    expect(computeDeprovisionService(serviceId, "", FIXED_NOW_MS)).toBeNull();
  });

  it("returns null on non-ephemeral serviceId", () => {
    expect(computeDeprovisionService(DEMO_STATIC_LIVE_ID, deprovJobId, deprovStartMs)).toBeNull();
    expect(computeDeprovisionService("not-a-uuid", deprovJobId, deprovStartMs)).toBeNull();
  });

  it("preserves identity fields from the original service (name, templateId, createdAt)", () => {
    const original = getDemoService(serviceId, FIXED_NOW_MS + 500); // pending phase
    const deprov = computeDeprovisionService(serviceId, deprovJobId, deprovStartMs + 5_000);
    expect(deprov?.name).toBe(original?.name);
    expect(deprov?.templateId).toBe(original?.templateId);
    expect(deprov?.createdAt).toBe(original?.createdAt);
    expect(deprov?.ownerId).toBe(DEMO_OWNER_ID);
  });
});

// ===========================================================================
// computeDeprovisionJob
// ===========================================================================

describe("computeDeprovisionJob", () => {
  const serviceId = generateEphemeralServiceId(FIXED_NOW_MS);
  const deprovStartMs = FIXED_NOW_MS + 60_000;
  const deprovJobId = generateEphemeralServiceId(deprovStartMs);

  it("returns running when elapsed < DEPROVISION_TOTAL_MS", () => {
    const job = computeDeprovisionJob(serviceId, deprovJobId, deprovStartMs + 5_000);
    expect(job?.status).toBe("running");
    expect(job?.id).toBe(deprovJobId);
  });

  it("returns succeeded when elapsed >= DEPROVISION_TOTAL_MS", () => {
    const job = computeDeprovisionJob(
      serviceId,
      deprovJobId,
      deprovStartMs + DEPROVISION_TOTAL_MS + 1,
    );
    expect(job?.status).toBe("succeeded");
  });

  it("validates against JobSchema in each phase", () => {
    for (const elapsed of [5_000, DEPROVISION_TOTAL_MS + 1]) {
      const job = computeDeprovisionJob(serviceId, deprovJobId, deprovStartMs + elapsed);
      expect(job).not.toBeNull();
      const parsed = JobSchema.safeParse(job);
      expect(parsed.success).toBe(true);
    }
  });

  it("returns null on malformed deprovJobId", () => {
    expect(computeDeprovisionJob(serviceId, "not-a-uuid", FIXED_NOW_MS)).toBeNull();
  });

  it("returns null on non-ephemeral serviceId", () => {
    expect(computeDeprovisionJob(DEMO_STATIC_LIVE_ID, deprovJobId, deprovStartMs)).toBeNull();
  });
});

// ===========================================================================
// computeDeprovisionSteps
// ===========================================================================

describe("computeDeprovisionSteps", () => {
  const deprovStartMs = FIXED_NOW_MS + 60_000;
  const deprovJobId = generateEphemeralServiceId(deprovStartMs);

  it("returns empty array before first step's startMs", () => {
    expect(computeDeprovisionSteps(deprovJobId, deprovStartMs + 100)).toEqual([]);
  });

  it("returns deprovision-terraform running mid-first-step", () => {
    const steps = computeDeprovisionSteps(deprovJobId, deprovStartMs + 4_000);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepName).toBe("deprovision-terraform");
    expect(steps[0]?.status).toBe("running");
  });

  it("returns first step succeeded + second running mid-second-step", () => {
    const steps = computeDeprovisionSteps(deprovJobId, deprovStartMs + 9_000);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.stepName).toBe("deprovision-terraform");
    expect(steps[0]?.status).toBe("succeeded");
    expect(steps[1]?.stepName).toBe("deprovision-external-resources");
    expect(steps[1]?.status).toBe("running");
  });

  it("returns both steps succeeded after DEPROVISION_TOTAL_MS", () => {
    const steps = computeDeprovisionSteps(deprovJobId, deprovStartMs + DEPROVISION_TOTAL_MS + 1);
    expect(steps).toHaveLength(EPHEMERAL_DEPROVISION_TIMELINE.length);
    for (const s of steps) {
      expect(s.status).toBe("succeeded");
    }
  });

  it("validates against JobStepSchema", () => {
    for (const elapsed of [4_000, 9_000, DEPROVISION_TOTAL_MS + 1]) {
      const steps = computeDeprovisionSteps(deprovJobId, deprovStartMs + elapsed);
      for (const step of steps) {
        const parsed = JobStepSchema.safeParse(step);
        expect(parsed.success).toBe(true);
      }
    }
  });

  it("returns [] on malformed deprovJobId", () => {
    expect(computeDeprovisionSteps("not-a-uuid", FIXED_NOW_MS)).toEqual([]);
    expect(computeDeprovisionSteps("", FIXED_NOW_MS)).toEqual([]);
  });
});

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  // Module-level env validation runs at import; satisfy it before importing.
  process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:test-topic";
});

const { formatReport, parseCostResponse, yesterdayDateRange } = await import("./handler");

describe("formatReport", () => {
  it("renders header, total, and per-service lines sorted by amount", () => {
    const out = formatReport(
      [
        { service: "S3", amount: 0.18, unit: "USD" },
        { service: "CloudFront", amount: 0.12, unit: "USD" },
      ],
      "2026-04-26",
    );
    expect(out).toContain("Ironforge daily cost report — 2026-04-26");
    expect(out).toContain("Total: $0.30");
    expect(out).toContain("S3: $0.18");
    expect(out).toContain("CloudFront: $0.12");
  });

  it("says no spend when services list is empty", () => {
    const out = formatReport([], "2026-04-26");
    expect(out).toContain("No spend recorded");
    expect(out).toContain("Total: $0.00");
  });

  it("renders non-USD units with the unit suffix", () => {
    const out = formatReport([{ service: "X", amount: 1.5, unit: "EUR" }], "2026-04-26");
    expect(out).toContain("Total: 1.50 EUR");
    expect(out).toContain("X: 1.50 EUR");
  });
});

describe("parseCostResponse", () => {
  it("filters zero-amount services and sorts descending", () => {
    const services = parseCostResponse({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["Lambda"], Metrics: { BlendedCost: { Amount: "0.05", Unit: "USD" } } },
            { Keys: ["S3"], Metrics: { BlendedCost: { Amount: "0.18", Unit: "USD" } } },
            { Keys: ["Free Tier"], Metrics: { BlendedCost: { Amount: "0", Unit: "USD" } } },
          ],
        },
      ],
    });
    expect(services).toHaveLength(2);
    expect(services[0]).toEqual({ service: "S3", amount: 0.18, unit: "USD" });
    expect(services[1]).toEqual({ service: "Lambda", amount: 0.05, unit: "USD" });
  });

  it("returns empty for missing ResultsByTime", () => {
    expect(parseCostResponse({})).toEqual([]);
  });

  it("returns empty for empty ResultsByTime array", () => {
    expect(parseCostResponse({ ResultsByTime: [] })).toEqual([]);
  });

  it("returns empty when Groups is an empty array (zero-spend day)", () => {
    expect(parseCostResponse({ ResultsByTime: [{ Groups: [] }] })).toEqual([]);
  });

  it("returns empty when Groups is missing on the result", () => {
    expect(parseCostResponse({ ResultsByTime: [{}] })).toEqual([]);
  });
});

describe("yesterdayDateRange", () => {
  it("returns ISO yyyy-mm-dd format", () => {
    const { start, end } = yesterdayDateRange();
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("end is exactly one UTC day after start", () => {
    const { start, end } = yesterdayDateRange();
    const startMs = new Date(`${start}T00:00:00Z`).getTime();
    const endMs = new Date(`${end}T00:00:00Z`).getTime();
    expect(endMs - startMs).toBe(86_400_000);
  });
});

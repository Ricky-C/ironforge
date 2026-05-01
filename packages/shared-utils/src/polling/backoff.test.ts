import { afterEach, describe, expect, it, vi } from "vitest";

import { exponentialBackoffSchedule } from "./backoff.js";

describe("exponentialBackoffSchedule", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty schedule for 0 attempts", () => {
    expect(
      exponentialBackoffSchedule({
        initialMs: 100,
        maxMs: 10_000,
        multiplier: 2,
        attempts: 0,
      }),
    ).toEqual([]);
  });

  it("produces a strictly monotonic schedule when uncapped", () => {
    const schedule = exponentialBackoffSchedule({
      initialMs: 100,
      maxMs: 60_000,
      multiplier: 2,
      attempts: 4,
    });
    expect(schedule).toEqual([100, 200, 400, 800]);
  });

  it("caps each delay at maxMs", () => {
    const schedule = exponentialBackoffSchedule({
      initialMs: 100,
      maxMs: 500,
      multiplier: 2,
      attempts: 6,
    });
    expect(schedule).toEqual([100, 200, 400, 500, 500, 500]);
  });

  it("with full jitter, every delay falls in (0, capped]", () => {
    // Stub Math.random to a known value so the assertion is deterministic.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const schedule = exponentialBackoffSchedule({
      initialMs: 100,
      maxMs: 800,
      multiplier: 2,
      attempts: 4,
      jitter: "full",
    });
    expect(schedule).toEqual([50, 100, 200, 400]);
  });

  it("with full jitter and Math.random=0.999, delays approach the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const schedule = exponentialBackoffSchedule({
      initialMs: 100,
      maxMs: 1_000,
      multiplier: 2,
      attempts: 5,
      jitter: "full",
    });
    expect(schedule.every((d, i) => d <= [100, 200, 400, 800, 1_000][i]!)).toBe(
      true,
    );
  });

  it("rejects non-integer attempts", () => {
    expect(() =>
      exponentialBackoffSchedule({
        initialMs: 100,
        maxMs: 1_000,
        multiplier: 2,
        attempts: 3.5,
      }),
    ).toThrowError(/attempts/);
  });

  it("rejects negative initialMs", () => {
    expect(() =>
      exponentialBackoffSchedule({
        initialMs: -1,
        maxMs: 1_000,
        multiplier: 2,
        attempts: 3,
      }),
    ).toThrowError(/initialMs/);
  });

  it("rejects non-positive multiplier", () => {
    expect(() =>
      exponentialBackoffSchedule({
        initialMs: 100,
        maxMs: 1_000,
        multiplier: 0,
        attempts: 3,
      }),
    ).toThrowError(/multiplier/);
  });
});

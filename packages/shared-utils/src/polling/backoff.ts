// Generates an array of delay-in-ms values for exponential backoff with
// optional full jitter. Pure function — schedule generation is shared,
// but the polling loop and SDK calls live with each polling Lambda.
//
// `multiplier`: 2 doubles each tick; 1.5 is a gentler ramp.
// `maxMs`: cap to keep tail delays bounded.
// `jitter: "full"`: each delay = random(0, capped). Reduces synchronized
//   thundering-herd retries against the same upstream. Default "none"
//   yields deterministic schedules for tests and predictable timing.

type ExponentialBackoffParams = {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  attempts: number;
  jitter?: "full" | "none";
};

export const exponentialBackoffSchedule = (
  params: ExponentialBackoffParams,
): number[] => {
  if (!Number.isInteger(params.attempts) || params.attempts < 0) {
    throw new Error("attempts must be a non-negative integer");
  }
  if (params.initialMs <= 0) {
    throw new Error("initialMs must be positive");
  }
  if (params.maxMs <= 0) {
    throw new Error("maxMs must be positive");
  }
  if (params.multiplier <= 0) {
    throw new Error("multiplier must be positive");
  }

  const jitter = params.jitter ?? "none";
  const delays: number[] = [];
  let current = params.initialMs;

  for (let i = 0; i < params.attempts; i++) {
    const capped = Math.min(current, params.maxMs);
    const delay = jitter === "full" ? Math.random() * capped : capped;
    delays.push(delay);
    current = current * params.multiplier;
  }

  return delays;
};

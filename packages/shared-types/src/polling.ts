import { z } from "zod";

// Type-only contract for polling task Lambdas (wait-for-cert,
// wait-for-cloudfront, etc.). Each polling Lambda owns its SDK client,
// terminal-state predicate, and timeout handling; what's shared is the
// shape of the per-poll-tick result so the state machine can dispatch
// consistently across polling steps.
//
// status semantics:
//   in_progress — predicate not yet satisfied; SFN's Wait state consumes
//                 `nextWaitSeconds` to schedule the next tick. `pollState`
//                 is an opaque per-Lambda carry-forward bag (e.g.
//                 wait-for-cloudfront stuffs `{ startedAt, pollAttempt }`
//                 here); shape mirrors `Service.inputs` from PR-B.1
//                 (opaque at universal layer, narrowed via a per-Lambda
//                 Zod schema on the next tick's entry).
//   succeeded   — terminal-OK; `result` carries the Lambda's success
//                 payload (e.g. CloudFront distribution ID).
//   failed      — terminal-error; `error` carries a sanitized message.
//                 RESERVED for polling Lambdas with terminal-failed
//                 upstream states (e.g. ACM cert VALIDATION_FAILED).
//                 Currently unused — wait-for-cloudfront throws
//                 IronforgePollTimeoutError on budget exhaustion rather
//                 than returning a failed PollResult so SFN's existing
//                 Catch on States.ALL routes to CleanupOnFailure with
//                 $.error populated automatically. First consumer TBD;
//                 keep in schema for forward compat (cost zero, re-add
//                 cost non-zero).
//
// `nextWaitSeconds` upper bound: bounded slightly above
// wait-for-cloudfront's longest scheduled tick (90s). Future polling
// Lambdas with longer ticks can raise this; chose 120s over 300s as
// the deliberate-tight default — 300s would have been arbitrary.
export const PollResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("in_progress"),
    nextWaitSeconds: z.number().int().positive().max(120),
    pollState: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ status: z.literal("succeeded"), result: z.unknown() }),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }),
]);

// PollResult<TResult, TPollState> typed at the call site so polling
// Lambda authors get type-checked output shapes. The runtime schema
// doesn't constrain `result` or `pollState`; per-Lambda code narrows
// via its own Zod schema before returning / on the next tick's entry.
export type PollResult<TResult = unknown, TPollState = Record<string, unknown>> =
  | { status: "in_progress"; nextWaitSeconds: number; pollState?: TPollState }
  | { status: "succeeded"; result: TResult }
  | { status: "failed"; error: string };

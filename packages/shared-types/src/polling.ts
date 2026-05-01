import { z } from "zod";

// Type-only contract for polling task Lambdas (wait-for-cert,
// wait-for-cloudfront, etc.). Each polling Lambda owns its SDK client,
// terminal-state predicate, and timeout handling; what's shared is the
// shape of the per-poll-tick result so the state machine can dispatch
// consistently across polling steps.
//
// status semantics:
//   in_progress — predicate not yet satisfied; SFN should wait + retry.
//   succeeded   — terminal-OK; `result` carries the Lambda's success
//                 payload (e.g. CloudFront distribution ID).
//   failed      — terminal-error; `error` carries a sanitized message.
//                 The polling Lambda decides what counts as terminal vs
//                 retryable based on the SDK error class — workflow-level
//                 retries are configured at the SFN state level, not
//                 inside the Lambda.
export const PollResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("in_progress") }),
  z.object({ status: z.literal("succeeded"), result: z.unknown() }),
  z.object({ status: z.literal("failed"), error: z.string().min(1) }),
]);

// PollResult<T> typed at the call site so polling Lambda authors get
// type-checked output shapes. The runtime schema doesn't constrain the
// `result` payload; per-Lambda code narrows via its own schema before
// returning. Default `unknown` keeps the shared type minimally useful
// without coupling to any specific Lambda.
export type PollResult<T = unknown> =
  | { status: "in_progress" }
  | { status: "succeeded"; result: T }
  | { status: "failed"; error: string };

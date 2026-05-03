# `_stub-lib`

Originally held PR-C task stubs (a generic `stubTask` wrapper plus a
`finalizeStub` for the terminal-success transition); now holds only
`cleanupStub` for cleanup-on-failure. `cleanupStub` remains because
the destroy-chain implementation is deferred — see
[`docs/tech-debt.md`](../../../docs/tech-debt.md) §
"Cleanup-on-failure destroy chain" for the four re-introduction
triggers.

## Why this package still exists

After PR-C.9, `cleanupStub` is the package's only consumer
(`services/workflow/cleanup-on-failure/src/handler.ts` re-exports it
as `handler`). The Phase-1 cleanup behavior is intentionally minimal
(status writes only — Service `provisioning → failed`, Job `running
→ failed`, JobStep upsert) per the PR-C.2 design conversation; it's
the real Phase-1 cleanup, not a placeholder.

The `_stub-lib` name is forward-looking accurate — when the destroy
chain lands, this code gets rewritten substantially. Inlining
cleanupStub into `cleanup-on-failure/src/` now would commit to a
file structure that the destroy-chain redesign might not want; the
extra package boundary is cheap and defers the structural decision
to when the redesign's needs are concrete.

## What lives here

- `src/cleanup-stub.ts` — the Phase-1 cleanup-on-failure handler.
  Status-writes-only, conditional-write-protected against double-fire.
- `src/index.ts` — re-exports + the consumer ledger (records the
  PR-C.X PR that flipped each original consumer to a real Lambda).
- `src/stub-task.ts` — dead code as of PR-C.8. All originally-
  placeholder task Lambdas now have real implementations. Kept in
  the file because the package shares one tsconfig / build pipeline
  with `cleanup-stub.ts`; no consumer imports it.
- `src/finalize-stub.ts` — replaced by the real
  `services/workflow/finalize/` Lambda at PR-C.9. Kept in the file
  for the same reason as `stub-task.ts` (shared package
  boilerplate); the file has no consumers.

## Replacement plan

When the destroy chain lands (any of the four triggers in
`docs/tech-debt.md` § "Cleanup-on-failure destroy chain"):

1. Delete `cleanupStub` and replace it with the real cleanup-on-
   failure Lambda body in `services/workflow/cleanup-on-failure/`.
2. Delete `stub-task.ts` and `finalize-stub.ts` from this package
   (already dead code).
3. Decide whether the residual workspace is worth keeping (probably
   not) and either delete the package entirely or keep it as a home
   for whatever shared cleanup helpers the destroy-chain
   implementation factors out.

Until then, this package keeps its current shape.

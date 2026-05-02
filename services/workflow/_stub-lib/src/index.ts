// Consumer ledger — update on every PR-C.X that flips a stub to real.
//
// stubTask consumers (5 of 6 remaining; replaced one-per-PR through C.8):
//   - create-repo            (PR-C.4b will replace)
//   - generate-code          (PR-C.5 will replace)
//   - run-terraform          (PR-C.6 will replace)
//   - wait-for-cloudfront    (PR-C.7 will replace)
//   - trigger-deploy         (PR-C.8 will replace)
//
// finalizeStub consumers (1 of 1 remaining; PR-C.9 will replace):
//   - finalize
//
// cleanupStub consumers (1 — NOT a placeholder; this IS the real Phase 1
//   cleanup-on-failure behavior per the PR-C.2 hybrid-scope decision.
//   Destroy chain deferred; see docs/tech-debt.md § "Cleanup-on-failure
//   destroy chain" for the four re-introduction triggers):
//   - cleanup-on-failure
//
// Deletion trigger: when stubTask + finalizeStub consumer counts both
// reach zero (after PR-C.9), this package becomes deletion-eligible.
// cleanupStub at that point either (a) graduates into a permanent home
// outside _stub-lib, or (b) gets replaced by the destroy-chain
// implementation. Either way, _stub-lib/ goes away.

export * from "./cleanup-stub.js";
export * from "./finalize-stub.js";
export * from "./stub-task.js";

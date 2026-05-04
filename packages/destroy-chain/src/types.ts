// Outcome shapes for destroy chain primitives. Each primitive returns
// its own discriminated union so callers get TS-exhaustive switching on
// failure modes — terraform destroy can fail two distinct ways
// (Lambda FunctionError vs. invoke-time exception), each carrying
// different fields, and operators query CloudWatch by those field names.
//
// `skipped` is reserved for callers that pre-determine "nothing to do"
// (e.g., create-repo never succeeded, so the repo doesn't exist). The
// primitives currently never emit skipped themselves; it's a future
// caller-driven path. Kept in the type union now so adding the input
// flag later is non-breaking.

type Skipped = {
  status: "skipped";
  reason: string;
};

export type DestroyTerraformOutcome =
  | { status: "succeeded"; durationMs: number }
  | {
      status: "failed";
      durationMs: number;
      failureKind: "function-error";
      functionError: string;
      payloadPreview: string;
    }
  | {
      status: "failed";
      durationMs: number;
      failureKind: "exception";
      error: string;
    }
  | Skipped;

export type DeleteGithubRepoOutcome =
  | { status: "succeeded"; durationMs: number; detail: "deleted" | "already-absent" }
  | {
      status: "failed";
      durationMs: number;
      httpStatus: number | undefined;
      error: string;
    }
  | Skipped;

export type DeleteTfstateOutcome =
  | { status: "succeeded"; durationMs: number; detail: "deleted" | "already-absent" }
  | { status: "failed"; durationMs: number; error: string }
  | Skipped;

// Aggregate result of runDestroyChain. Callers read each phase's
// outcome to decide what to log and whether to throw.
export type DestroyChainResult = {
  terraform: DestroyTerraformOutcome;
  githubRepo: DeleteGithubRepoOutcome;
  tfstate: DeleteTfstateOutcome;
};

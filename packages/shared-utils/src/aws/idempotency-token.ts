// Build deterministic identifiers for AWS SDK fields whose semantics
// require idempotency: `IdempotencyToken` (ACM, IAM Roles Anywhere, etc.)
// and `CallerReference` (CloudFront, Route53). Workflow task Lambdas
// derive these from execution-name-scoped components (jobId, serviceId,
// step name) so SFN-driven retries pass the same value and AWS treats
// them as the same operation.
//
// See feedback memory "Two-pattern idempotency in Ironforge" — this is
// the workflow-layer mechanism, distinct from HTTP-level idempotency
// keys handled by withIdempotencyKey().

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

// Joins parts with `-` after slug-cleaning each. Order matters: the
// caller is responsible for passing parts in a stable order. Empty
// (post-slug) parts are dropped; if all parts are empty, throws — a
// silent empty token would defeat the idempotency contract.
export const awsIdempotencyToken = (...parts: string[]): string => {
  if (parts.length === 0) {
    throw new Error("awsIdempotencyToken requires at least one part");
  }
  const cleaned = parts.map(slug).filter((p) => p.length > 0);
  if (cleaned.length === 0) {
    throw new Error(
      "awsIdempotencyToken: all parts became empty after slug cleaning",
    );
  }
  return cleaned.join("-");
};

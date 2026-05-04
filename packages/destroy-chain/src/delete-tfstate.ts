import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { DeleteTfstateOutcome } from "./types.js";

// Module-scoped S3 client for connection-reuse on warm Lambda invocations.
const s3Client = new S3Client({});

type DeleteTfstateInput = {
  // Bucket holding terraform state. Caller resolves from env.
  tfstateBucket: string;
  // Service ID — used to derive the canonical state key:
  // `services/<id>/terraform.tfstate`. Keeping the key derivation in the
  // package keeps the convention in one place; callers don't reimplement it.
  serviceId: string;
};

// Deletes the per-service terraform state file. NoSuchKey is treated
// as success ("already absent" detail) — desired state is "file gone."
export const deleteTfstate = async (
  input: DeleteTfstateInput,
): Promise<DeleteTfstateOutcome> => {
  const start = Date.now();
  const key = `services/${input.serviceId}/terraform.tfstate`;
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: input.tfstateBucket,
        Key: key,
      }),
    );
    return {
      status: "succeeded",
      durationMs: Date.now() - start,
      detail: "deleted",
    };
  } catch (err) {
    const code = (err as { name?: string })?.name;
    if (code === "NoSuchKey") {
      return {
        status: "succeeded",
        durationMs: Date.now() - start,
        detail: "already-absent",
      };
    }
    return {
      status: "failed",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// Exposed for callers that want the canonical key shape (e.g. for
// logging) without round-tripping through the function.
export const buildTfstateKey = (serviceId: string): string =>
  `services/${serviceId}/terraform.tfstate`;

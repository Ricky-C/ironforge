// Readiness probe consumed by AWS Lambda Web Adapter (ADR-011).
//
// LWA polls AWS_LWA_READINESS_CHECK_PATH (set to /api/health on the
// portal Lambda — see infra/envs/shared/main.tf) and waits for a 200
// response before forwarding production traffic. Without it, requests
// hitting a cold-start Lambda before Next.js has fully initialized
// return 502 from LWA.

export function GET(): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

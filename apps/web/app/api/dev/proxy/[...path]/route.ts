import { NextResponse, type NextRequest } from "next/server";

// Dev-only BFF proxy. Forwards authenticated requests to the Ironforge
// API with a Bearer token read from server-side env. Subphase 2.5 (auth)
// replaces this with direct API calls using the access token from
// oidc-client-ts; this whole route handler goes away then.
//
// Why server-side: bearer tokens belong on the server. NEXT_PUBLIC_*
// env vars inline into the client bundle at build time, so an accidental
// deploy of the dev build would leak the token. Reading server-side
// preserves the same security posture as production.
//
// Returns 404 in production builds so a misconfigured deploy can't
// surface the proxy to real traffic.

const DEV_ONLY = process.env.NODE_ENV !== "production";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const handler = async (
  request: NextRequest,
  context: RouteContext,
): Promise<Response> => {
  if (!DEV_ONLY) {
    return new Response("Not Found", { status: 404 });
  }

  const baseUrl = process.env["IRONFORGE_API_BASE_URL"];
  const token = process.env["IRONFORGE_DEV_BEARER_TOKEN"];

  if (!baseUrl || !token) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "DEV_PROXY_MISCONFIGURED",
          message:
            "Set IRONFORGE_API_BASE_URL and IRONFORGE_DEV_BEARER_TOKEN in apps/web/.env.local. See apps/web/.env.example.",
        },
      },
      { status: 500 },
    );
  }

  const { path } = await context.params;
  const downstreamPath = path.join("/");
  const search = request.nextUrl.search;
  const downstreamUrl = `${baseUrl}/${downstreamPath}${search}`;

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    ...(hasBody ? { body: await request.arrayBuffer() } : {}),
  };

  const response = await fetch(downstreamUrl, init);
  const body = await response.arrayBuffer();
  const responseHeaders = new Headers();
  const upstreamContentType = response.headers.get("content-type");
  if (upstreamContentType) responseHeaders.set("content-type", upstreamContentType);

  return new Response(body, {
    status: response.status,
    headers: responseHeaders,
  });
};

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};

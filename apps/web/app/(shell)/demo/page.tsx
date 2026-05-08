"use client";

import { LandingContent } from "@/components/landing-content";
import { demoApiClient } from "@/lib/api-client/demo";

// Demo landing — unauthenticated public surface. Renders the same
// LandingContent as production but with the "Public demo · read-only"
// eyebrow chip in the hero and demo apiClient (no Authorization
// headers, /api/demo/* backend). KPI strip always shows for the demo
// since the demo apiClient works without auth.
//
// The catalog (formerly at /demo) now lives at /demo/services to give
// the landing the /demo URL — matching the design's IA where /demo
// is the entry surface and /demo/services is the catalog beneath it.

export default function DemoLanding(): React.ReactNode {
  return (
    <LandingContent
      variant="demo"
      apiClient={demoApiClient}
      basePath="/demo/services"
    />
  );
}

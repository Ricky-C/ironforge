"use client";

import { LandingContent } from "@/components/landing-content";
import { apiClient } from "@/lib/api-client";

// Production landing page. Auth-aware: signed-out visitors see the
// hero with "Sign in" + "View the demo" CTAs and no KPI strip;
// signed-in visitors see the same hero with "Provision a service" +
// "View catalog" CTAs and a first-page summary KPI strip from
// /api/services. The auth branching lives inside LandingContent —
// this page just wires the production apiClient + basePath.

export default function Home(): React.ReactNode {
  return (
    <LandingContent variant="production" apiClient={apiClient} basePath="/services" />
  );
}

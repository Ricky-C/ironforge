"use client";

import { use, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { ServiceDetailContent } from "@/components/service-detail-content";
import {
  demoApiClient,
  isStaticDemoId,
  readDemoEphemeralName,
} from "@/lib/api-client/demo";
import type { Service } from "@ironforge/shared-types";

// Demo service detail — unauthenticated. Three demo-specific behaviors
// layered on the shared ServiceDetailContent:
//
// 1. Static-catalog deprovision gating: defense in depth alongside
//    backend's 404 on DELETE for static IDs. The Deprovision button
//    never renders for the 3 known static demo services. Static
//    services in deprovisioning state (which only exists post-DELETE
//    on ephemerals) also drop the button — defense in depth on the
//    transient deprovisioning state too.
//
// 2. Ephemeral name display: backend computes synthetic names from
//    ID prefix on subsequent GETs (state is stateless). The visitor
//    typed a real name during create — demoApiClient stashes it in
//    sessionStorage; this wrapper reads it and passes as override
//    so the detail page reflects the visitor's intent.
//
// 3. Deprovision-lifecycle URL encoding: the URL search param
//    `?deprovisionJobId=<v7-uuid>` carries the post-DELETE state.
//    On Deprovision click, the success hook router.replace's to the
//    same path with the param appended; subsequent polls compute
//    deprovision state from the encoded timestamp. router.replace
//    (not push) — the deprovision URL replaces the live-service URL
//    rather than adding history. Visitor's back-button returns to
//    wherever they were before clicking Deprovision (catalog or
//    pre-DELETE detail), not to a "ghost service" detail page that
//    no longer represents reality.

const demoCanDeprovision = (service: Service): boolean => {
  if (isStaticDemoId(service.id)) return false;
  return service.status === "live" || service.status === "failed";
};

type DemoDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default function DemoServiceDetailPage(
  props: DemoDetailPageProps,
): React.ReactNode {
  const { id } = use(props.params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const deprovisionJobId =
    searchParams.get("deprovisionJobId") ?? undefined;

  // sessionStorage is browser-only; resolve after mount to avoid SSR
  // / hydration mismatch (server returns undefined; client returns
  // cached name). useState + useEffect guards the read.
  const [override, setOverride] = useState<string | undefined>(undefined);
  useEffect(() => {
    setOverride(readDemoEphemeralName(id));
  }, [id]);

  return (
    <ServiceDetailContent
      params={props.params}
      apiClient={demoApiClient}
      backHref="/demo"
      backLabel="Demo"
      canDeprovision={demoCanDeprovision}
      displayNameOverride={override}
      deprovisionJobId={deprovisionJobId}
      onDeprovisionSuccess={(response) => {
        // Encode the deprovision lifecycle into the URL. Subsequent
        // polls (driven by the prop change re-rendering downward
        // through ServiceDetailContent + JobProgress) include the
        // deprovisionJobId query param, and the demo backend
        // computes deprovision-state-derived responses.
        router.replace(
          `/demo/services/${id}?deprovisionJobId=${encodeURIComponent(response.job.id)}`,
        );
      }}
    />
  );
}

"use client";

import { use, useEffect, useState } from "react";

import { ServiceDetailContent } from "@/components/service-detail-content";
import {
  demoApiClient,
  isStaticDemoId,
  readDemoEphemeralName,
} from "@/lib/api-client/demo";
import type { Service } from "@ironforge/shared-types";

// Demo service detail — unauthenticated. Two demo-specific behaviors
// layered on the shared ServiceDetailContent:
//
// 1. Static-catalog deprovision gating: defense in depth alongside
//    backend's 404 on DELETE for static IDs. The Deprovision button
//    never renders for the 3 known static demo services.
//
// 2. Ephemeral name display: backend computes synthetic names from
//    ID prefix on subsequent GETs (state is stateless). The visitor
//    typed a real name during create — demoApiClient stashes it in
//    sessionStorage; this wrapper reads it and passes as override
//    so the detail page reflects the visitor's intent.

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
      canDeprovision={demoCanDeprovision}
      displayNameOverride={override}
    />
  );
}

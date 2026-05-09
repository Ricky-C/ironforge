"use client";

import { CreateServiceContent } from "@/components/create-service-content";
import { cacheDemoEphemeralName, demoApiClient } from "@/lib/api-client/demo";

// Demo create form — unauthenticated. Cache the visitor-typed name in
// sessionStorage on success so the detail page can display it (the
// demo backend computes synthetic names from ID prefix on subsequent
// GETs; the typed name only appears in the POST response).

export default function DemoCreateServicePage(): React.ReactNode {
  return (
    <CreateServiceContent
      apiClient={demoApiClient}
      basePath="/demo/services"
      backHref="/demo/services"
      backLabel="Services"
      catalogQueryKey={["demo-services"]}
      onCreated={(data) => {
        cacheDemoEphemeralName(data.service.id, data.service.name);
      }}
    />
  );
}

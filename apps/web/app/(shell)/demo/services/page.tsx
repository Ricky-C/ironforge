"use client";

import { ServiceCatalogContent } from "@/components/service-catalog-content";
import { demoApiClient } from "@/lib/api-client/demo";

// Demo catalog landing — unauthenticated. Mirrors /services structure
// with a parallel basePath of /demo/services for create + detail
// links. Subphase 2.6.

export default function DemoCatalogPage(): React.ReactNode {
  return (
    <ServiceCatalogContent
      apiClient={demoApiClient}
      basePath="/demo/services"
      queryKey={["demo-services"]}
      heading="Demo: Services"
      subheading="A read-only demo of the Ironforge platform. Three example services across the live / provisioning / failed states. Try the wizard to see the provisioning flow play out in ~30 seconds."
    />
  );
}

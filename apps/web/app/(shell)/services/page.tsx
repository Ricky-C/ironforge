"use client";

import { ProtectedRoute } from "@/components/protected-route";
import { ServiceCatalogContent } from "@/components/service-catalog-content";
import { apiClient } from "@/lib/api-client";

export default function ServiceCatalogPage(): React.ReactNode {
  return (
    <ProtectedRoute>
      <ServiceCatalogContent apiClient={apiClient} basePath="/services" />
    </ProtectedRoute>
  );
}

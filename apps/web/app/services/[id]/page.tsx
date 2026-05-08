"use client";

import { ProtectedRoute } from "@/components/protected-route";
import { ServiceDetailContent } from "@/components/service-detail-content";
import { apiClient } from "@/lib/api-client";

type ServiceDetailPageProps = {
  params: Promise<{ id: string }>;
};

export default function ServiceDetailPage(
  props: ServiceDetailPageProps,
): React.ReactNode {
  return (
    <ProtectedRoute>
      <ServiceDetailContent
        params={props.params}
        apiClient={apiClient}
        backHref="/services"
        backLabel="Services"
      />
    </ProtectedRoute>
  );
}

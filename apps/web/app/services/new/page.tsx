"use client";

import { CreateServiceContent } from "@/components/create-service-content";
import { ProtectedRoute } from "@/components/protected-route";
import { apiClient } from "@/lib/api-client";

export default function CreateServicePage(): React.ReactNode {
  return (
    <ProtectedRoute>
      <CreateServiceContent apiClient={apiClient} basePath="/services" />
    </ProtectedRoute>
  );
}

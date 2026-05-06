import type { Service } from "@ironforge/shared-types";

// Service.status visualization. Used by both the catalog list (each
// row carries its status) and the detail page header. Colors are
// chosen to convey state at a glance:
//   - pending / archived: zinc (neutral; not actionable)
//   - provisioning / deprovisioning: amber (in-flight; soon-to-change)
//   - live: emerald (healthy)
//   - failed: red (needs attention)
//
// The Record type ensures exhaustiveness — adding a new ServiceStatus
// variant fails type-check here until the colorMap covers it.
export function StatusBadge({
  status,
}: {
  status: Service["status"];
}): React.ReactNode {
  const colorMap: Record<Service["status"], string> = {
    pending:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    provisioning:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    deprovisioning:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    live: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    archived:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[status]}`}
    >
      {status}
    </span>
  );
}

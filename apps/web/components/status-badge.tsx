import type { Service } from "@ironforge/shared-types";
import { cn } from "@/lib/utils";

// Service.status visualization. Used by both the catalog list (each
// row carries its status) and the detail page header. Each variant
// pairs a soft background tint with a saturated foreground for legible
// contrast in dark mode, plus a leading dot whose color matches the
// foreground. The `live` and `provisioning|deprovisioning` variants
// animate their dot — live pulses (healthy heartbeat), in-flight
// states blink (transient).
//
// The Record type ensures exhaustiveness — adding a new ServiceStatus
// variant fails type-check here until the styleMap covers it.
type Style = {
  /** Background + text classes for the badge container. */
  badge: string;
  /** Background class for the leading dot. */
  dot: string;
  /** Optional dot animation utility (defined in globals.css). */
  anim?: string;
};

const styleMap: Record<Service["status"], Style> = {
  pending: {
    badge: "bg-muted text-muted-foreground border-border",
    dot: "bg-fg-faint",
  },
  provisioning: {
    badge: "bg-warning-soft text-warning border-warning/30",
    dot: "bg-warning",
    anim: "dot-blink",
  },
  deprovisioning: {
    badge: "bg-warning-soft text-warning border-warning/30",
    dot: "bg-warning",
    anim: "dot-blink",
  },
  live: {
    badge: "bg-success-soft text-success border-success/30",
    dot: "bg-success",
    anim: "dot-pulse",
  },
  failed: {
    badge: "bg-destructive-soft text-destructive border-destructive/30",
    dot: "bg-destructive",
  },
  archived: {
    badge: "bg-muted text-muted-foreground border-border",
    dot: "bg-fg-faint",
  },
};

export function StatusBadge({
  status,
}: {
  status: Service["status"];
}): React.ReactNode {
  const s = styleMap[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
        s.badge,
      )}
    >
      <span
        className={cn("inline-block size-1.5 shrink-0 rounded-full", s.dot, s.anim)}
      />
      {status}
    </span>
  );
}

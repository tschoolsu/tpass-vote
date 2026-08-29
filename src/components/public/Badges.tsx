import { cn } from "tpass-ui";
import {
  STATUS_LABEL,
  STATUS_STYLE,
  CANDIDATE_STATUS_LABEL,
  CANDIDATE_STATUS_STYLE,
} from "@/components/public/shared";

const BADGE_BASE =
  "inline-block rounded-md border-2 border-foreground px-2 py-0.5 font-mono text-[11px] font-bold";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn(BADGE_BASE, STATUS_STYLE[status] ?? "bg-card text-foreground", className)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function CandidateStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        BADGE_BASE,
        CANDIDATE_STATUS_STYLE[status] ?? "bg-card text-foreground",
        className,
      )}
    >
      {CANDIDATE_STATUS_LABEL[status] ?? status}
    </span>
  );
}

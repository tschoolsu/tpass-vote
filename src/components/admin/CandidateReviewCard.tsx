"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, RotateCcw, XCircle, Paperclip } from "lucide-react";
import { Badge, Button, Textarea } from "@/components/ui/primitives";
import { CANDIDATE_STATUS_META } from "@/components/admin/status";
import {
  approveCandidate,
  sendBackForFix,
  rejectCandidate,
  type ActionResult,
} from "@/app/admin/elections/[id]/candidates/actions";

interface CandidateMember {
  name: string;
  email: string;
  grade?: string;
}

export function CandidateReviewCard({
  electionId,
  candidate,
  attachmentFiles,
  locked,
}: {
  electionId: string;
  candidate: {
    id: string;
    number: number | null;
    status: string;
    platform: string;
    members: unknown;
    reviewNote: string | null;
    createdBy: string;
  };
  attachmentFiles: { id: string; filename: string }[];
  locked: boolean;
}) {
  const router = useRouter();
  const [note, setNote] = useState(candidate.reviewNote ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const members = Array.isArray(candidate.members) ? (candidate.members as CandidateMember[]) : [];
  const meta = CANDIDATE_STATUS_META[candidate.status] ?? CANDIDATE_STATUS_META.pending;

  function run(fn: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-card font-mono">
          {candidate.number ? `第 ${candidate.number} 號` : "未編號"}
        </Badge>
        <Badge className={meta.badgeClass}>{meta.label}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">登記者：{candidate.createdBy}</span>
      </div>

      <div>
        <p className="font-bold text-sm mb-1">候選人</p>
        <ul className="flex flex-col gap-0.5">
          {members.map((m, i) => (
            <li key={i} className="text-sm font-medium">
              {m.name}
              {m.grade && <span className="text-muted-foreground"> · {m.grade}</span>}
              <span className="font-mono text-[11px] text-muted-foreground"> · {m.email}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="font-bold text-sm mb-1">政見</p>
        <p className="text-sm font-medium whitespace-pre-wrap">{candidate.platform}</p>
      </div>

      {attachmentFiles.length > 0 && (
        <div>
          <p className="font-bold text-sm mb-1">附件</p>
          <ul className="flex flex-col gap-1">
            {attachmentFiles.map((f) => (
              <li key={f.id}>
                <a
                  href={`/api/files/${f.id}`}
                  className="inline-flex items-center gap-1 font-mono text-xs font-bold text-accent underline"
                >
                  <Paperclip className="h-3 w-3" /> {f.filename}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {candidate.reviewNote && candidate.status !== "pending" && (
        <p className="rounded-xl border-2 border-foreground bg-tone-orange-bg p-2 text-sm font-medium text-tone-orange-text">
          審核意見：{candidate.reviewNote}
        </p>
      )}

      {!locked && (
        <div className="flex flex-col gap-3 border-t-2 border-dashed border-foreground/30 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() => run(() => approveCandidate(electionId, candidate.id))}
            >
              <CheckCircle2 className="h-4 w-4" /> 核准
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="審核意見（退回補正必填）"
              rows={2}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={pending || note.trim() === ""}
                onClick={() => run(() => sendBackForFix(electionId, candidate.id, note))}
              >
                <RotateCcw className="h-4 w-4" /> 退回補正
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => run(() => rejectCandidate(electionId, candidate.id, note || undefined))}
              >
                <XCircle className="h-4 w-4" /> 拒絕
              </Button>
            </div>
          </div>

          {error && <p className="font-mono text-xs font-bold text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

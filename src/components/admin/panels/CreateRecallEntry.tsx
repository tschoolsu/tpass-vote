"use client";
// 建立罷免案入口：只在已 published 的一般選舉工作台顯示（見 ElectionWorkbench 的
// !isRecall && status==="published" 條件）。target 只能選「當選」的候選人（組），
// 判準＝該選舉 resultsJson.candidates 裡 elected===true，交叉比對 candidates 拿到組員姓名。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert, ArrowRight } from "lucide-react";
import { Badge, Button, Textarea } from "@/components/ui/primitives";
import type { TallyResult } from "@/lib/tally";
import { createRecall } from "@/app/admin/elections/[id]/recall/actions";

interface CandidateMember {
  name: string;
  email: string;
  grade?: string;
}

interface CandidateRow {
  id: string;
  number: number | null;
  members: unknown;
}

export function CreateRecallEntry({
  electionId,
  candidates,
  resultsJson,
}: {
  electionId: string;
  candidates: CandidateRow[];
  resultsJson: unknown;
}) {
  const router = useRouter();
  const results = resultsJson as unknown as TallyResult | null;
  const electedIds = new Set((results?.candidates ?? []).filter((c) => c.elected).map((c) => c.candidateId));
  const electedCandidates = candidates.filter((c) => electedIds.has(c.id));

  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string>(electedCandidates[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ electionId: string; warnings: string[] } | null>(null);

  if (electedCandidates.length === 0) return null;

  function handleSubmit() {
    if (!targetId || reason.trim() === "") return;
    setError(null);
    startTransition(async () => {
      const result = await createRecall(electionId, targetId, reason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess({ electionId: result.electionId, warnings: result.warnings });
    });
  }

  if (success) {
    return (
      <div className="rounded-2xl border-2 border-foreground bg-tone-violet-bg p-4 shadow-[3px_3px_0_0_var(--color-foreground)]">
        <p className="font-extrabold">罷免案已建立。</p>
        {success.warnings.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {success.warnings.map((w, i) => (
              <li
                key={i}
                className="flex items-start gap-1.5 rounded-lg border-2 border-foreground bg-tone-orange-bg p-2 text-sm font-medium text-tone-orange-text"
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="mt-3"
          onClick={() => router.push(`/admin/elections/${success.electionId}`)}
        >
          前往罷免案工作台 <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <ShieldAlert className="h-3.5 w-3.5" /> 建立罷免案
      </Button>
    );
  }

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)]">
      <h3 className="mb-3 font-extrabold">建立罷免案</h3>
      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1 text-sm font-bold">罷免對象（僅列當選組別）</p>
          <div className="flex flex-col gap-1.5">
            {electedCandidates.map((c) => {
              const members = Array.isArray(c.members) ? (c.members as CandidateMember[]) : [];
              const names = members.map((m) => m.name).join("、");
              return (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-foreground bg-secondary p-2.5"
                >
                  <input
                    type="radio"
                    name="recall-target"
                    checked={targetId === c.id}
                    onChange={() => setTargetId(c.id)}
                  />
                  <Badge className="bg-card font-mono">{c.number ? `第 ${c.number} 號` : "未編號"}</Badge>
                  <span className="text-sm font-bold">{names}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-1 text-sm font-bold">罷免事由</p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={4}
            placeholder="請說明罷免事由（支援 markdown，將公開顯示於連署頁）"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !targetId || reason.trim() === ""}
            onClick={handleSubmit}
          >
            {pending ? "建立中…" : "建立罷免案"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
        </div>
        {error && <p className="font-mono text-xs font-bold text-destructive">{error}</p>}
      </div>
    </div>
  );
}

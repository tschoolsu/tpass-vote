"use client";
// 投票核心互動元件。安全不變量（本 repo AGENTS.md 紅線）：
// 選擇內容只活在這個元件的 state 裡；離開這個檔案之前一律先經 encryptBallot 變成密文，
// 送往伺服器（castBallot）的 payload 永遠只有密文字串，不會有 candidateIds / approvals 明文。
import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, cn } from "@/components/ui/primitives";
import { CandidateInfo, type PublicCandidate } from "@/components/public/CandidateCard";
import { encryptBallot, type BallotPlain } from "@/lib/ballot-crypto";
import { castBallot, type CastResult } from "@/app/e/[slug]/vote/actions";

interface Props {
  slug: string;
  electionId: string;
  kind: string;
  ballotMode: "choose" | "approval";
  maxChoices: number;
  publicKeyJwk: JsonWebKey;
  candidates: PublicCandidate[];
}

const OPTION_CARD =
  "rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200";

export function VoteForm({
  slug,
  electionId,
  kind,
  ballotMode,
  maxChoices,
  publicKeyJwk,
  candidates,
}: Props) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [approvals, setApprovals] = React.useState<Record<string, boolean>>({});
  const [blank, setBlank] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CastResult | null>(null);

  function toggleCandidate(id: string) {
    setBlank(false);
    if (ballotMode === "choose" && maxChoices === 1) {
      setSelected(new Set([id]));
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxChoices) next.add(id);
      return next;
    });
  }

  function setApproval(id: string, agree: boolean) {
    setBlank(false);
    setApprovals((prev) => ({ ...prev, [id]: agree }));
  }

  function toggleBlank() {
    setBlank((prev) => {
      const next = !prev;
      if (next) {
        setSelected(new Set());
        setApprovals({});
      }
      return next;
    });
  }

  function validate(): string | null {
    if (blank) return null;
    if (ballotMode === "choose") {
      if (selected.size === 0) return "請選擇候選人，或選擇投廢票";
      if (selected.size > maxChoices) return `最多只能選 ${maxChoices} 位`;
      return null;
    }
    const missing = candidates.some((c) => approvals[c.id] === undefined);
    if (missing) return "請對每位候選人表達同意或不同意，或選擇投廢票";
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const plain: BallotPlain = blank
      ? { v: 1, electionId, choice: { type: "blank" } }
      : ballotMode === "choose"
        ? { v: 1, electionId, choice: { type: "choose", candidateIds: [...selected] } }
        : { v: 1, electionId, choice: { type: "approval", approvals } };

    setSubmitting(true);
    try {
      const ciphertext = await encryptBallot(publicKeyJwk, plain);
      const res = await castBallot(slug, ciphertext);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setResult(res);
    } catch {
      setError("投票失敗，請重新整理頁面再試");
    } finally {
      setSubmitting(false);
    }
  }

  if (result?.ok) {
    return (
      <div className={cn(OPTION_CARD, "text-center")}>
        <p className="font-extrabold text-lg">{result.revote ? "已更新你的選票" : "投票成功"}</p>
        <p className="mt-5 break-all font-mono text-3xl font-extrabold tracking-widest">
          {result.receipt}
        </p>
        <p className="mt-2 font-mono text-[11px] font-bold text-muted-foreground">投票收據</p>
        <p className="mt-4 text-sm font-medium text-muted-foreground">
          收據可在結果頁驗證是否已入匭；截止前可再次投票，以最後一次為準。
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {candidates.length === 0 ? (
        <p className="text-sm font-medium text-muted-foreground">目前沒有核准候選人。</p>
      ) : ballotMode === "choose" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {candidates.map((c) => {
            const checked = selected.has(c.id);
            const disabled = blank || (!checked && selected.size >= maxChoices);
            return (
              <label
                key={c.id}
                className={cn(
                  OPTION_CARD,
                  "flex cursor-pointer items-start gap-3",
                  checked && "shadow-[5px_5px_0_0_var(--color-ring)] -translate-y-0.5",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type={maxChoices === 1 ? "radio" : "checkbox"}
                  name="candidate"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleCandidate(c.id)}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <CandidateInfo kind={kind} candidate={c} />
              </label>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {candidates.map((c) => {
            const value = approvals[c.id];
            return (
              <div key={c.id} className={cn(OPTION_CARD, blank && "opacity-50")}>
                <CandidateInfo kind={kind} candidate={c} />
                <div className="mt-3 flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={blank}
                    variant={value === true ? "primary" : "default"}
                    onClick={() => setApproval(c.id, true)}
                  >
                    同意
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={blank}
                    variant={value === false ? "destructive" : "default"}
                    onClick={() => setApproval(c.id, false)}
                  >
                    不同意
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={toggleBlank}
        className={cn(
          OPTION_CARD,
          "text-left font-bold",
          blank && "bg-muted shadow-[5px_5px_0_0_var(--color-foreground)] -translate-y-0.5",
        )}
      >
        {blank ? "✓ 已選擇：投廢票" : "投廢票"}
        <span className="ml-2 font-normal text-sm text-muted-foreground">
          （不支持任何候選人，仍計入投票率）
        </span>
      </button>

      {error && (
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={submitting}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {submitting ? "加密送出中…" : "送出選票"}
      </Button>
    </form>
  );
}

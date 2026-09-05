"use client";
// 投票核心互動元件。安全不變量（本 repo AGENTS.md 紅線）：
// 選擇內容只活在這個元件的 state 裡；離開這個檔案之前一律先經 encryptBallot 變成密文，
// 送往伺服器（castBallot）的 payload 永遠只有密文字串，不會有 candidateIds / approvals 明文。
//
// 流程分兩階段（stage）：select（挑選）→ confirm（送出前確認摘要）。
// 只有在 confirm 階段按下「確認送出」才會真正跑 encryptBallot + castBallot——
// 這一步的加密/送出邏輯本身沒有變，只是多了一個使用者必須主動確認的關卡。
import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, cn } from "tpass-ui";
import { CandidateInfo, type PublicCandidate } from "@/components/public/CandidateCard";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { Markdown } from "@/components/public/Markdown";
import { candidateDisplayName, ballotModeExplainer } from "@/components/public/shared";
import { encryptBallot, type BallotPlain } from "@/lib/ballot-crypto";
import { castBallot, type CastResult } from "@/app/e/[slug]/vote/actions";

interface Props {
  slug: string;
  electionId: string;
  kind: string;
  ballotMode: "choose" | "approval";
  maxChoices: number;
  seats: number;
  publicKeyJwk: JsonWebKey;
  candidates: PublicCandidate[];
  /** 罷免事由（kind="recall" 專用，來自 election.recallReason）。 */
  recallReason?: string | null;
}

const OPTION_CARD =
  "rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200";

export function VoteForm({
  slug,
  electionId,
  kind,
  ballotMode,
  maxChoices,
  seats,
  publicKeyJwk,
  candidates,
  recallReason,
}: Props) {
  const isRecall = kind === "recall";
  const target = candidates[0];
  const [stage, setStage] = React.useState<"select" | "confirm">("select");
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
    if (missing) {
      return isRecall
        ? "請表達是否同意罷免，或選擇投廢票"
        : "請對每位候選人表達同意或不同意，或選擇投廢票";
    }
    return null;
  }

  function handleReview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setStage("confirm");
  }

  function handleBack() {
    setStage("select");
    setError(null);
  }

  async function handleConfirm() {
    setError(null);

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

  const explainer = isRecall
    ? {
        label: "罷免投票・同意投票",
        body: "請就本罷免案表達同意罷免或不同意罷免，有效同意罷免票數多於不同意罷免票數者，罷免通過；或選擇投廢票。",
      }
    : ballotModeExplainer({
        ballotMode,
        candidateCount: candidates.length,
        seats,
        maxChoices,
      });
  const modeBanner = (
    <div className="rounded-2xl border-2 border-foreground bg-tone-blue-bg px-4 py-3">
      <p className="font-mono text-[11px] font-bold text-tone-blue-text">{explainer.label}</p>
      <p className="mt-1 text-sm font-medium">{explainer.body}</p>
    </div>
  );

  if (result?.ok) {
    return (
      <div className={cn(OPTION_CARD, "text-center")}>
        <p className="font-extrabold text-lg">{result.revote ? "已更新你的選票" : "投票成功"}</p>

        <p className="mt-5 font-mono text-[11px] font-bold text-muted-foreground">投票收據</p>
        <div className="mt-1.5 flex items-center justify-center gap-2">
          <span className="break-all font-mono text-2xl font-extrabold tracking-widest">
            {result.receipt}
          </span>
          <CopyLinkButton url={result.receipt} label="複製收據" iconOnly size="sm" />
        </div>

        <ul className="mx-auto mt-5 max-w-sm space-y-1.5 text-left text-sm font-medium text-muted-foreground">
          <li>・截止前可在任何裝置再次投票，以最後一次為準——舊選票會被覆蓋，不會重複計票。</li>
          <li>・開票後可到結果頁用這張收據查詢你的票是否入匭、以及被記為什麼內容（選罷法 §26-1 Ⅳ）。</li>
          <li>・收據不會連結到你的身分——彌封時系統即刪除代碼與選舉人的對應。但拿到收據的人查得出該票內容，請自行保管。</li>
        </ul>
      </div>
    );
  }

  if (stage === "confirm") {
    return (
      <div className="flex flex-col gap-4">
        {modeBanner}
        <div className={OPTION_CARD}>
          <p className="font-extrabold text-lg">送出前，請確認你的選擇</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            確認後才會在瀏覽器完成加密並送出；伺服器只會收到密文，不會看到下面這個選擇內容。
          </p>

          <div className="mt-4 rounded-xl border-2 border-foreground/20 bg-muted p-4">
            <BallotSummary
              blank={blank}
              ballotMode={ballotMode}
              kind={kind}
              candidates={candidates}
              selected={selected}
              approvals={approvals}
            />
          </div>

          {error && (
            <p className="mt-4 rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive">
              {error}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <Button type="button" variant="default" onClick={handleBack} disabled={submitting}>
              返回修改
            </Button>
            <Button type="button" variant="primary" onClick={handleConfirm} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "加密送出中…" : "確認送出"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleReview} className="flex flex-col gap-4">
      {modeBanner}
      {candidates.length === 0 ? (
        <p className="text-sm font-medium text-muted-foreground">目前沒有核准候選人。</p>
      ) : isRecall && target ? (
        <div className="flex flex-col gap-3">
          <div className={OPTION_CARD}>
            <p className="font-mono text-[11px] font-bold text-muted-foreground">罷免對象</p>
            <div className="mt-2">
              <CandidateInfo kind={kind} candidate={target} expanded />
            </div>
            {recallReason && (
              <div className="mt-4 border-t-2 border-foreground/10 pt-3">
                <p className="font-bold text-accent text-sm">罷免事由</p>
                <div className="mt-1.5 text-sm text-foreground/80">
                  <Markdown text={recallReason} />
                </div>
              </div>
            )}
          </div>
          <div className={cn(OPTION_CARD, blank && "opacity-50")}>
            <p className="font-extrabold">你是否同意罷免？</p>
            <div className="mt-3 flex gap-3">
              <Button
                type="button"
                disabled={blank}
                variant={approvals[target.id] === true ? "primary" : "default"}
                aria-pressed={approvals[target.id] === true}
                onClick={() => setApproval(target.id, true)}
                className="h-11 flex-1"
              >
                同意罷免
              </Button>
              <Button
                type="button"
                disabled={blank}
                variant={approvals[target.id] === false ? "destructive" : "default"}
                aria-pressed={approvals[target.id] === false}
                onClick={() => setApproval(target.id, false)}
                className="h-11 flex-1"
              >
                不同意罷免
              </Button>
            </div>
          </div>
        </div>
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
                <CandidateInfo kind={kind} candidate={c} expanded />
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
                <CandidateInfo kind={kind} candidate={c} expanded />
                <div className="mt-3 flex gap-3">
                  <Button
                    type="button"
                    disabled={blank}
                    variant={value === true ? "primary" : "default"}
                    aria-pressed={value === true}
                    onClick={() => setApproval(c.id, true)}
                    className="h-11 flex-1"
                  >
                    同意
                  </Button>
                  <Button
                    type="button"
                    disabled={blank}
                    variant={value === false ? "destructive" : "default"}
                    aria-pressed={value === false}
                    onClick={() => setApproval(c.id, false)}
                    className="h-11 flex-1"
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
          "rounded-xl border-2 border-dashed border-foreground/30 bg-transparent px-4 py-2.5 text-left text-sm font-bold text-muted-foreground transition-colors duration-200 hover:border-foreground/60 hover:text-foreground",
          blank && "border-solid border-foreground bg-muted text-foreground",
        )}
      >
        {blank ? "✓ 已選擇：投廢票" : "投廢票"}
        <span className="ml-2 font-normal text-xs text-muted-foreground">
          {isRecall ? "（不表態同意或不同意，仍計入投票率）" : "（不支持任何候選人，仍計入投票率）"}
        </span>
      </button>

      {error && (
        <p className="rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" variant="primary">
        下一步：確認選擇
      </Button>
    </form>
  );
}

/** 送出前確認摘要：純展示，讀 state 但不動它，讓投票者在加密前看清楚自己選了誰。 */
function BallotSummary({
  blank,
  ballotMode,
  kind,
  candidates,
  selected,
  approvals,
}: {
  blank: boolean;
  ballotMode: "choose" | "approval";
  kind: string;
  candidates: PublicCandidate[];
  selected: Set<string>;
  approvals: Record<string, boolean>;
}) {
  const isRecall = kind === "recall";

  if (blank) {
    return (
      <p className="font-bold">
        {isRecall ? "投廢票（不表態同意或不同意罷免）" : "投廢票（不支持任何候選人）"}
      </p>
    );
  }

  if (isRecall) {
    const target = candidates[0];
    const agree = target ? approvals[target.id] : undefined;
    return (
      <p
        className={cn(
          "font-bold",
          agree ? "text-tone-green-text" : "text-destructive",
        )}
      >
        {agree ? "同意罷免" : "不同意罷免"}
      </p>
    );
  }

  if (ballotMode === "choose") {
    const chosen = candidates.filter((c) => selected.has(c.id));
    return (
      <ul className="space-y-1.5">
        {chosen.map((c) => (
          <li key={c.id} className="font-bold">
            {c.number !== null ? `${c.number} 號・` : ""}
            {candidateDisplayName(kind, c.members)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="space-y-1.5">
      {candidates.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3">
          <span className="font-bold">
            {c.number !== null ? `${c.number} 號・` : ""}
            {candidateDisplayName(kind, c.members)}
          </span>
          <span
            className={cn(
              "font-mono text-xs font-bold",
              approvals[c.id] ? "text-tone-green-text" : "text-destructive",
            )}
          >
            {approvals[c.id] ? "同意" : "不同意"}
          </span>
        </li>
      ))}
    </ul>
  );
}

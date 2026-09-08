"use client";
// 投票核心互動元件。安全不變量（本 repo AGENTS.md 紅線）：
// 選擇內容只活在這個元件的 state 裡；離開這個檔案之前一律先經 encryptBallot 變成密文，
// 送往伺服器（castBallot）的 payload 永遠只有密文字串，不會有 candidateIds / approvals 明文。
//
// 流程分兩階段（stage）：select（挑選）→ confirm（送出前確認摘要＋可回溯代碼）。
//
// 加密發生在「進入 confirm 時」，而不是按下送出時，而且整個流程只加密一次。理由有兩個：
// 1. 一人一票、送出後不能改，代碼弄丟就永遠救不回來。先加密才能在送出前把代碼顯示給
//    投票人抄下來——網路中斷、server action 逾時都不會再弄丟它。
// 2. encryptBallot 每次呼叫都產生一組全新的隨機代碼並封進密文。若確認頁加密一次顯示、
//    送出時又加密一次，投票人抄走的代碼會跟真正入匭的那張票對不起來。這是災難級的 bug，
//    所以 handleConfirm 絕對不可以再呼叫 encryptBallot——它只送 sealed.ciphertext。
// 「返回修改」必須把 sealed 清掉，否則改了選擇卻送出舊密文。
import * as React from "react";
import { Loader2 } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { Button, cn } from "tpass-ui";
import { CandidateInfo, type PublicCandidate } from "@/components/public/CandidateCard";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { Markdown } from "@/components/public/Markdown";
import { candidateDisplayName, ballotModeExplainer } from "@/components/public/shared";
import { encryptBallot, type BallotChoice } from "@/lib/ballot-crypto";
import { castBallot, type CastResult } from "@/app/e/[slug]/vote/actions";
import { draftStorageKey, serializeDraft, parseDraft, type VoteDraft } from "@/lib/vote-draft";

interface Props {
  slug: string;
  /** 本場選舉裡這個投票人的 Voter.id（server component 已用 session.email 查過名冊）。
   *  只用來把 sessionStorage 草稿跟「這個人」綁在一起，不是拿去做任何伺服器端授權判斷。 */
  voterId: string;
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
  voterId,
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
  const [preparing, setPreparing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CastResult | null>(null);
  // 密文與封在裡面的可回溯代碼。只活在這個元件的 state 裡：伺服器收不到代碼，
  // 也不寫進 sessionStorage（見 vote-draft.ts 的模組註解），所以重整頁面就沒了。
  const [sealed, setSealed] = React.useState<{ ciphertext: string; code: string } | null>(null);
  const [restoredNotice, setRestoredNotice] = React.useState(false);

  // 頁面停留太久導致 token 過期時，castBallot 內的 requireSession 會導去登入頁，
  // 讓這個元件被整個卸載——選擇內容只活在 state 裡，導航一發生就沒了。
  // 送出前把選擇存一份到 sessionStorage，登入完回到這頁時撿回來，不必重選。
  // key 綁 voterId：共用電腦同一分頁接力登入的下一個人，key 天生不同，讀不到上一個人的草稿。
  React.useEffect(() => {
    let draft: VoteDraft | null = null;
    try {
      draft = parseDraft(sessionStorage.getItem(draftStorageKey(slug, voterId)));
    } catch {
      draft = null;
    }
    if (!draft) return;
    // 這是一次性、掛載時對外部儲存（sessionStorage）的同步，不是衍生狀態；
    // 依賴陣列刻意留空，這幾行 setState 不會造成連鎖重render。
    /* eslint-disable react-hooks/set-state-in-effect */
    setBlank(draft.blank);
    setSelected(new Set(draft.selected));
    setApprovals(draft.approvals);
    setRestoredNotice(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleCandidate(id: string) {
    setRestoredNotice(false);
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
    setRestoredNotice(false);
    setBlank(false);
    setApprovals((prev) => ({ ...prev, [id]: agree }));
  }

  function toggleBlank() {
    setRestoredNotice(false);
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

  async function handleReview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    const choice: BallotChoice = blank
      ? { type: "blank" }
      : ballotMode === "choose"
        ? { type: "choose", candidateIds: [...selected] }
        : { type: "approval", approvals };

    // 全程唯一一次加密。代碼在這裡產生、封進密文，確認頁馬上顯示給投票人抄下來；
    // 伺服器只拿得到密文，永遠算不出代碼。
    setPreparing(true);
    let next: { ciphertext: string; code: string };
    try {
      next = await encryptBallot(publicKeyJwk, { electionId, choice });
    } catch {
      setError("選票加密失敗，請重新整理頁面再試");
      return;
    } finally {
      setPreparing(false);
    }

    // 草稿在「進確認頁」就寫，不是等到按送出才寫：投票人很可能停在確認頁抄代碼抄一陣子，
    // token 過期會把整個元件卸載，state 就沒了；重登回來靠這份草稿還原，不必重選一次。
    try {
      sessionStorage.setItem(
        draftStorageKey(slug, voterId),
        serializeDraft({ blank, selected: [...selected], approvals }),
      );
    } catch {
      // sessionStorage 不可用（無痕模式關閉站台資料等）就放棄還原，不影響本次送出。
    }

    setSealed(next);
    setStage("confirm");
  }

  function handleBack() {
    setStage("select");
    setError(null);
    // 選擇可能會被改掉，這份密文就不能用了——留著會變成「改了選擇卻送出舊密文」。
    // 下次進確認頁會重新加密，也會拿到一組新的代碼。
    setSealed(null);
  }

  async function handleConfirm() {
    // 這裡刻意不呼叫 encryptBallot：密文與代碼在 handleReview 就定案了，
    // 再加密一次會換掉代碼，投票人抄走的那組就對不上真正入匭的票（見檔頭）。
    if (!sealed) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await castBallot(slug, sealed.ciphertext);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      try {
        sessionStorage.removeItem(draftStorageKey(slug, voterId));
      } catch {
        // 拿不到就算了，不影響已經成功的投票。
      }
      setResult(res);
    } catch (err) {
      // castBallot 內的 requireSession 在 token 過期時會呼叫 redirect()，
      // 這會以拋錯的方式離開 castBallot——不是投票失敗，是要導去登入頁重新整理 session，
      // 必須原樣往上丟給 Next 處理，不能被這裡吞掉顯示成錯誤訊息。
      unstable_rethrow(err);
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

  if (result?.ok && sealed !== null) {
    return (
      <div className={cn(OPTION_CARD, "text-center")}>
        <p className="font-extrabold text-lg">投票成功</p>
        <p className="mt-1 text-sm font-medium text-muted-foreground">
          你的選票已加密入匭。每人只能投一次，這張票無法更改或撤回。
        </p>
        <ReceiptPanel code={sealed.code} submitted />
      </div>
    );
  }

  if (stage === "confirm" && sealed !== null) {
    return (
      <div className="flex flex-col gap-4">
        {modeBanner}
        <div className={OPTION_CARD}>
          <p className="font-extrabold text-lg">送出前，請確認你的選擇</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            選票已在你的瀏覽器加密完成，伺服器只會收到密文，不會看到下面這個選擇內容。
          </p>
          <p className="mt-2 text-sm font-bold text-destructive">
            ⚠️ 每人只能投一次，送出後無法更改或撤回，選委會也無法代為重設。
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

          <ReceiptPanel code={sealed.code} submitted={false} />

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive"
            >
              {error}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <Button type="button" variant="default" onClick={handleBack} disabled={submitting}>
              返回修改
            </Button>
            <Button type="button" variant="primary" onClick={handleConfirm} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitting ? "送出中…" : "確認送出"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleReview} className="flex flex-col gap-4">
      {modeBanner}
      {restoredNotice && (
        <div className="rounded-xl border-2 border-foreground/20 bg-muted px-4 py-2.5 text-sm">
          <p className="font-bold">已還原你剛才的選擇</p>
          <p className="mt-1 font-medium text-muted-foreground">
            如果你先前已經看過可回溯代碼，那組代碼沒有送出、不會生效；請以這次確認頁顯示的新代碼為準。
          </p>
        </div>
      )}
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
        <p
          role="alert"
          className="rounded-xl border-2 border-destructive bg-card px-4 py-3 font-bold text-destructive"
        >
          {error}
        </p>
      )}

      <Button type="submit" variant="primary" disabled={preparing}>
        {preparing && <Loader2 className="h-4 w-4 animate-spin" />}
        {preparing ? "加密中…" : "下一步：確認選擇"}
      </Button>
    </form>
  );
}

/**
 * 可回溯代碼面板。確認頁與成功頁共用同一個元件——代碼出現在哪，保管與失效的提醒就跟到哪，
 * 不會有一邊漏掉（tests/docs-and-ci.test.ts 就是在守這件事）。
 */
function ReceiptPanel({ code, submitted }: { code: string; submitted: boolean }) {
  return (
    <div className="mt-5">
      <p className="font-mono text-[11px] font-bold text-muted-foreground">投票收據</p>
      <div className="mt-1.5 flex items-center justify-center gap-2">
        <span className="break-all font-mono text-2xl font-extrabold tracking-widest">{code}</span>
        <CopyLinkButton url={code} label="複製收據" iconOnly size="sm" />
      </div>

      <ul className="mx-auto mt-5 max-w-sm space-y-1.5 text-left text-sm font-medium text-muted-foreground">
        <li className="font-bold text-foreground">
          ・請自行保管，不要給別人看：知道代碼的人可以讓這張票失效。
        </li>
        <li>・開票後可到結果頁用這組代碼查詢你的票是否入匭、以及被記為什麼內容（選罷法 §26-1 Ⅳ）。</li>
        <li>・這組代碼是你的瀏覽器產生的，封在加密選票裡送出，伺服器從頭到尾看不到它。</li>
        {submitted ? (
          <li className="font-bold text-foreground">
            ・<span className="underline">這是最後一次顯示，離開或重新整理就再也拿不回來</span>，
            而且每人只能投一次，沒辦法再投一次換一組新的。
          </li>
        ) : (
          <li className="font-bold text-foreground">
            ・<span className="underline">現在就抄下來</span>
            ——這組代碼要按下「確認送出」之後才會生效；如果你返回修改選擇，會換成另一組新的代碼。
          </li>
        )}
      </ul>
    </div>
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

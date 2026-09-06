"use client";
// ⑤截止與開票（合併階段）：把「票匭已截止 → 彌封票匭 → 上傳金鑰檔 → 本地解密計票 → 提交結果」
// 五個子步驟用線性 stepper 呈現，順序即操作程序。彌封（sealElection）與開票（TallyPanel/
// TallyClient 內的上傳/解密/提交，含私鑰只活在 component state 的邏輯）完全不動，這裡只重排
// 外層呈現與子步驟說明——上傳/解密/提交三步在 TallyClient 裡本來就是一段連續操作，沒有可從
// 伺服器觀察的中間狀態，所以合併成一個子步驟區塊呈現，內文用編號列表講清楚三個動作各自在做什麼。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, CheckCircle2, ChevronDown, ChevronRight, Circle, AlertTriangle } from "lucide-react";
import { RedoElectionButton } from "@/components/admin/RedoElectionButton";
import { Button, ConfirmDialog, cn } from "tpass-ui";
import { TallyPanel } from "@/components/admin/panels/TallyPanel";

type SubStepState = "done" | "current" | "pending";
type SealResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; needsConfirm: true; ballots: number };

function SubStep({
  n,
  title,
  description,
  state,
  children,
}: {
  n: string;
  title: string;
  description: string;
  state: SubStepState;
  children?: React.ReactNode;
}) {
  const clickable = state !== "pending" && Boolean(children);
  const [open, setOpen] = useState(state === "current");

  return (
    <div
      className={cn(
        "rounded-xl border-2 p-3",
        state === "current" && "border-foreground bg-tone-blue-bg",
        state === "done" && "border-foreground/40 bg-card",
        state === "pending" && "border-foreground/20 bg-muted/30",
      )}
    >
      <button
        type="button"
        disabled={!clickable}
        onClick={() => setOpen((o) => !o)}
        className={cn("flex w-full items-center gap-2.5 text-left", clickable ? "cursor-pointer" : "cursor-default")}
      >
        {state === "done" ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-tone-green-text" />
        ) : state === "current" ? (
          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-primary px-1 text-[11px] font-bold text-primary-foreground">
            {n}
          </span>
        ) : (
          <Circle className="h-5 w-5 shrink-0 text-muted-foreground/40" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn("font-bold text-sm", state === "pending" && "text-muted-foreground")}>{title}</span>
          <span className="ml-2 text-xs font-medium text-muted-foreground">{description}</span>
        </span>
        {clickable &&
          (open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          ))}
      </button>
      {open && children && <div className="mt-3 pl-7">{children}</div>}
    </div>
  );
}

// 彌封按鈕：先一般性確認「無法再變更」，若伺服器因票數過少（D3-2：一票選舉的
// 公開名冊×公開明細會直接曝光個別選舉人的選擇）回報 needsConfirm，再多問一次
// 才帶著 confirmSmallBox 重送——不是攔阻，是逼選委正視匿名性風險再按一次。
function SealButton({ onSeal }: { onSeal: (confirmSmallBox?: boolean) => Promise<SealResult> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [smallBoxBallots, setSmallBoxBallots] = useState<number | null>(null);

  function runSeal(confirmSmallBox?: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await onSeal(confirmSmallBox);
      setConfirmOpen(false);
      if (!result.ok) {
        if ("needsConfirm" in result) {
          setSmallBoxBallots(result.ballots);
          return;
        }
        setSmallBoxBallots(null);
        setError(result.error);
        return;
      }
      setSmallBoxBallots(null);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant="destructive"
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
      >
        <Lock className="h-4 w-4" /> 彌封票匭
      </Button>
      {error && <p role="alert" className="font-mono text-xs font-bold text-destructive">{error}</p>}
      <ConfirmDialog
        open={confirmOpen}
        title="請確認"
        description="彌封後票匭無法再變更，確定要彌封嗎？"
        pending={pending}
        onConfirm={() => runSeal(false)}
        onCancel={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={smallBoxBallots !== null}
        title="請確認"
        description={`只有 ${smallBoxBallots} 張票，公開明細可能識別出投票人，確定彌封？`}
        pending={pending}
        onConfirm={() => runSeal(true)}
        onCancel={() => setSmallBoxBallots(null)}
      />
    </div>
  );
}

export function ClosingTallyPanel({
  status,
  votingEndsAt,
  sealedAt,
  sealedBy,
  onSeal,
  resultsExist,
  tally,
  ballotCount,
  isSuperAdmin,
}: {
  status: string;
  votingEndsAt: Date | null;
  sealedAt: Date | null;
  sealedBy: string | null;
  onSeal: (confirmSmallBox?: boolean) => Promise<SealResult>;
  resultsExist: boolean;
  tally: React.ComponentProps<typeof TallyPanel>;
  ballotCount: number;
  isSuperAdmin: boolean;
}) {
  const sealed = status === "sealed" || status === "published";

  return (
    <div className="flex flex-col gap-2">
      <SubStep
        n="1"
        title="票匭已截止"
        description={
          votingEndsAt
            ? `投票已於 ${votingEndsAt.toLocaleString("zh-TW")} 截止，票匭不再變動，等待彌封。`
            : "投票已截止，票匭不再變動，等待彌封。"
        }
        state="done"
      />

      <SubStep
        n="2"
        title="彌封票匭"
        description="去識別＋洗牌後鎖定票匭快照，之後任何人（包含選委）都無法再變更票匭內容。"
        state={sealed ? "done" : "current"}
      >
        {sealed ? (
          <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            已於 {sealedAt ? sealedAt.toLocaleString("zh-TW") : "?"} 由 {sealedBy ?? "?"} 彌封。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-muted-foreground">
              彌封後只能憑金鑰在本地開票，此後無法回頭變更票匭。
            </p>
            <SealButton onSeal={onSeal} />
          </div>
        )}
      </SubStep>

      <SubStep
        n="3–5"
        title="上傳金鑰檔 → 本地解密計票 → 提交結果"
        description={
          resultsExist
            ? "已提交計票結果，可到下方展開重新核算或查看明細。"
            : sealed
              ? "以下操作皆在你的瀏覽器本機完成，私鑰不落地、不上傳伺服器。"
              : "尚未彌封，還不能開票。"
        }
        state={!sealed ? "pending" : resultsExist ? "done" : "current"}
      >
        {sealed && (
          <div className="flex flex-col gap-3">
            <ol className="list-decimal space-y-0.5 pl-4 text-xs font-medium text-muted-foreground">
              <li>上傳開票金鑰檔（1 或 2 份分持，視選舉設定）</li>
              <li>在本頁本地解密計票（私鑰只存在瀏覽器記憶體，不落地、不上傳）</li>
              <li>確認計票結果無誤後提交</li>
            </ol>
            <TallyPanel {...tally} />
          </div>
        )}
      </SubStep>

      <div className="mt-2 flex items-start gap-2 rounded-xl border-2 border-foreground bg-tone-rose-bg p-3 text-tone-rose-text">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-bold">
            金鑰檔打不開，或分持金鑰確定有一份遺失？這場選舉將永遠無法開票，只能作廢並重辦
            （複製名冊與已核准候選人到新場次，新場次需要重新產生金鑰）。
          </p>
          <div>
            <RedoElectionButton
              electionId={tally.electionId}
              status={status}
              ballotCount={ballotCount}
              isSuperAdmin={isSuperAdmin}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

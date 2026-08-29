"use client";
// 罷免連署進度＋連署／撤簽行動（公開端）。視覺與管理端 RecallPetitionPanel 一致
// （同一套進度條/徽章樣式），但這裡多了 client 互動：登入/資格/已署三態各自對應一種呈現。
//
// 身分一律不信任 client：這裡顯示的「你的狀態」只是 server 端算好傳進來的初始值，
// 真正擋人的是 signRecall/withdrawSignature 這兩個 server action 自己的 requireSession——
// 連署開放全校，client 這層的狀態只是 UX，不是安全邊界。
import * as React from "react";
import { CheckCircle2, XCircle, Users2 } from "lucide-react";
import { Badge, Button, cn } from "tpass-ui";
import { LinkButton } from "@/components/public/LinkButton";
import { signRecall, withdrawSignature } from "@/app/e/[slug]/recall/actions";

export type RecallRosterState = "not_logged_in" | "not_signed" | "signed";

export function RecallSignaturePanel({
  slug,
  status,
  loginUrl,
  rosterState: initialRosterState,
  initialCount,
  threshold,
}: {
  slug: string;
  status: string;
  loginUrl: string;
  rosterState: RecallRosterState;
  initialCount: number;
  threshold: number;
}) {
  const [count, setCount] = React.useState(initialCount);
  const [rosterState, setRosterState] = React.useState(initialRosterState);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const passed = count >= threshold;
  const pct = threshold > 0 ? Math.min(100, Math.round((count / threshold) * 100)) : 0;
  const isPetition = status === "petition";

  function handleSign() {
    setError(null);
    startTransition(async () => {
      const res = await signRecall(slug);
      if (res.ok) {
        setCount(res.count);
        setRosterState("signed");
      } else {
        setError(res.error);
      }
    });
  }

  function handleWithdraw() {
    setError(null);
    startTransition(async () => {
      const res = await withdrawSignature(slug);
      if (res.ok) {
        setCount(res.count);
        setRosterState("not_signed");
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="flex items-center gap-2 font-extrabold text-base">
          <Users2 className="h-4 w-4" /> 連署進度
        </h2>
        {passed ? (
          <Badge className="bg-tone-green-badge text-tone-green-text">
            <CheckCircle2 className="mr-1 inline h-3 w-3" /> 已達門檻
          </Badge>
        ) : (
          <Badge className="bg-tone-orange-badge text-tone-orange-text">
            <XCircle className="mr-1 inline h-3 w-3" /> 未達門檻
          </Badge>
        )}
      </div>

      <p className="font-mono text-2xl font-extrabold">
        {count} <span className="text-base font-bold text-muted-foreground">/ {threshold}</span>
      </p>
      <div className="mt-2 h-4 w-full overflow-hidden rounded-full border-2 border-foreground bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-300",
            passed ? "bg-tone-green-badge" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {isPetition ? (
        <div className="mt-4">
          {rosterState === "not_logged_in" && (
            <LinkButton href={loginUrl} variant="primary">
              登入以連署
            </LinkButton>
          )}
          {rosterState === "not_signed" && (
            <Button variant="primary" onClick={handleSign} disabled={pending}>
              {pending ? "處理中…" : "我要連署"}
            </Button>
          )}
          {rosterState === "signed" && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-tone-green-badge text-tone-green-text">已連署</Badge>
              <Button variant="destructive" onClick={handleWithdraw} disabled={pending}>
                {pending ? "處理中…" : "撤回連署"}
              </Button>
            </div>
          )}
          {error && <p className="mt-2 text-sm font-bold text-destructive">{error}</p>}
        </div>
      ) : (
        <p className="mt-3 text-sm font-medium text-muted-foreground">
          連署期已結束，以上為連署截止時的最終數字。
        </p>
      )}
    </div>
  );
}

// ③政見／④投票面板：主要顯示進度（即時投票率、投票起訖倒數）。發公告走頂層公告區塊，
// 這裡不重複放公告 UI。純顯示，重用 public/shared 的倒數/格式化純函式（無 IO）。
import { CalendarClock, Users2 } from "lucide-react";
import { Card, cn } from "@/components/ui/primitives";
import { describeRemaining, formatDateTime } from "@/components/public/shared";

export function CampaignVotingPanel({
  registrationStartsAt,
  registrationEndsAt,
  votingStartsAt,
  votingEndsAt,
  rosterCount,
  votedCount,
  turnoutPct,
  status,
  hideRegistration = false,
}: {
  registrationStartsAt: Date | null;
  registrationEndsAt: Date | null;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
  rosterCount: number;
  votedCount: number;
  turnoutPct: number | null;
  status: "campaigning" | "voting";
  // 罷免鏈沒有候選人登記期，重用本面板時隱藏「登記期間」列（純呈現層開關，不影響邏輯）。
  hideRegistration?: boolean;
}) {
  const now = new Date();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h3 className="flex items-center gap-2 font-extrabold mb-3">
          <CalendarClock className="h-4 w-4" /> 期程
        </h3>
        <dl className={cn("grid grid-cols-1 gap-3", !hideRegistration && "sm:grid-cols-2")}>
          {!hideRegistration && (
            <div className="rounded-xl border-2 border-foreground/15 p-3">
              <dt className="font-mono text-[11px] font-bold text-muted-foreground">登記期間</dt>
              <dd className="mt-1 font-bold">
                {formatDateTime(registrationStartsAt)} ～ {formatDateTime(registrationEndsAt)}
              </dd>
            </div>
          )}
          <div className="rounded-xl border-2 border-foreground/15 p-3">
            <dt className="font-mono text-[11px] font-bold text-muted-foreground">投票期間</dt>
            <dd className="mt-1 font-bold">
              {formatDateTime(votingStartsAt)} ～ {formatDateTime(votingEndsAt)}
            </dd>
            {status === "campaigning" && votingStartsAt && (
              <dd className="mt-0.5 text-sm font-medium text-accent">{describeRemaining(votingStartsAt, now)}後開始投票</dd>
            )}
            {status === "voting" && votingEndsAt && (
              <dd className="mt-0.5 text-sm font-medium text-accent">{describeRemaining(votingEndsAt, now)}後截止</dd>
            )}
          </div>
        </dl>
      </Card>

      {status === "voting" && (
        <Card>
          <h3 className="flex items-center gap-2 font-extrabold mb-2">
            <Users2 className="h-4 w-4" /> 即時投票率
          </h3>
          <p className="font-mono text-2xl font-extrabold">
            {turnoutPct ?? 0}%
            <span className="ml-2 text-sm font-medium text-muted-foreground">
              （{votedCount}/{rosterCount}）
            </span>
          </p>
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            截止前選舉人可跨裝置無限重投，以最後一次為準——這裡的數字只反映「入匭人數」，不反映內容。
          </p>
        </Card>
      )}
    </div>
  );
}

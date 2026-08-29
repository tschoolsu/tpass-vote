// 當前階段卡：永遠明講「現在該做什麼」＋下一步按鈕。狀態機只能單向前進，
// closed→sealed 走下方「⑤截止與開票」面板內的彌封按鈕、sealed→published 走結果公告面板
// 發布，都不在這顆卡的推進按鈕範圍內——這兩段只給文字指引指向對應面板，不重複放操作按鈕，
// 避免同一顆彌封按鈕在畫面上出現兩次讓選委看不懂該按哪個。
import { CheckCircle2, XCircle } from "lucide-react";
import { Card } from "tpass-ui";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { STATUS_META, type ElectionStatus } from "@/components/admin/status";

type Result = { ok: true } | { ok: false; error: string };

export function CurrentStageCard({
  status,
  next,
  votingPrecheck,
  votingBlocked,
  previewBallotMode,
  resultsExist,
  onAdvance,
  closingLabel,
  publishedLabel,
}: {
  status: ElectionStatus;
  next?: ElectionStatus;
  votingPrecheck?: { label: string; ok: boolean; detail?: string }[];
  votingBlocked?: boolean;
  previewBallotMode?: string;
  resultsExist?: boolean;
  onAdvance: () => Promise<Result>;
  // 「⑤截止與開票」「⑥結果公告」的階段編號一般鏈與罷免鏈不同（見 status.ts 的
  // UI_STAGE_LABEL／RECALL_UI_STAGE_LABEL），由呼叫端傳入正確編號的標籤，這裡不重複定義。
  closingLabel: string;
  publishedLabel: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;

  return (
    <Card>
      <h2 className="font-extrabold mb-3">現在該做什麼</h2>

      {next && (
        <div className="flex flex-col gap-2">
          {next === "voting" && votingPrecheck && (
            <ul className="flex flex-col gap-1 mb-1">
              {votingPrecheck.map((c) => (
                <li key={c.label} className="flex items-center gap-1.5 text-sm font-medium">
                  {c.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-tone-green-text" />
                  ) : (
                    <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                  )}
                  {c.label}
                  {c.detail && <span className="text-muted-foreground">（{c.detail}）</span>}
                </li>
              ))}
              {previewBallotMode && (
                <li className="text-xs font-mono text-muted-foreground">
                  預覽開票模式：{previewBallotMode}
                </li>
              )}
            </ul>
          )}
          <div>
            <ConfirmActionButton
              action={onAdvance}
              label={`推進到「${STATUS_META[next].label}」`}
              variant="primary"
              disabled={votingBlocked}
              confirmMessage={`確定要把狀態從「${meta.label}」推進到「${STATUS_META[next].label}」嗎？狀態機只能單向前進，無法回頭。`}
            />
          </div>
        </div>
      )}

      {status === "closed" && (
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          投票已截止，請到下方「{closingLabel}」完成彌封票匭。
        </p>
      )}
      {status === "sealed" && !resultsExist && (
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          已彌封，請到下方「{closingLabel}」上傳金鑰檔、本地解密計票並提交結果。
        </p>
      )}
      {status === "sealed" && resultsExist && (
        <p className="mt-2 text-sm font-medium text-muted-foreground">
          計票結果已提交，請到下方「{publishedLabel}」小編後發布，完成整場選舉流程。
        </p>
      )}
      {status === "published" && (
        <p className="mt-2 text-sm font-medium text-muted-foreground">結果已公告，本場選舉流程結束。</p>
      )}
    </Card>
  );
}

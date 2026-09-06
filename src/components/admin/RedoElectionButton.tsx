"use client";
// 「作廢並重辦」按鈕：金鑰確定遺失、這場永遠無法開票時的最後手段。呼叫 redoElection
// （見 [id]/actions.ts）：原場同一交易內軟刪除，新場複製名冊＋已核准候選人、從零產生金鑰。
// 成功後直接導去新場，不用 ConfirmActionButton（那個只認 {ok}|{ok:false,error} 不處理
// 回傳的 electionId 導頁，這裡需要自訂 handler）。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button, ConfirmDialog, Textarea } from "tpass-ui";
import { redoElection } from "@/app/admin/elections/[id]/actions";

// D14-1：voting／closed／sealed 這三個狀態已經可能有票，redoElection 在伺服器端只准
// 超級管理員附理由才放行——這裡只是把「要不要顯示理由輸入框」提前判斷，真正的授權
// 檢查在伺服器（一般管理員就算填了理由送出，伺服器一樣會拒絕）。
const REQUIRES_SUPERADMIN_REASON = new Set(["voting", "closed", "sealed"]);

export function RedoElectionButton({
  electionId,
  status,
  ballotCount,
  isSuperAdmin,
  className,
}: {
  electionId: string;
  status: string;
  ballotCount: number;
  isSuperAdmin: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");

  const needsReason = REQUIRES_SUPERADMIN_REASON.has(status);
  const showReasonInput = needsReason && isSuperAdmin;

  function runAction() {
    setError(null);
    startTransition(async () => {
      const result = await redoElection(electionId, reason);
      if (!result.ok) {
        setConfirmOpen(false);
        setError(result.error);
        return;
      }
      router.push(`/admin/elections/${result.electionId}`);
    });
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        className={className}
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
      >
        <RotateCcw className="h-3.5 w-3.5" /> {pending ? "處理中…" : "作廢並重辦"}
      </Button>
      {error && <p role="alert" className="font-mono text-xs font-bold text-destructive">{error}</p>}
      <ConfirmDialog
        open={confirmOpen}
        title="確定要作廢本場並重辦嗎？"
        description={
          <div className="flex flex-col gap-3 whitespace-pre-wrap">
            <p>
              {"本場將被軟刪除（資料保留但從列表消失，可還原但無法復原到「未作廢」的流程狀態）；" +
                "系統會建立一個新場次，複製名冊與已核准候選人，新場次需要重新產生開票金鑰。\n\n" +
                "僅在金鑰確定遺失、真的無法開票時才使用此功能。"}
            </p>
            {ballotCount > 0 && (
              <p className="font-bold text-destructive">
                本場已有 {ballotCount} 張票將作廢，且沒有任何方式能把票搬到新場次。
              </p>
            )}
            {showReasonInput && (
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="重辦理由（必填，會記錄於稽核紀錄）"
              />
            )}
          </div>
        }
        confirmLabel={pending ? "處理中…" : "確定作廢"}
        pending={pending}
        onConfirm={runAction}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

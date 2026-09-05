"use client";
// 「作廢並重辦」按鈕：金鑰確定遺失、這場永遠無法開票時的最後手段。呼叫 redoElection
// （見 [id]/actions.ts）：原場同一交易內軟刪除，新場複製名冊＋已核准候選人、從零產生金鑰。
// 成功後直接導去新場，不用 ConfirmActionButton（那個只認 {ok}|{ok:false,error} 不處理
// 回傳的 electionId 導頁，這裡需要自訂 handler）。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button, ConfirmDialog } from "tpass-ui";
import { redoElection } from "@/app/admin/elections/[id]/actions";

export function RedoElectionButton({ electionId, className }: { electionId: string; className?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function runAction() {
    setError(null);
    startTransition(async () => {
      const result = await redoElection(electionId);
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
      {error && <p className="font-mono text-xs font-bold text-destructive">{error}</p>}
      <ConfirmDialog
        open={confirmOpen}
        title="確定要作廢本場並重辦嗎？"
        description={
          <div className="whitespace-pre-wrap">
            {"本場將被軟刪除（資料保留但從列表消失，可還原但無法復原到「未作廢」的流程狀態）；" +
              "系統會建立一個新場次，複製名冊與已核准候選人，新場次需要重新產生開票金鑰。\n\n" +
              "僅在金鑰確定遺失、真的無法開票時才使用此功能。"}
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

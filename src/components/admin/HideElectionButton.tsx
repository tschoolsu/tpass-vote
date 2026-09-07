"use client";
// 「刪除（軟刪除）」按鈕：多數狀態按下去只是打上 hiddenAt、隨時可還原；但 voting／closed／
// sealed 這三個已經可能有票的狀態，隱藏會把 EncryptedBallot（voterId↔密文暫存）一併清空，
// 還原只救得回場次本身，救不回票——所以這三態走與 RedoElectionButton 相同的超級管理員＋
// 理由閘門，真正的授權檢查在伺服器（hideElection，見 [id]/actions.ts）。
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button, ConfirmDialog, Textarea } from "tpass-ui";
import { hideElection } from "@/app/admin/elections/[id]/actions";

const REQUIRES_SUPERADMIN_REASON = new Set(["voting", "closed", "sealed"]);

export function HideElectionButton({
  electionId,
  title,
  status,
  ballotCount,
  isSuperAdmin,
}: {
  electionId: string;
  title: string;
  status: string;
  ballotCount: number;
  isSuperAdmin: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");

  const needsReason = REQUIRES_SUPERADMIN_REASON.has(status);
  const showReasonInput = needsReason && isSuperAdmin;

  function runAction() {
    setError(null);
    startTransition(async () => {
      // 成功時 hideElection 直接 redirect("/admin")（丟出 NEXT_REDIRECT，由 Next 接手導頁），
      // 這裡只處理失敗回傳的 {ok:false,error}。
      const result = await hideElection(electionId, reason);
      if (!result.ok) {
        setConfirmOpen(false);
        setError(result.error);
      }
    });
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" /> {pending ? "處理中…" : "刪除此投票"}
      </Button>
      {error && <p role="alert" className="font-mono text-xs font-bold text-destructive">{error}</p>}
      <ConfirmDialog
        open={confirmOpen}
        title="確定要刪除此投票嗎？"
        description={
          <div className="flex flex-col gap-3 whitespace-pre-wrap">
            <p>
              {`確定要刪除「${title}」嗎？這是軟刪除：候選人／名冊／公告完全保留、隨時可還原，但會從首頁與所有列表消失。`}
            </p>
            {ballotCount > 0 && (
              <p className="font-bold text-destructive">
                本場已有 {ballotCount} 張票，刪除會把票匭暫存一併清空且無法還原——場次本身可以還原，
                但票不會跟著回來。
              </p>
            )}
            {showReasonInput && (
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="刪除理由（必填，會記錄於稽核紀錄）"
              />
            )}
          </div>
        }
        confirmLabel={pending ? "處理中…" : "確定刪除"}
        pending={pending}
        onConfirm={runAction}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

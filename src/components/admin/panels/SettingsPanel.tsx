"use client";
// ①設定面板：基本資料（檢視／編輯切換）＋開票金鑰（未產生時）＋選舉人名冊匯入與清單。
// 全部重用既有元件與 action，這裡只做版面組裝與 view/edit 切換狀態。
import { useState } from "react";
import { Pencil, Users } from "lucide-react";
import { Badge, Button } from "tpass-ui";
import { ElectionForm, type ElectionFormInitial } from "@/components/admin/ElectionForm";
import { KeyGenPanel } from "@/components/admin/KeyGenPanel";
import { RosterImportForm } from "@/components/admin/RosterImportForm";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { RedoElectionButton } from "@/components/admin/RedoElectionButton";
import { updateElection } from "@/app/admin/elections/[id]/edit/actions";
import { removeVoter } from "@/app/admin/elections/[id]/roster/actions";
import { formatDateTime } from "@/components/public/shared";

interface VoterRow {
  id: string;
  email: string;
  name: string | null;
  hasVoted: boolean;
}

function fmt(d: Date | null): string {
  return d ? formatDateTime(d) : "未設定";
}

export function SettingsPanel({
  electionId,
  slug,
  hasKey,
  keyShares,
  locked,
  initial,
  offices,
  voters,
  status,
  isSuperAdmin,
}: {
  electionId: string;
  slug: string;
  hasKey: boolean;
  keyShares: number;
  locked: boolean;
  initial: ElectionFormInitial;
  offices: { id: string; title: string }[];
  voters: VoterRow[];
  status: string;
  isSuperAdmin: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const rosterCount = voters.length;
  // castBallot 在同一交易裡設 hasVoted 並插入密文、且一人只能投一次，所以已投票的
  // voter 數 ＝ 票匭裡的密文數（彌封前）。D14-1「作廢並重辦」的確認對話框要標出這個
  // 數字，不必另外查 EncryptedBallot——而且彌封後票匭是空的，查它反而會得到 0。
  const votedCount = voters.filter((v) => v.hasVoted).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="font-extrabold">基本資料</h3>
          {!locked && !editing && (
            <Button type="button" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> 編輯
            </Button>
          )}
        </div>

        {locked ? (
          <p className="text-sm font-medium text-muted-foreground">
            投票已開始，選舉基本資料已鎖定，不可再修改。如需調整名額或期程，請建立新的選舉場次。
          </p>
        ) : editing ? (
          <ElectionForm
            mode="edit"
            action={updateElection.bind(null, electionId)}
            initial={initial}
            offices={offices}
            onSuccess={() => setEditing(false)}
          />
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <Row label="選舉名稱" value={initial.title ?? ""} />
            <Row label="slug" value={`/e/${slug}`} mono />
            <Row label="名額 / 可選人數" value={`${initial.seats} / ${initial.maxChoices}`} mono />
            <Row label="候選人登記期間" value={`${fmt(initial.registrationStartsAt ?? null)} ～ ${fmt(initial.registrationEndsAt ?? null)}`} />
            <Row label="投票期間" value={`${fmt(initial.votingStartsAt ?? null)} ～ ${fmt(initial.votingEndsAt ?? null)}`} />
          </dl>
        )}
      </div>

      {!hasKey && <KeyGenPanel electionId={electionId} slug={slug} />}
      {hasKey && (
        <div className="flex flex-col gap-2 rounded-xl border-2 border-foreground bg-tone-green-bg p-3 text-sm text-tone-green-text">
          <p className="flex items-center gap-2 font-bold">
            <Badge className="bg-card">開票金鑰</Badge> 已產生開票公鑰，私鑰只在選委手上的金鑰檔中。
          </p>
          <p className="text-xs font-bold">開票金鑰分持：{keyShares} 份</p>
          <div className="flex items-center gap-2 border-t-2 border-dashed border-tone-green-text/30 pt-2">
            <p className="text-xs font-medium">金鑰檔打不開或確定遺失，這場永遠無法開票時：</p>
            <RedoElectionButton
              electionId={electionId}
              status={status}
              ballotCount={votedCount}
              isSuperAdmin={isSuperAdmin}
            />
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="flex items-center gap-2 font-extrabold">
            <Users className="h-4 w-4" /> 選舉人名冊
          </h3>
          <span className="font-mono text-xs text-muted-foreground">
            {votedCount}/{rosterCount} 已投票
          </span>
        </div>
        <p className="mb-2 text-sm font-medium text-muted-foreground">
          每行一個 email，可用逗號加姓名：<span className="font-mono">email,姓名</span>
          。重複 email 會更新姓名，不會重複建立。
        </p>
        <RosterImportForm electionId={electionId} />

        {locked && (
          <p className="mt-3 text-sm font-medium text-muted-foreground">投票已開始，名冊只能新增，不能刪除既有條目。</p>
        )}

        <div className="mt-3 flex flex-col gap-2 max-h-80 overflow-y-auto">
          {voters.map((v) => (
            <div
              key={v.id}
              className="flex items-center justify-between gap-3 rounded-xl border-2 border-foreground bg-card p-2.5"
            >
              <div className="min-w-0">
                <p className="font-bold text-sm truncate">{v.name ?? v.email}</p>
                {v.name && <p className="font-mono text-[11px] text-muted-foreground truncate">{v.email}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {v.hasVoted ? (
                  <Badge className="bg-tone-green-badge text-tone-green-text">已投票</Badge>
                ) : (
                  <Badge className="bg-card">尚未投票</Badge>
                )}
                {!locked && (
                  <ConfirmActionButton
                    action={removeVoter.bind(null, electionId, v.id)}
                    label="移除"
                    variant="destructive"
                    size="sm"
                    confirmMessage={`確定要把 ${v.email} 從名冊移除嗎？`}
                  />
                )}
              </div>
            </div>
          ))}
          {voters.length === 0 && <p className="text-sm font-medium text-muted-foreground">尚未匯入任何選舉人。</p>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border-2 border-foreground/15 p-2.5">
      <dt className="font-mono text-[11px] font-bold text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono font-bold" : "mt-0.5 font-bold"}>{value}</dd>
    </div>
  );
}

"use client";
// ①連署面板（罷免鏈專屬）：罷免對象／事由／連署進度＋具名連署人清單／開票金鑰／
// 選委操作（成立、駁回）。成立與駁回都只在 status==="petition" 時可操作，狀態推進後
// （established 及以後）本面板仍可展開回顧數字，但操作按鈕收起，避免對已成立的案子誤按。
import { CheckCircle2, XCircle, Users2 } from "lucide-react";
import { Badge, cn } from "@/components/ui/primitives";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { KeyGenPanel } from "@/components/admin/KeyGenPanel";
import { Markdown } from "@/components/public/Markdown";
import { establishRecall, rejectRecall } from "@/app/admin/elections/[id]/recall/actions";

interface CandidateMember {
  name: string;
  email: string;
  grade?: string;
}

interface SignatureRow {
  email: string;
  name: string | null;
  createdAt: Date;
}

export function RecallPetitionPanel({
  electionId,
  slug,
  status,
  hasKey,
  targetMembers,
  reason,
  count,
  threshold,
  signatures,
}: {
  electionId: string;
  slug: string;
  status: string;
  hasKey: boolean;
  targetMembers: unknown;
  reason: string;
  count: number;
  threshold: number;
  signatures: SignatureRow[];
}) {
  const members = Array.isArray(targetMembers) ? (targetMembers as CandidateMember[]) : [];
  const passed = count >= threshold;
  const pct = threshold > 0 ? Math.min(100, Math.round((count / threshold) * 100)) : 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-extrabold mb-1">罷免對象</h3>
        <ul className="flex flex-col gap-0.5">
          {members.map((m, i) => (
            <li key={i} className="text-sm font-medium">
              {m.name}
              {m.grade && <span className="text-muted-foreground"> · {m.grade}</span>}
              <span className="font-mono text-[11px] text-muted-foreground"> · {m.email}</span>
            </li>
          ))}
          {members.length === 0 && <li className="text-sm text-muted-foreground">（無罷免對象資料）</li>}
        </ul>
      </div>

      <div>
        <h3 className="font-extrabold mb-1">罷免事由</h3>
        <div className="rounded-xl border-2 border-foreground/15 p-3 text-sm">
          <Markdown text={reason || "（未填寫）"} />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="flex items-center gap-2 font-extrabold">
            <Users2 className="h-4 w-4" /> 連署進度
          </h3>
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
            className={cn("h-full transition-all duration-300", passed ? "bg-tone-green-badge" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div>
        <h3 className="font-extrabold mb-2">連署人清單（{signatures.length}）</h3>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {signatures.map((s) => (
            <div
              key={s.email}
              className="flex items-center justify-between gap-3 rounded-xl border-2 border-foreground bg-card p-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{s.name ?? s.email}</p>
                {s.name && <p className="truncate font-mono text-[11px] text-muted-foreground">{s.email}</p>}
              </div>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {s.createdAt.toLocaleString("zh-TW")}
              </span>
            </div>
          ))}
          {signatures.length === 0 && <p className="text-sm font-medium text-muted-foreground">尚無連署。</p>}
        </div>
      </div>

      {!hasKey && <KeyGenPanel electionId={electionId} slug={slug} />}
      {hasKey && (
        <div className="flex items-center gap-2 rounded-xl border-2 border-foreground bg-tone-green-bg p-3 font-bold text-sm text-tone-green-text">
          <Badge className="bg-card">開票金鑰</Badge> 已產生開票公鑰，私鑰只在選委手上的金鑰檔中。
        </div>
      )}

      {status === "petition" && (
        <div className="flex flex-wrap gap-2 border-t-2 border-dashed border-foreground/30 pt-4">
          <ConfirmActionButton
            action={establishRecall.bind(null, electionId)}
            label="成立罷免案（推進到已成立）"
            variant="primary"
            disabled={!passed}
            confirmMessage={`確定要將本罷免案推進到「已成立」嗎？目前連署數 ${count}／門檻 ${threshold}。狀態機只能單向前進，無法回頭。`}
          />
          <ConfirmActionButton
            action={rejectRecall.bind(null, electionId, undefined)}
            label="駁回本罷免案"
            variant="destructive"
            confirmMessage="確定要駁回本罷免案嗎？這是軟刪除，資料完全保留但會從列表消失（可還原）。"
          />
        </div>
      )}
    </div>
  );
}

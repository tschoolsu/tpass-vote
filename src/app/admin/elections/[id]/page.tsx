import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Users, UserCheck, Megaphone, Lock, CheckCircle2, XCircle, ArrowUpRight } from "lucide-react";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { Badge, Card } from "@/components/ui/primitives";
import { STATUS_META, NEXT_STATUS, type ElectionStatus } from "@/components/admin/status";
import { ELECTION_KIND_LABEL, type ElectionKind } from "@/app/admin/elections/election-schema";
import { KeyGenPanel } from "@/components/admin/KeyGenPanel";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { advanceStatus } from "./actions";
import { sealElection } from "./tally/actions";

function fmt(d: Date | null): string {
  return d ? d.toLocaleString("zh-TW") : "未設定";
}

function shiftDays(d: Date | null, days: number): Date | null {
  return d ? new Date(d.getTime() + days * 86400000) : null;
}

export default async function ElectionOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}`);

  const election = await prisma.election.findUnique({
    where: { id },
    include: {
      candidates: { select: { id: true, status: true } },
      voters: { select: { votedAt: true } },
    },
  });
  if (!election) notFound();

  const status = election.status as ElectionStatus;
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  const next = NEXT_STATUS[status];
  const approvedCount = election.candidates.filter((c) => c.status === "approved").length;
  const rosterCount = election.voters.length;
  const votedCount = election.voters.filter((v) => v.votedAt !== null).length;
  const turnoutPct = rosterCount > 0 ? Math.round((votedCount / rosterCount) * 1000) / 10 : null;
  const hasKey = election.tallyPublicKeyJwk !== null;

  const votingPrecheck = [
    { label: "已產生開票金鑰", ok: hasKey },
    { label: "至少 1 組核准候選人", ok: approvedCount > 0, detail: `目前 ${approvedCount} 組` },
    { label: "已上傳選舉人名冊", ok: rosterCount > 0, detail: `目前 ${rosterCount} 人` },
  ];
  const votingBlocked = next === "voting" && votingPrecheck.some((c) => !c.ok);
  const previewBallotMode = approvedCount > election.seats ? "choose（超額，相對多數）" : "approval（同額，同意/不同意）";

  const firstDeadline = shiftDays(election.votingStartsAt, -30);
  const secondDeadline = shiftDays(election.votingStartsAt, -14);
  const resultDeadline = shiftDays(election.sealedAt ?? election.votingEndsAt, 7);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h1 className="font-extrabold text-2xl tracking-tight">{election.title}</h1>
          <Badge className={meta.badgeClass}>{meta.label}</Badge>
          <Badge className="bg-card">{ELECTION_KIND_LABEL[election.kind as ElectionKind] ?? election.kind}</Badge>
          <Link
            href={`/admin/elections/${election.id}/edit`}
            className="inline-flex items-center gap-1 rounded-md border-2 border-foreground bg-card px-2 py-0.5 font-mono text-[11px] font-bold shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
          >
            <Pencil className="h-3 w-3" /> 編輯
          </Link>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          /e/{election.slug} · 名額 {election.seats} · 可選 {election.maxChoices}
          {rosterCount > 0 && (
            <>
              {" "}
              · 投票率 {turnoutPct}%（{votedCount}/{rosterCount}）
            </>
          )}
        </p>
      </div>

      {!hasKey && <KeyGenPanel electionId={election.id} slug={election.slug} />}

      <Card>
        <h2 className="font-extrabold mb-3">狀態機</h2>
        <div className="flex flex-wrap items-center gap-2 mb-3 font-mono text-xs font-bold">
          {(["draft", "registration", "campaigning", "voting", "closed", "sealed", "published"] as const).map(
            (s, i, arr) => (
              <span key={s} className="flex items-center gap-2">
                <span className={s === status ? "text-foreground" : "text-muted-foreground/50"}>
                  {STATUS_META[s].label}
                </span>
                {i < arr.length - 1 && <span className="text-muted-foreground/40">→</span>}
              </span>
            ),
          )}
        </div>

        {next && (
          <div className="flex flex-col gap-2">
            {next === "voting" && (
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
                <li className="text-xs font-mono text-muted-foreground">
                  預覽開票模式：{previewBallotMode}
                </li>
              </ul>
            )}
            <div>
              <ConfirmActionButton
                action={advanceStatus.bind(null, election.id)}
                label={`推進到「${STATUS_META[next].label}」`}
                variant="primary"
                disabled={votingBlocked}
                confirmMessage={`確定要把狀態從「${meta.label}」推進到「${STATUS_META[next].label}」嗎？狀態機只能單向前進，無法回頭。`}
              />
            </div>
          </div>
        )}

        {status === "closed" && (
          <div className="mt-2">
            <p className="mb-2 text-sm font-medium text-muted-foreground">
              彌封＝去識別＋洗牌後鎖定票匭快照，此後任何人（包含選委）都無法再變更票匭內容，只能憑金鑰在本地開票。
            </p>
            <ConfirmActionButton
              action={sealElection.bind(null, election.id)}
              label={
                <>
                  <Lock className="h-4 w-4" /> 彌封票匭
                </>
              }
              variant="destructive"
              confirmMessage="彌封後票匭無法再變更，確定要彌封嗎？"
            />
          </div>
        )}

        {status === "sealed" && (
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            已彌封，請到「開票」頁面用金鑰檔在瀏覽器本地解密計票，再到「公告」頁面發布結果公告以完成公告流程。
          </p>
        )}
        {status === "published" && (
          <p className="mt-2 text-sm font-medium text-muted-foreground">結果已公告，本場選舉流程結束。</p>
        )}
      </Card>

      <Card>
        <h2 className="font-extrabold mb-3">法定期限提示（僅提示，不強制）</h2>
        <ul className="flex flex-col gap-1 text-sm font-medium text-muted-foreground">
          <li>公告一（投票日前 30 日）建議發布時限：{fmt(firstDeadline)}</li>
          <li>公告二（投票日前 14 日）建議發布時限：{fmt(secondDeadline)}</li>
          <li>結果公告（開票後 7 日內）建議發布時限：{fmt(resultDeadline)}</li>
        </ul>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <QuickLink
          href={`/admin/elections/${election.id}/roster`}
          icon={Users}
          title="選舉人名冊"
          desc={`${rosterCount} 人已匯入`}
        />
        <QuickLink
          href={`/admin/elections/${election.id}/candidates`}
          icon={UserCheck}
          title="候選人審核"
          desc={`${approvedCount} 組已核准 / 共 ${election.candidates.length} 組`}
        />
        <QuickLink
          href={`/admin/elections/${election.id}/announcements`}
          icon={Megaphone}
          title="公告管理"
          desc="公告一 / 公告二 / 結果公告"
        />
        <QuickLink
          href={`/admin/elections/${election.id}/tally`}
          icon={Lock}
          title="開票"
          desc={status === "sealed" || status === "published" ? "可進行開票" : "需先彌封票匭"}
          disabled={status !== "sealed" && status !== "published"}
        />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  desc,
  disabled,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border-2 border-dashed border-foreground/30 p-4 opacity-60">
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-bold truncate">{title}</p>
            <p className="text-xs text-muted-foreground truncate">{desc}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 rounded-2xl border-2 border-foreground bg-card p-4 shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)]"
    >
      <div className="flex items-center gap-3 min-w-0">
        <Icon className="h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <p className="font-bold truncate">{title}</p>
          <p className="text-xs text-muted-foreground truncate">{desc}</p>
        </div>
      </div>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </Link>
  );
}

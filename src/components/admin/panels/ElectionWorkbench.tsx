"use client";
// 單頁線性工作台：標題／進度列／當前階段卡／公告區塊（貫穿全程）／多階段收合面板。
// 截止(closed)＋開票(sealed) 在畫面上合併成同一階段（"closing"，見 status.ts 的 UiStage），
// 純呈現層合併，底層 status 仍是獨立的 closed/sealed 兩個值，不動狀態機。
// 一般選舉走六步（draft→registration→campaigning→voting→closing→published）；
// 罷免案（kind="recall"）走五步（petition→established→voting→closing→published），
// 用 isRecall 分流 stages/labels/steps，voting 之後兩條鏈完全共用同一批既有 panel。
// 所有資料由 page.tsx 一次撈好當 props 傳入；這裡只做版面組裝與 UI 狀態，
// mutation 一律呼叫既有 server action（各 panel 自己 import，這裡只 bind 需要 electionId 的
// 狀態機按鈕：advanceStatus／sealElection）。
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Settings2,
  UserCheck,
  Megaphone as MegaphoneIcon,
  Lock,
  KeyRound,
  Trash2,
  FileSignature,
  Gavel,
  History,
} from "lucide-react";
import { Badge, Button, Textarea } from "tpass-ui";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import {
  STATUS_META,
  LOCKED_STATUSES,
  UI_STAGES,
  UI_STAGE_LABEL,
  RECALL_UI_STAGES,
  RECALL_UI_STAGE_LABEL,
  RECALL_KIND_META,
  LINEAGE_LABEL,
  toUiStage,
  nextStatus,
  type ElectionStatus,
  type UiStage,
} from "@/components/admin/status";
import { ELECTION_KIND_LABEL, type ElectionKind } from "@/app/admin/elections/election-schema";
import { formatDateTime, describeRemaining } from "@/components/public/shared";
import { advanceStatus, hideElection, restoreElection } from "@/app/admin/elections/[id]/actions";
import { sealElection } from "@/app/admin/elections/[id]/tally/actions";
import { StageProgress } from "@/components/admin/panels/StageProgress";
import { CurrentStageCard } from "@/components/admin/panels/CurrentStageCard";
import { AnnouncementsSection, type AnnouncementRow } from "@/components/admin/panels/AnnouncementsSection";
import {
  WorkbenchAccordion,
  type StepPanelDef,
  type WorkbenchAccordionHandle,
} from "@/components/admin/panels/WorkbenchAccordion";
import { SettingsPanel } from "@/components/admin/panels/SettingsPanel";
import { RegistrationPanel } from "@/components/admin/panels/RegistrationPanel";
import { CampaignVotingPanel } from "@/components/admin/panels/CampaignVotingPanel";
import { ClosingTallyPanel } from "@/components/admin/panels/ClosingTallyPanel";
import { ResultsAnnouncementPanel } from "@/components/admin/panels/ResultsAnnouncementPanel";
import { RecallPetitionPanel } from "@/components/admin/panels/RecallPetitionPanel";
import { RecallEstablishedPanel } from "@/components/admin/panels/RecallEstablishedPanel";

interface CandidateData {
  id: string;
  number: number | null;
  status: string;
  platform: string;
  members: unknown;
  reviewNote: string | null;
  createdBy: string;
  attachments: unknown;
}

interface VoterData {
  id: string;
  email: string;
  name: string | null;
  votedAt: Date | null;
}

interface ElectionData {
  id: string;
  slug: string;
  title: string;
  kind: string;
  lineage: string | null;
  seats: number;
  maxChoices: number;
  status: string;
  ballotMode: string | null;
  registrationStartsAt: Date | null;
  registrationEndsAt: Date | null;
  votingStartsAt: Date | null;
  votingEndsAt: Date | null;
  tallyPublicKeyJwk: unknown;
  keyShares: number;
  sealedBox: unknown;
  sealedHash: string | null;
  sealedAt: Date | null;
  sealedBy: string | null;
  resultsJson: unknown;
  hiddenAt: Date | null;
  recallReason: string | null;
  recallDefense: string | null;
  recallLeadName: string | null;
  recallLeadEmail: string | null;
  officeId: string | null;
  candidates: CandidateData[];
  voters: VoterData[];
  announcements: AnnouncementRow[];
}

export interface RecallInfo {
  threshold: number;
  signatures: { email: string; name: string | null; createdAt: Date }[];
}

export function ElectionWorkbench({
  election,
  uploads,
  selfUrl,
  recallInfo,
  offices,
  isSuperAdmin,
}: {
  election: ElectionData;
  uploads: { id: string; filename: string }[];
  selfUrl: string;
  recallInfo: RecallInfo | null;
  offices: { id: string; title: string }[];
  // 只給「投票截止前強制關票」的理由輸入框判斷要不要顯示（D2-3／D12-1），
  // 不做別的授權判斷——一般管理員一律看不到這個入口，跟一般管理員按下方
  // 「推進到已截止」按鈕時伺服器回的錯誤訊息一致。
  isSuperAdmin: boolean;
}) {
  const status = election.status as ElectionStatus;
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  const isRecall = election.kind === "recall";
  const next = nextStatus(status, election.kind);
  const accordionRef = useRef<WorkbenchAccordionHandle>(null);
  const router = useRouter();
  const [forceReason, setForceReason] = useState("");
  const [forcePending, startForceTransition] = useTransition();
  const [forceError, setForceError] = useState<string | null>(null);

  // D2-3／D12-1 逃生門的送出：獨立於 CurrentStageCard 的「推進到已截止」按鈕（那顆一律
  // 不帶理由，超管沒填理由一樣會被伺服器擋下），只有 canForceClose 為真時才會被渲染出來。
  function handleForceClose() {
    setForceError(null);
    startForceTransition(async () => {
      const result = await advanceStatus(election.id, forceReason);
      if (!result.ok) {
        setForceError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const approvedCandidates = election.candidates.filter((c) => c.status === "approved");
  const rosterCount = election.voters.length;
  const votedCount = election.voters.filter((v) => v.votedAt !== null).length;
  const turnoutPct = rosterCount > 0 ? Math.round((votedCount / rosterCount) * 1000) / 10 : null;
  const hasKey = election.tallyPublicKeyJwk !== null;
  // 選舉基本資料／候選人審核在投票開始（voting 及之後）鎖定，判準集中在 lib/election-status。
  const registrationLocked = LOCKED_STATUSES.has(status);

  // 狀態機的 status 與時程（votingStartsAt）是兩套獨立真相：推進到 voting 只代表選委按了按鈕，
  // 不代表投票時間到了——選民端 vote/page.tsx 用同一套 castDecision 擋，這裡也要在前置檢查列出來，
  // 不要讓選委推了狀態卻以為選民已經能投票。
  const votingStartReached = !election.votingStartsAt || new Date() >= election.votingStartsAt;
  // D12-1：時程排錯或選委拖到太晚才按，導致整段投票期間已經過去——同一條規則在
  // actions.ts 的 advanceStatus 裡是真正的閘門，這裡只是把同一個判斷先顯示出來，
  // 讓選委在按下去之前就看得到「已過去」，不必等伺服器回錯誤訊息才知道。
  const votingWindowElapsed = !!election.votingEndsAt && new Date() >= election.votingEndsAt;
  const votingPrecheck = [
    { label: "已產生開票金鑰", ok: hasKey },
    isRecall
      ? { label: "罷免對象已設定", ok: approvedCandidates.length > 0 }
      : {
          label: "至少 1 組核准候選人",
          ok: approvedCandidates.length > 0,
          detail: `目前 ${approvedCandidates.length} 組`,
        },
    { label: "已上傳選舉人名冊", ok: rosterCount > 0, detail: `目前 ${rosterCount} 人` },
    {
      label: "投票開始時間已到",
      ok: votingStartReached,
      detail: votingStartReached
        ? undefined
        : `${formatDateTime(election.votingStartsAt)}（${describeRemaining(election.votingStartsAt, new Date())}）`,
    },
    {
      label: "整段投票期間尚未過去",
      ok: !votingWindowElapsed,
      detail: votingWindowElapsed ? `已於 ${formatDateTime(election.votingEndsAt)} 結束` : undefined,
    },
  ];
  const votingBlocked = next === "voting" && votingPrecheck.some((c) => !c.ok);
  // D2-3／D12-1 的逃生門：只有超級管理員、只有截止時間還沒到時才看得到——一般管理員按
  // 「推進到已截止」一樣會被伺服器擋下，錯誤訊息跟這裡不能用的原因一致。
  const canForceClose = isSuperAdmin && next === "closed" && !!election.votingEndsAt && new Date() < election.votingEndsAt;
  const previewBallotMode = isRecall
    ? "同意／不同意模式"
    : approvedCandidates.length > election.seats
      ? "多選模式（超額，相對多數）"
      : "同意／不同意模式（同額）";

  const resultAnnouncement = election.announcements.find((a) => a.legalTag === "result") ?? null;
  const resultsExist = election.resultsJson !== null;

  // 罷免鏈五步／一般鏈六步，順序＋標籤都不同（見 status.ts）。
  const uiStages = isRecall ? RECALL_UI_STAGES : UI_STAGES;
  const uiStageLabel = isRecall ? RECALL_UI_STAGE_LABEL : UI_STAGE_LABEL;

  // UI 顯示合併：截止(closed)＋開票(sealed) 在畫面上算同一階段（"closing"）。
  // 提交計票結果後（resultsExist）即使 status 仍是 sealed，也把「目前步驟」提前推進到
  // published，讓結果公告草稿一提交完立即解鎖可見——純呈現層判斷，不改狀態機／不改 status。
  const rawUiStage = toUiStage(status, election.kind);
  const currentUiStage: UiStage = rawUiStage === "closing" && resultsExist ? "published" : rawUiStage;

  const closingLabel = uiStageLabel.closing;
  const publishedLabel = uiStageLabel.published;

  const votingStep: StepPanelDef = {
    status: "voting",
    icon: KeyRound,
    title: isRecall ? "③投票" : "④投票",
    summary: rosterCount > 0 ? `投票率 ${turnoutPct}%（${votedCount}/${rosterCount}）` : "尚無名冊",
    content: (
      <CampaignVotingPanel
        registrationStartsAt={election.registrationStartsAt}
        registrationEndsAt={election.registrationEndsAt}
        votingStartsAt={election.votingStartsAt}
        votingEndsAt={election.votingEndsAt}
        rosterCount={rosterCount}
        votedCount={votedCount}
        turnoutPct={turnoutPct}
        status="voting"
        hideRegistration={isRecall}
      />
    ),
  };

  const closingStep: StepPanelDef = {
    status: "closing",
    icon: Lock,
    title: closingLabel,
    summary: resultsExist
      ? "已提交計票結果，待發布結果公告"
      : status === "sealed"
        ? "已彌封，待開票"
        : election.sealedAt
          ? "已彌封"
          : "投票已截止，待彌封",
    content: (
      <ClosingTallyPanel
        status={status}
        votingEndsAt={election.votingEndsAt}
        sealedAt={election.sealedAt}
        sealedBy={election.sealedBy}
        onSeal={(confirmSmallBox) => sealElection(election.id, confirmSmallBox)}
        resultsExist={resultsExist}
        tally={{
          electionId: election.id,
          slug: election.slug,
          status,
          ballotMode: election.ballotMode,
          sealedBox: election.sealedBox,
          sealedHash: election.sealedHash,
          keyShares: election.keyShares,
          resultsExist,
          seats: election.seats,
          maxChoices: election.maxChoices,
          rosterCount,
          approvedCandidates,
        }}
      />
    ),
  };

  const publishedStep: StepPanelDef = {
    status: "published",
    icon: MegaphoneIcon,
    title: publishedLabel,
    summary: resultAnnouncement?.publishedAt ? "結果公告已發布，選舉結案" : "待發布結果公告",
    content: (
      <ResultsAnnouncementPanel
        electionId={election.id}
        status={status}
        resultsExist={resultsExist}
        resultAnnouncement={resultAnnouncement}
      />
    ),
  };

  const steps: StepPanelDef[] = isRecall
    ? [
        {
          status: "petition",
          icon: FileSignature,
          title: uiStageLabel.petition,
          summary: recallInfo
            ? `連署 ${recallInfo.signatures.length}／門檻 ${recallInfo.threshold}`
            : "連署中",
          content: (
            <RecallPetitionPanel
              electionId={election.id}
              slug={election.slug}
              status={status}
              hasKey={hasKey}
              targetMembers={election.candidates[0]?.members ?? null}
              reason={election.recallReason ?? ""}
              leadName={election.recallLeadName}
              leadEmail={election.recallLeadEmail}
              count={recallInfo?.signatures.length ?? 0}
              threshold={recallInfo?.threshold ?? 0}
              signatures={recallInfo?.signatures ?? []}
            />
          ),
        },
        {
          status: "established",
          icon: Gavel,
          title: uiStageLabel.established,
          summary: election.recallDefense ? "答辯書已提交" : "尚未提交答辯書",
          content: (
            <RecallEstablishedPanel
              electionId={election.id}
              defense={election.recallDefense ?? ""}
              precheck={votingPrecheck}
              blocked={votingBlocked}
              onAdvance={advanceStatus.bind(null, election.id)}
            />
          ),
        },
        votingStep,
        closingStep,
        publishedStep,
      ]
    : [
        {
          status: "draft",
          icon: Settings2,
          title: "①設定",
          summary: hasKey ? "金鑰已產生" : "尚未產生開票金鑰",
          content: (
            <SettingsPanel
              electionId={election.id}
              slug={election.slug}
              hasKey={hasKey}
              locked={registrationLocked}
              initial={{
                title: election.title,
                slug: election.slug,
                kind: election.kind as ElectionKind,
                seats: election.seats,
                maxChoices: election.maxChoices,
                registrationStartsAt: election.registrationStartsAt,
                registrationEndsAt: election.registrationEndsAt,
                votingStartsAt: election.votingStartsAt,
                votingEndsAt: election.votingEndsAt,
                officeId: election.officeId,
              }}
              offices={offices}
              voters={election.voters}
            />
          ),
        },
        {
          status: "registration",
          icon: UserCheck,
          title: "②登記",
          summary: `${approvedCandidates.length} 組已核准 / 共 ${election.candidates.length} 組登記`,
          content: (
            <RegistrationPanel
              electionId={election.id}
              candidates={election.candidates}
              uploads={uploads}
              locked={registrationLocked}
            />
          ),
        },
        {
          status: "campaigning",
          icon: MegaphoneIcon,
          title: "③政見",
          summary: "政見發表中，發公告請至上方公告區塊",
          content: (
            <CampaignVotingPanel
              registrationStartsAt={election.registrationStartsAt}
              registrationEndsAt={election.registrationEndsAt}
              votingStartsAt={election.votingStartsAt}
              votingEndsAt={election.votingEndsAt}
              rosterCount={rosterCount}
              votedCount={votedCount}
              turnoutPct={turnoutPct}
              status="campaigning"
            />
          ),
        },
        votingStep,
        closingStep,
        publishedStep,
      ];

  const kindMeta = isRecall
    ? RECALL_KIND_META
    : { label: ELECTION_KIND_LABEL[election.kind as ElectionKind] ?? election.kind, badgeClass: "bg-card" };
  const lineageMeta = election.lineage ? LINEAGE_LABEL[election.lineage] : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h1 className="font-extrabold text-2xl tracking-tight">{election.title}</h1>
            <Badge className={meta.badgeClass}>{meta.label}</Badge>
            <Badge className={kindMeta.badgeClass}>{kindMeta.label}</Badge>
            {lineageMeta && <Badge className={lineageMeta.badgeClass}>{lineageMeta.label}</Badge>}
            {election.hiddenAt && (
              <Badge className="bg-destructive text-primary-foreground">已刪除（隱藏）</Badge>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            <Link href={`/e/${election.slug}`} className="hover:underline">
              /e/{election.slug}
            </Link>{" "}
            · 名額 {election.seats} · 可選 {election.maxChoices}
            {rosterCount > 0 && (
              <>
                {" "}
                · 投票率 {turnoutPct}%（{votedCount}/{rosterCount}）
              </>
            )}
          </p>
          <Link
            href={`/admin/elections/${election.id}/audit-log`}
            className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            <History className="h-3.5 w-3.5" /> 稽核紀錄
          </Link>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {election.hiddenAt ? (
            <ConfirmActionButton
              action={restoreElection.bind(null, election.id)}
              label="還原此投票"
              size="sm"
              confirmMessage={`確定要還原「${election.title}」嗎？還原後會重新出現在所有列表中。`}
            />
          ) : (
            <ConfirmActionButton
              action={hideElection.bind(null, election.id)}
              label={
                <>
                  <Trash2 className="h-3.5 w-3.5" /> 刪除此投票
                </>
              }
              // 軟刪除、可還原，不需要跟「現在該做什麼」搶視覺權重——降級為 ghost，
              // 破壞性語氣留給 ConfirmDialog 的確認文案去講。
              variant="ghost"
              size="sm"
              confirmMessage={`確定要刪除「${election.title}」嗎？\n\n這是軟刪除：資料完全保留、隨時可還原，但會從首頁與所有列表消失。`}
            />
          )}
        </div>
      </div>

      <StageProgress currentStage={currentUiStage} status={status} stages={uiStages} labels={uiStageLabel} />

      <CurrentStageCard
        status={status}
        next={next}
        votingPrecheck={votingPrecheck}
        votingBlocked={votingBlocked}
        previewBallotMode={previewBallotMode}
        resultsExist={resultsExist}
        onAdvance={advanceStatus.bind(null, election.id)}
        onGoTo={(target) => accordionRef.current?.openAndScrollTo(target)}
        closingLabel={closingLabel}
        publishedLabel={publishedLabel}
      />

      {canForceClose && (
        <div className="flex flex-col gap-2 rounded-md border-2 border-dashed border-destructive/60 p-4">
          <h3 className="font-extrabold text-sm">超級管理員：截止時間未到，強制關票</h3>
          <p className="text-xs text-muted-foreground">
            投票截止時間為 {formatDateTime(election.votingEndsAt)}，尚未到期。僅限重大事故（例如選情膠著、
            資安事件）使用，理由會寫進稽核紀錄且無法回頭。
          </p>
          <Textarea
            value={forceReason}
            onChange={(e) => setForceReason(e.target.value)}
            rows={2}
            maxLength={200}
            placeholder="強制關票的理由（必填，會記錄於稽核紀錄）"
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={forcePending || forceReason.trim().length === 0}
              onClick={handleForceClose}
            >
              {forcePending ? "處理中…" : "強制關票"}
            </Button>
            {forceError && <p role="alert" className="font-mono text-xs font-bold text-destructive">{forceError}</p>}
          </div>
        </div>
      )}

      <AnnouncementsSection
        electionId={election.id}
        slug={election.slug}
        selfUrl={selfUrl}
        announcements={election.announcements}
        votingStartsAt={election.votingStartsAt}
      />

      <WorkbenchAccordion ref={accordionRef} steps={steps} currentStatus={currentUiStage} stages={uiStages} />
    </div>
  );
}

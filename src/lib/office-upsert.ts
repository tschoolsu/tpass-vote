// 選舉「公告結果」時，把當選人落地到職務登記表（Office）。由 announcements/actions.ts 的
// publishAnnouncement 在 sealed→published 的同一交易內呼叫，故簽名收 tx（不自己開交易）。
//
// 職務識別靠 Election.officeId 明確關聯，不靠 title 猜：
// - election.officeId 有值（選委建選舉時挑了既有職務）→ 更新那筆（連任/補選＝同一職務換人）。
// - election.officeId 為 null（genesis）→ 每個當選組各建一筆職務，恰好一筆時回填 election.officeId，
//   讓日後改選/罷免補選精準命中。
// 罷免案（kind=recall）不建職務，而是「通過→目標職務轉從缺；否決→完全不動」。
import type { Prisma } from "@/generated/prisma/client";
import type { TallyResult } from "@/lib/tally";
import { recallPassed } from "@/lib/recall";

export const SYSTEM_EDITOR = "system:election-publish";

interface Member {
  name: string;
  email?: string;
  grade?: string;
}

export interface UpsertElectionInfo {
  id: string;
  kind: string;
  title: string;
  officeId: string | null;
  recallTargetOfficeId: string | null;
}

export interface UpsertCandidateInfo {
  id: string;
  number: number | null;
  members: unknown;
}

/** 當選組落地的職務名稱：第一組沿用選舉名稱，同場多當選組時第 2 組起加號次尾碼避免重名。 */
export function officeTitleForWinner(electionTitle: string, index: number, number: number | null): string {
  if (index === 0) return electionTitle;
  return `${electionTitle}（第${number ?? index + 1}號）`;
}

type DiffPair = [unknown, unknown];

/** 只保留有變動的欄位，值為 {from,to}，供編輯記錄時間軸重播。 */
export function buildDiff(fields: Record<string, DiffPair>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, [from, to]] of Object.entries(fields)) {
    if (JSON.stringify(from) !== JSON.stringify(to)) out[k] = { from, to };
  }
  return out;
}

function membersOf(c: UpsertCandidateInfo): Member[] {
  return Array.isArray(c.members) ? (c.members as Member[]) : [];
}

async function writeLog(
  tx: Prisma.TransactionClient,
  officeId: string,
  editorEmail: string,
  action: string,
  summary: string,
  diff: Record<string, { from: unknown; to: unknown }>,
): Promise<void> {
  await tx.officeEditLog.create({
    data: { officeId, editorEmail, action, summary, diff: diff as Prisma.InputJsonValue },
  });
}

async function updateOfficeHolder(
  tx: Prisma.TransactionClient,
  officeId: string,
  members: Member[],
  startedAt: Date,
  sourceElectionId: string,
  termValidCount: number,
  summary: string,
): Promise<void> {
  const prev = await tx.office.findUnique({ where: { id: officeId } });
  if (!prev) return;
  await tx.office.update({
    where: { id: officeId },
    data: {
      currentMembers: members as unknown as Prisma.InputJsonValue,
      isVacant: false,
      startedAt,
      sourceElectionId,
      termValidCount,
    },
  });
  const diff = buildDiff({
    currentMembers: [prev.currentMembers, members],
    isVacant: [prev.isVacant, false],
    startedAt: [prev.startedAt?.toISOString() ?? null, startedAt.toISOString()],
    sourceElectionId: [prev.sourceElectionId, sourceElectionId],
    termValidCount: [prev.termValidCount, termValidCount],
  });
  await writeLog(tx, officeId, SYSTEM_EDITOR, "update", summary, diff);
}

async function applyRecallOutcome(
  tx: Prisma.TransactionClient,
  election: UpsertElectionInfo,
  results: TallyResult,
): Promise<void> {
  if (!election.recallTargetOfficeId) return;
  const target = results.candidates[0];
  if (!target) return;
  if (!recallPassed(target.votes, target.disagree)) return; // 否決：不動職務、不重置就職時鐘
  const prev = await tx.office.findUnique({ where: { id: election.recallTargetOfficeId } });
  if (!prev || prev.isVacant) return;
  await tx.office.update({
    where: { id: election.recallTargetOfficeId },
    data: { isVacant: true, currentMembers: [], startedAt: null },
  });
  const diff = buildDiff({
    isVacant: [prev.isVacant, true],
    currentMembers: [prev.currentMembers, []],
    startedAt: [prev.startedAt?.toISOString() ?? null, null],
  });
  await writeLog(tx, election.recallTargetOfficeId, SYSTEM_EDITOR, "update", `罷免案「${election.title}」通過，職務轉為從缺`, diff);
}

export async function upsertOfficesForElection(
  tx: Prisma.TransactionClient,
  election: UpsertElectionInfo,
  results: TallyResult,
  candidates: UpsertCandidateInfo[],
): Promise<void> {
  if (election.kind === "recall") {
    await applyRecallOutcome(tx, election, results);
    return;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const elected = results.candidates.filter((c) => c.elected);
  if (elected.length === 0) return;
  const now = new Date();

  if (election.officeId) {
    // 選委已指定填哪個職務（單一職務選舉）：用第一個當選組更新它。
    const winner = byId.get(elected[0].candidateId);
    if (winner) {
      await updateOfficeHolder(
        tx,
        election.officeId,
        membersOf(winner),
        now,
        election.id,
        results.validCount,
        `選舉「${election.title}」公告結果，自動更新現任`,
      );
    }
    return;
  }

  // genesis：每個當選組各建一筆職務。
  const createdIds: string[] = [];
  for (let i = 0; i < elected.length; i++) {
    const winner = byId.get(elected[i].candidateId);
    if (!winner) continue;
    const title = officeTitleForWinner(election.title, i, winner.number);
    const members = membersOf(winner);
    const office = await tx.office.create({
      data: {
        title,
        currentMembers: members as unknown as Prisma.InputJsonValue,
        isVacant: false,
        startedAt: now,
        sourceElectionId: election.id,
        termValidCount: results.validCount,
      },
    });
    await writeLog(tx, office.id, SYSTEM_EDITOR, "create", `選舉「${election.title}」公告結果，自動建立職務並帶入現任`, {
      title: { from: null, to: title },
      currentMembers: { from: null, to: members },
      startedAt: { from: null, to: now.toISOString() },
      sourceElectionId: { from: null, to: election.id },
      termValidCount: { from: null, to: results.validCount },
    });
    createdIds.push(office.id);
  }
  // 恰好建一筆職務 → 回填 election.officeId，之後改選/補選精準命中同一筆。
  if (createdIds.length === 1) {
    await tx.election.update({ where: { id: election.id }, data: { officeId: createdIds[0] } });
  }
}

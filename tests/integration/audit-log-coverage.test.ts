// F-8：候選人審核／期程修改／彌封／重選／罷免相關動作的稽核留痕覆蓋率。
// 每個受檢動作走真正的 server action，斷言 ElectionAuditLog 確實多一筆、且 action 名稱正確。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, VOTER_A, VOTER_B, as } from "../helpers/session";
import { makeElection, generateKeys, importVoters, advanceTo, registerAs, seal, toLocalInput } from "../helpers/flow";
import { updateElection } from "@/app/admin/elections/[id]/edit/actions";
import { approveCandidate, rejectCandidate, sendBackForFix } from "@/app/admin/elections/[id]/candidates/actions";
import { createRunoff, createByElection } from "@/app/admin/elections/[id]/actions";
import { establishRecall, rejectRecall, saveRecallDefense } from "@/app/admin/elections/[id]/recall/actions";
import { initiateRecall } from "@/app/offices/[id]/recall/actions";
import { recallThreshold } from "@/lib/recall";

const CANDIDATE_1 = { email: "d13-c1@test.local", name: "候選人一" };
const CANDIDATE_2 = { email: "d13-c2@test.local", name: "候選人二" };
const CANDIDATE_3 = { email: "d13-c3@test.local", name: "候選人三" };
const CANDIDATE_4 = { email: "d13-c4@test.local", name: "候選人四" };

async function countLogs(electionId: string): Promise<number> {
  return prisma.electionAuditLog.count({ where: { electionId } });
}

/** 斷言某場選舉的 ElectionAuditLog 剛好多了一筆，且最新一筆 action 對得上。回傳新的總數，方便串接下一步。 */
async function expectAppended(electionId: string, before: number, action: string): Promise<number> {
  const after = await countLogs(electionId);
  expect(after, `${action} 應該新增一筆 ElectionAuditLog`).toBe(before + 1);
  const last = await prisma.electionAuditLog.findFirst({
    where: { electionId },
    orderBy: { createdAt: "desc" },
  });
  expect(last?.action, `最新一筆 ElectionAuditLog 的 action 應為 ${action}`).toBe(action);
  return after;
}

describe("D13/F-8：候選人審核、期程修改、彌封、重選與罷免動作的稽核留痕", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("updateElection 修改期程留一筆 update_election，diff 帶改前改後值", async () => {
    const created = await makeElection({ slug: "d13-main", seats: 2, maxChoices: 2 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;
    const before = await countLogs(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const form = new FormData();
    form.set("title", "改過的標題");
    form.set("slug", election.slug);
    form.set("kind", election.kind);
    form.set("seats", String(election.seats));
    form.set("maxChoices", String(election.maxChoices));
    form.set("votingStartsAt", toLocalInput(election.votingStartsAt!));
    form.set("votingEndsAt", toLocalInput(election.votingEndsAt!));

    const r = await as(ADMIN, () => updateElection(electionId, null, form));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    await expectAppended(electionId, before, "update_election");
    const log = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "update_election" },
      orderBy: { createdAt: "desc" },
    });
    const diff = log!.diff as Record<string, { from: string; to: string }>;
    expect(diff.title).toEqual({ from: election.title, to: "改過的標題" });
    // 沒改動的欄位不該出現在 diff 裡。
    expect(diff.seats).toBeUndefined();
  });

  it("approveCandidate / rejectCandidate / sendBackForFix 各留一筆，candidateId 與 reviewNote 進 diff", async () => {
    const created = await makeElection({ slug: "d13-candidates", seats: 2, maxChoices: 2 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;

    await generateKeys(electionId, "d13-candidates");
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");

    for (const c of [CANDIDATE_1, CANDIDATE_2, CANDIDATE_3, CANDIDATE_4]) {
      const reg = await registerAs("d13-candidates", electionId, c);
      expect(reg.ok, JSON.stringify(reg)).toBe(true);
    }

    const candidates = await prisma.candidate.findMany({
      where: { electionId },
      orderBy: { createdAt: "asc" },
    });
    const [c1, c2, c3, c4] = candidates;

    let before = await countLogs(electionId);
    const approved1 = await as(ADMIN, () => approveCandidate(electionId, c1.id));
    expect(approved1.ok, JSON.stringify(approved1)).toBe(true);
    before = await expectAppended(electionId, before, "approve_candidate");

    const rejected = await as(ADMIN, () => rejectCandidate(electionId, c2.id, "資格不符"));
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    before = await expectAppended(electionId, before, "reject_candidate");

    const sentBack = await as(ADMIN, () => sendBackForFix(electionId, c3.id, "缺附件"));
    expect(sentBack.ok, JSON.stringify(sentBack)).toBe(true);
    before = await expectAppended(electionId, before, "send_back_candidate");

    const approved4 = await as(ADMIN, () => approveCandidate(electionId, c4.id));
    expect(approved4.ok, JSON.stringify(approved4)).toBe(true);
    await expectAppended(electionId, before, "approve_candidate");

    const rejectLog = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "reject_candidate" },
    });
    expect((rejectLog!.diff as { candidateId: string; reviewNote: string }).candidateId).toBe(c2.id);
    expect((rejectLog!.diff as { candidateId: string; reviewNote: string }).reviewNote).toBe("資格不符");

    const sendBackLog = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "send_back_candidate" },
    });
    expect((sendBackLog!.diff as { candidateId: string; reviewNote: string }).candidateId).toBe(c3.id);
    expect((sendBackLog!.diff as { candidateId: string; reviewNote: string }).reviewNote).toBe("缺附件");

    // 後續彌封／重選／補選都要用到「已核准候選人」，接著把這場推進到 voting → closed → sealed。
    await advanceTo(electionId, "voting");
    await advanceTo(electionId, "closed");

    let sealBefore = await countLogs(electionId);
    await seal(electionId);
    sealBefore = await expectAppended(electionId, sealBefore, "seal_election");
    const sealLog = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "seal_election" },
    });
    expect((sealLog!.diff as { ballotCount: number }).ballotCount).toBe(0);

    const approvedCandidates = await prisma.candidate.findMany({
      where: { electionId, status: "approved" },
      orderBy: { number: "asc" },
    });
    expect(approvedCandidates.length).toBe(2);
    const tiedIds = approvedCandidates.map((c) => c.id);

    const runoff = await as(ADMIN, () => createRunoff(electionId, tiedIds));
    expect(runoff.ok, JSON.stringify(runoff)).toBe(true);
    sealBefore = await expectAppended(electionId, sealBefore, "create_runoff");

    const byElection = await as(ADMIN, () => createByElection(electionId));
    expect(byElection.ok, JSON.stringify(byElection)).toBe(true);
    await expectAppended(electionId, sealBefore, "create_by_election");
  }, 60_000);

  it("initiateRecall / establishRecall / rejectRecall / saveRecallDefense 各留一筆", async () => {
    const officeA = await prisma.office.create({
      data: {
        title: "測試職務甲",
        currentMembers: [{ name: "在任者甲", email: "incumbent-a@test.local", grade: "三年級" }],
        isVacant: false,
        startedAt: new Date(Date.now() - 100 * 24 * 3_600_000), // 100 天前，早過 2 個月門檻
        termValidCount: 5,
      },
    });
    const officeB = await prisma.office.create({
      data: {
        title: "測試職務乙",
        currentMembers: [{ name: "在任者乙", email: "incumbent-b@test.local", grade: "三年級" }],
        isVacant: false,
        startedAt: new Date(Date.now() - 100 * 24 * 3_600_000),
        termValidCount: 5,
      },
    });

    const initiatedA = await as(VOTER_A, () => initiateRecall(officeA.id, "測試罷免事由甲"));
    expect(initiatedA.ok, JSON.stringify(initiatedA)).toBe(true);
    if (!initiatedA.ok) throw new Error("unreachable");
    const recallA = await prisma.election.findUniqueOrThrow({ where: { slug: initiatedA.slug } });
    await expectAppended(recallA.id, 0, "initiate_recall");

    const initiatedB = await as(VOTER_B, () => initiateRecall(officeB.id, "測試罷免事由乙"));
    expect(initiatedB.ok, JSON.stringify(initiatedB)).toBe(true);
    if (!initiatedB.ok) throw new Error("unreachable");
    const recallB = await prisma.election.findUniqueOrThrow({ where: { slug: initiatedB.slug } });
    await expectAppended(recallB.id, 0, "initiate_recall");

    // 湊連署門檻：termValidCount=5 → threshold=ceil(5*2/5)=2；領銜人已算 1 筆，補 1 筆。
    const threshold = recallThreshold(5);
    expect(threshold).toBe(2);
    await prisma.recallSignature.create({ data: { electionId: recallA.id, signerEmail: VOTER_B.email } });

    let beforeA = await countLogs(recallA.id);
    const established = await as(ADMIN, () => establishRecall(recallA.id));
    expect(established.ok, JSON.stringify(established)).toBe(true);
    beforeA = await expectAppended(recallA.id, beforeA, "establish_recall");

    const defenseResult = await as(ADMIN, () => saveRecallDefense(recallA.id, "答辯內容"));
    expect(defenseResult.ok, JSON.stringify(defenseResult)).toBe(true);
    await expectAppended(recallA.id, beforeA, "save_recall_defense");

    const beforeB = await countLogs(recallB.id);
    const rejected = await as(ADMIN, () => rejectRecall(recallB.id, "連署不足"));
    expect(rejected.ok, JSON.stringify(rejected)).toBe(true);
    await expectAppended(recallB.id, beforeB, "reject_recall");

    const rejectLog = await prisma.electionAuditLog.findFirst({
      where: { electionId: recallB.id, action: "reject_recall" },
    });
    expect((rejectLog!.diff as { reason: string }).reason).toBe("連署不足");
  });
});

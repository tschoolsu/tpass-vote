// D2-5／D11-2／D3-2（第二輪）：hiddenAt 不參與狀態機閘門。redoElection／hideElection
// 只把來源場次打上 hiddenAt（投票端／公開端都用 hiddenAt:null 過濾），但 advanceStatus、
// sealElection、submitResults、publishAnnouncement 四支管理動作只看 status，不看 hiddenAt——
// 已作廢的場次仍可被彌封／提交結果／發布公告，把當選人寫進 Office，公開端卻永遠看不到
// 這場選舉的存在。另外 redoElection／hideElection 只設 hiddenAt，EncryptedBallot
// （voterId↔密文）一列都不刪，永久留在 DB 裡。
import { describe, it, expect } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, MODERATOR, as } from "../helpers/session";
import { captureRedirect } from "../helpers/redirect";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
  seal,
  tallyAndSubmit,
  voteAs,
} from "../helpers/flow";
import { redoElection, hideElection } from "@/app/admin/elections/[id]/actions";
import { submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { publishAnnouncement } from "@/app/admin/elections/[id]/announcements/actions";
import type { TestIdentity } from "../helpers/jwks";

describe("已作廢／隱藏的場次不能再彌封、提交、公告", () => {
  it("redoElection 之後，舊場次不能重新提交結果或發布結果公告，Office 不落地", async () => {
    await resetDb();
    const slug = "hidden-gate-a";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug, 1);
    const VOTER: TestIdentity = { email: "voter-a@test.local", name: "投票人" };
    const CAND: TestIdentity = { email: "cand-a@test.local", name: "候選人" };
    await importVoters(electionId, [VOTER, CAND]);
    await advanceTo(electionId, "registration");
    const reg = await registerAs(slug, electionId, CAND);
    if (!reg.ok) throw new Error(`候選人登記失敗：${reg.error}`);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId } });
    const cast = await voteAs(slug, electionId, VOTER, publicKeyJwk, {
      type: "approval",
      approvals: { [candidate.id]: true },
    });
    expect(cast.ok, cast.ok ? "" : cast.error).toBe(true);

    await advanceTo(electionId, "closed");
    await seal(electionId);

    const { results, disclosures, submitted } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);

    const officeCountBefore = await prisma.office.count();

    // 金鑰遺失以外的理由也走同一支 action：這裡只是要讓來源場次被打上 hiddenAt。
    const redo = await as(ADMIN, () => redoElection(electionId, "測試：重辦以驗證舊場次被鎖住"));
    expect(redo.ok, redo.ok ? "" : redo.error).toBe(true);

    const hidden = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(hidden.hiddenAt, "重辦後來源場次應該被打上 hiddenAt").not.toBeNull();
    expect(hidden.status, "重辦不改變來源場次原本的狀態").toBe("sealed");

    const resubmit = await as(ADMIN, () => submitResults(electionId, results, disclosures));
    expect(resubmit.ok, "已隱藏的場次不該還能重新提交計票結果").toBe(false);

    const draft = await prisma.announcement.findFirstOrThrow({
      where: { electionId, legalTag: "result" },
    });
    const publish = await as(ADMIN, () =>
      publishAnnouncement(electionId, draft.id, "result", draft.title, draft.body),
    );
    expect(publish.ok, "已隱藏的場次不該還能發布結果公告").toBe(false);

    const afterElection = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(afterElection.status, "狀態不該被推進到 published").toBe("sealed");
    expect(await prisma.office.count(), "被作廢的場次不該把當選人寫進 Office").toBe(
      officeCountBefore,
    );
  }, 60_000);
});

describe("作廢時一併刪除票匭暫存", () => {
  async function setUpVotingWithBallots(slug: string, voters: TestIdentity[]) {
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug, 1);
    const CAND: TestIdentity = { email: `cand-${slug}@test.local`, name: "候選人" };
    await importVoters(electionId, [...voters, CAND]);
    await advanceTo(electionId, "registration");
    const reg = await registerAs(slug, electionId, CAND);
    if (!reg.ok) throw new Error(`候選人登記失敗：${reg.error}`);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId } });
    for (const v of voters) {
      const cast = await voteAs(slug, electionId, v, publicKeyJwk, {
        type: "approval",
        approvals: { [candidate.id]: true },
      });
      expect(cast.ok, cast.ok ? "" : cast.error).toBe(true);
    }
    return electionId;
  }

  const VOTERS: TestIdentity[] = [
    { email: "v1@test.local", name: "投票人一" },
    { email: "v2@test.local", name: "投票人二" },
    { email: "v3@test.local", name: "投票人三" },
  ];

  it("hideElection 會清空該場的 EncryptedBallot（voting 態需超管附理由）", async () => {
    await resetDb();
    const electionId = await setUpVotingWithBallots("hidden-gate-b1", VOTERS);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(3);

    await captureRedirect(() =>
      as(ADMIN, () => hideElection(electionId, "測試：作廢以驗證票匭被清空")),
    );

    expect(
      await prisma.encryptedBallot.count({ where: { electionId } }),
      "隱藏後票匭暫存必須清空——voterId↔密文的對應不能留存",
    ).toBe(0);
  }, 60_000);

  it("redoElection 會清空舊場次的 EncryptedBallot", async () => {
    await resetDb();
    const electionId = await setUpVotingWithBallots("hidden-gate-b2", VOTERS);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(3);

    const redo = await as(ADMIN, () =>
      redoElection(electionId, "測試：重辦以驗證舊場次票匭被清空"),
    );
    expect(redo.ok, redo.ok ? "" : redo.error).toBe(true);

    expect(
      await prisma.encryptedBallot.count({ where: { electionId } }),
      "重辦後舊場次票匭暫存必須清空——voterId↔密文的對應不能留存",
    ).toBe(0);
  }, 60_000);

  // 第二輪駁回反例：hideElection 對 voting／closed／sealed 這三個已經可能有票的狀態，
  // 必須跟 redoElection 一樣要求超級管理員附理由才能作廢；moderator 或沒附理由都不准
  // 清空票匭。反例 1／2 對應駁回意見的「缺陷 A」。
  it("closed 場次不附理由呼叫 hideElection 會被拒絕，票匭不受影響", async () => {
    await resetDb();
    const electionId = await setUpVotingWithBallots("hidden-gate-c1", VOTERS);
    await advanceTo(electionId, "closed");
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(3);

    const result = await as(ADMIN, () => hideElection(electionId));
    expect(result.ok, "closed 場次已有票，不附理由不該准許隱藏").toBe(false);

    expect(
      await prisma.encryptedBallot.count({ where: { electionId } }),
      "被拒絕的隱藏不該動到票匭",
    ).toBe(3);
    expect(
      (await prisma.election.findUniqueOrThrow({ where: { id: electionId } })).hiddenAt,
      "被拒絕的隱藏不該設 hiddenAt",
    ).toBeNull();
  }, 60_000);

  it("closed 場次由 MODERATOR 呼叫 hideElection 會被拒絕（即使附了理由）", async () => {
    await resetDb();
    const electionId = await setUpVotingWithBallots("hidden-gate-c2", VOTERS);
    await advanceTo(electionId, "closed");
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(3);

    const result = await as(MODERATOR, () =>
      hideElection(electionId, "moderator 附的理由"),
    );
    expect(result.ok, "moderator 不是超級管理員，不該能作廢有票的場次").toBe(false);

    expect(
      await prisma.encryptedBallot.count({ where: { electionId } }),
      "被拒絕的隱藏不該動到票匭",
    ).toBe(3);
  }, 60_000);

  // 反例 3：redoElection 的 audit diff.voidedBallotCount 必須是「這場真的有幾張票」
  // （countCastBallots，即 Voter.votedAt 計數），不能用 EncryptedBallot deleteMany 的
  // 刪除筆數——sealed 場次彌封時 EncryptedBallot 早就被清空，deleteMany 恆為 0，
  // 稽核紀錄不能把「作廢 3 張票」寫成 0。
  it("redoElection 的稽核紀錄 voidedBallotCount 要用已投票數，不是 EncryptedBallot 刪除筆數", async () => {
    await resetDb();
    const slug = "hidden-gate-c3";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug, 1);
    const CAND: TestIdentity = { email: "cand-c3@test.local", name: "候選人" };
    await importVoters(electionId, [...VOTERS, CAND]);
    await advanceTo(electionId, "registration");
    const reg = await registerAs(slug, electionId, CAND);
    if (!reg.ok) throw new Error(`候選人登記失敗：${reg.error}`);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId } });
    for (const v of VOTERS) {
      const cast = await voteAs(slug, electionId, v, publicKeyJwk, {
        type: "approval",
        approvals: { [candidate.id]: true },
      });
      expect(cast.ok, cast.ok ? "" : cast.error).toBe(true);
    }

    await advanceTo(electionId, "closed");
    await seal(electionId);
    const { submitted } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);
    // 彌封已把 EncryptedBallot 清空，deleteMany 在 redoElection 裡恆為 0——
    // 這正是駁回意見指出的陷阱：不能拿這個數字當 voidedBallotCount。
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(0);

    const redo = await as(ADMIN, () =>
      redoElection(electionId, "測試：驗證稽核紀錄的票數"),
    );
    expect(redo.ok, redo.ok ? "" : redo.error).toBe(true);

    const log = await prisma.electionAuditLog.findFirstOrThrow({
      where: { electionId, action: "redo_election" },
      orderBy: { createdAt: "desc" },
    });
    const diff = log.diff as { voidedBallotCount?: number };
    expect(
      diff.voidedBallotCount,
      "sealed 場次重辦，稽核紀錄應記錄實際作廢的 3 張票，不是刪除筆數 0",
    ).toBe(3);
  }, 60_000);
});

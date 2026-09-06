// 程序測試：一場選舉從建立走到結果公告，每一步都經過真正的 server action、
// 真正的授權檢查與真正的資料庫。斷言集中在「法規要求的東西有沒有真的發生」。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { VOTER_A, VOTER_B, OUTSIDER, ADMIN, as } from "../helpers/session";
import { redoElection } from "@/app/admin/elections/[id]/actions";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  publishResult,
  registerAs,
  seal,
  tallyAndSubmit,
  voteAs,
} from "../helpers/flow";
import type { DisclosureEntry } from "@/lib/disclosure";
import { sha256Hex } from "@/lib/ballot-crypto";

const CANDIDATE_1 = { email: "cand1@test.local", name: "候選人一" };
const CANDIDATE_2 = { email: "cand2@test.local", name: "候選人二" };

describe("完整選舉流程（超額競選 → 相對多數）", () => {
  const slug = "flow-basic";
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let keyFiles: Awaited<ReturnType<typeof generateKeys>>["keyFiles"];
  const receipts: Record<string, string> = {};

  beforeAll(async () => {
    await resetDb();

    const created = await makeElection({ slug, seats: 1, maxChoices: 1 });
    expect(created.ok, created.error).toBe(true);
    electionId = created.electionId!;

    const keys = await generateKeys(electionId, slug);
    publicKeyJwk = keys.publicKeyJwk;
    keyFiles = keys.keyFiles;

    await importVoters(electionId, [VOTER_A, VOTER_B, CANDIDATE_1, CANDIDATE_2]);
    await advanceTo(electionId, "registration");

    expect((await registerAs(slug, electionId, CANDIDATE_1)).ok).toBe(true);
    expect((await registerAs(slug, electionId, CANDIDATE_2)).ok).toBe(true);
    await approveAll(electionId);
    await advanceTo(electionId, "voting");
  }, 90_000);

  it("開放投票後 ballotMode 依核准人數判定為 choose", async () => {
    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e.ballotMode).toBe("choose");
    expect(e.status).toBe("voting");
  });

  it("名冊外的人不能投票", async () => {
    const cands = await prisma.candidate.findMany({ where: { electionId, status: "approved" } });
    const r = await voteAs(slug, electionId, OUTSIDER, publicKeyJwk, {
      type: "choose",
      candidateIds: [cands[0].id],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("名冊");
  });

  it("投票成功會發收據，且收據就是密文的雜湊（§26-1 Ⅳ）", async () => {
    const cands = await prisma.candidate.findMany({
      where: { electionId, status: "approved" },
      orderBy: { number: "asc" },
    });
    for (const [voter, pick] of [
      [VOTER_A, cands[0]],
      [VOTER_B, cands[0]],
      [CANDIDATE_1, cands[1]],
    ] as const) {
      const r = await voteAs(slug, electionId, voter, publicKeyJwk, {
        type: "choose",
        candidateIds: [pick.id],
      });
      expect(r.ok, `${voter.email} 投票失敗`).toBe(true);
      if (r.ok) receipts[voter.email] = r.code;
    }
    // 第四位投廢票
    const blank = await voteAs(slug, electionId, CANDIDATE_2, publicKeyJwk, { type: "blank" });
    expect(blank.ok).toBe(true);
    if (blank.ok) receipts[CANDIDATE_2.email] = blank.code;

    for (const code of Object.values(receipts)) expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(Object.values(receipts)).size).toBe(4);
  });

  it("重投是覆寫：票匭張數不增加，votedAt 更新", async () => {
    const cands = await prisma.candidate.findMany({
      where: { electionId, status: "approved" },
      orderBy: { number: "asc" },
    });
    const before = await prisma.encryptedBallot.count({ where: { electionId } });
    const r = await voteAs(slug, electionId, VOTER_B, publicKeyJwk, {
      type: "choose",
      candidateIds: [cands[1].id],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.revote).toBe(true);
      receipts[VOTER_B.email] = r.code;
    }
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(before);
  });

  it("彌封後票匭快照留著，但選票↔選舉人的連結被銷毀（§26-1 Ⅳ）", async () => {
    await advanceTo(electionId, "closed");
    await seal(electionId);

    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e.status).toBe("sealed");
    expect((e.sealedBox as string[]).length).toBe(4);
    expect(e.sealedHash).toMatch(/^[0-9a-f]{64}$/);

    expect(
      await prisma.encryptedBallot.count({ where: { electionId } }),
      "彌封後仍留著 EncryptedBallot＝代碼與選舉人的連結還在，違反 §26-1 Ⅳ",
    ).toBe(0);
    // 名冊仍在（§26-1 Ⅴ 要附刊投票暨未投票名冊）
    expect(await prisma.voter.count({ where: { electionId, votedAt: { not: null } } })).toBe(4);
  });

  it("開票結果與去識別化明細一致，且明細通過伺服器端驗證", async () => {
    const { results, disclosures, submitted } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);

    expect(results.totalBallots).toBe(4);
    expect(results.blankCount).toBe(1);
    expect(results.invalidCount).toBe(0);
    expect(results.validCount).toBe(3);
    expect(results.rosterCount).toBe(4);
    expect(results.turnoutPct).toBe(100);
    expect(disclosures.length).toBe(4);

    const stored = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect((stored.disclosuresJson as unknown as DisclosureEntry[]).length).toBe(4);
  });

  it("每個投票人都能用自己的收據查到自己那一票的內容（§26-1 Ⅳ）", async () => {
    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const entries = e.disclosuresJson as unknown as DisclosureEntry[];
    const byCode = new Map(entries.map((x) => [x.code, x]));

    // 覆寫後舊收據應該查不到（舊票已不存在），新收據查得到。
    for (const [email, code] of Object.entries(receipts)) {
      expect(byCode.has(code), `${email} 的收據查不到`).toBe(true);
    }
    expect(byCode.get(receipts[CANDIDATE_2.email])!.kind).toBe("blank");

    // 代碼封在密文內部（投票人瀏覽器產生），沒有開票私鑰就算不出來。
    // 這條斷言的方向是刻意反過來的：如果有人能從公開的票匭密文重算出代碼，
    // 就能與這份公開明細 join 出「誰投給誰」——那正是彌封前的去匿名化破口。
    const box = e.sealedBox as string[];
    const recomputed = new Set(
      await Promise.all(box.map(async (c) => (await sha256Hex(c)).slice(0, 12))),
    );
    for (const entry of entries) {
      expect(
        recomputed.has(entry.code),
        "代碼可以從票匭密文重算出來，去匿名化防線破了",
      ).toBe(false);
    }
  });

  it("發布結果公告後狀態進 published，職務登記表落地", async () => {
    await publishResult(electionId);
    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e.status).toBe("published");

    const offices = await prisma.office.findMany();
    expect(offices.length).toBe(1);
    expect(offices[0].isVacant).toBe(false);
  });

  it("redoElection：已公告結果的選舉不能重辦，原場次不受影響", async () => {
    const before = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(before.status).toBe("published");

    const r = await as(ADMIN, () => redoElection(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不能重辦");

    const after = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(after.hiddenAt).toBeNull();
  });

  it("結果公告草稿含 §26-1 Ⅴ 的附刊聲明", async () => {
    const ann = await prisma.announcement.findFirstOrThrow({
      where: { electionId, legalTag: "result" },
    });
    expect(ann.body).toContain("第二十六條之一第五項");
    expect(ann.body).toContain("投票暨未投票選舉人名冊");
  });

  it("ElectionAuditLog 留下這場選舉關鍵動作的稽核紀錄，且都掛正確的操作者", async () => {
    const logs = await prisma.electionAuditLog.findMany({
      where: { electionId },
      orderBy: { createdAt: "asc" },
    });
    const actions = logs.map((l) => l.action);

    expect(actions).toContain("save_public_key");
    expect(actions).toContain("import_roster");
    expect(actions).toContain("advance_status");
    expect(actions).toContain("submit_results");
    expect(actions).toContain("publish_announcement");
    // 上一個 it 裡失敗的 redoElection（已公告結果不能重辦）不應留下紀錄——只記真的發生的事。
    expect(actions).not.toContain("redo_election");

    for (const log of logs) {
      expect(log.actorEmail, `${log.action} 的操作者不對`).toBe(ADMIN.email);
    }

    const submit = logs.find((l) => l.action === "submit_results");
    expect(submit?.diff).toMatchObject({ resubmit: false, totalBallots: 4, validCount: 3 });

    const publish = logs.find((l) => l.action === "publish_announcement");
    expect(publish?.diff).toMatchObject({ legalTag: "result", isFirstPublish: true });
  });
});

describe("同額競選（approval）", () => {
  const slug = "flow-approval";

  it("候選人數未超過名額時改採同意／不同意，同意多於不同意才當選", async () => {
    await resetDb();
    const created = await makeElection({ slug, seats: 2, maxChoices: 1 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;

    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, VOTER_B, CANDIDATE_1]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CANDIDATE_1);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");

    const e = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e.ballotMode).toBe("approval");

    await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await voteAs(slug, electionId, VOTER_B, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: false },
    });
    await voteAs(slug, electionId, CANDIDATE_1, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });

    await advanceTo(electionId, "closed");
    await seal(electionId);
    const { results, submitted } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(submitted.ok).toBe(true);
    expect(results.mode).toBe("approval");
    expect(results.candidates[0]).toMatchObject({ votes: 2, disagree: 1, elected: true });

    // §1-1：金鑰遺失重辦的正當時機正是彌封後、開票當下——sealed 狀態必須仍能重辦。
    // D14-1：sealed 已經有票，一般管理員不能按，超管也必須附理由。
    const before = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(before.status).toBe("sealed");

    const redone = await as(ADMIN, () => redoElection(electionId, "金鑰檔損毀，確認遺失"));
    expect(redone.ok, redone.ok ? "" : redone.error).toBe(true);

    const after = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(after.hiddenAt).not.toBeNull();

    const redoLog = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "redo_election" },
    });
    expect(redoLog?.actorEmail).toBe(ADMIN.email);
    if (redone.ok) {
      expect(redoLog?.diff).toMatchObject({ newElectionId: redone.electionId });
    }
  }, 60_000);
});

// D4-1／D11-1／D11-2／D4-4／D4-5：submitResults 收下 client 算出的 TallyResult 後，
// 六道檢查沒有一道重算 elected／tied／hasTie／rosterCount／turnoutPct，候選人也能在
// 陣列裡重複出現。這裡驗證伺服器自己重算，不再照抄 client 送來的旗標。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, as } from "../helpers/session";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
  seal,
  voteAs,
} from "../helpers/flow";
import { decryptAndTally } from "@/lib/tally-client";
import { submitResults } from "@/app/admin/elections/[id]/tally/actions";
import type { TallyResult } from "@/lib/tally";
import type { DisclosureEntry } from "@/lib/disclosure";
import { combineKeyFiles, decryptBallot, type TallyKeyFile } from "@/lib/ballot-crypto";

const SLUG = "results-integrity";
const V = (n: number) => ({ email: `ri-v${n}@test.local`, name: `投票人${n}` });
const C = (n: number) => ({ email: `ri-c${n}@test.local`, name: `候選人${n}` });

interface Fixture {
  electionId: string;
  keyFiles: TallyKeyFile[];
  candidateIds: string[];
  results: TallyResult;
  disclosures: DisclosureEntry[];
}

/** 把選舉退回「已彌封、尚未提交結果」，讓下一個 it() 從同一起點測。 */
async function resetSubmission(electionId: string) {
  await prisma.announcement.deleteMany({ where: { electionId } });
  await prisma.electionAuditLog.deleteMany({ where: { electionId, action: "submit_results" } });
  await prisma.$executeRaw`UPDATE "Election" SET "resultsJson" = NULL, "disclosuresJson" = NULL, "status" = 'sealed' WHERE id = ${electionId}`;
}

const clone = <T>(x: T): T => structuredClone(x);

describe("結果提交完整性：elected／tied／hasTie／rosterCount／turnoutPct 一律伺服器自算", () => {
  let f: Fixture;

  beforeAll(async () => {
    await resetDb();
    // 3 位候選人、1 席、單記；5 位投票人：甲乙丙投 1 號、丁投 2 號、戊投廢票。
    // 誠實結果：1 號 3 票當選、2 號 1 票、3 號 0 票。
    const created = await makeElection({ slug: SLUG, seats: 1, maxChoices: 1, kind: "other" });
    if (!created.ok) throw new Error(`建場失敗：${created.error}`);
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, SLUG);

    const cands = [C(1), C(2), C(3)];
    const voters = [V(1), V(2), V(3), V(4), V(5)];
    await importVoters(electionId, [...voters, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(SLUG, electionId, c);
    const approved = await approveAll(electionId);
    const candidateIds = approved.map((c) => c.id);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const picks: number[][] = [[0], [0], [0], [1], []];
    for (const [i, pick] of picks.entries()) {
      const choice =
        pick.length === 0
          ? ({ type: "blank" } as const)
          : ({ type: "choose", candidateIds: pick.map((p) => candidateIds[p]) } as const);
      const r = await voteAs(SLUG, electionId, voters[i], publicKeyJwk, choice);
      if (!r.ok) throw new Error(`投票失敗：${r.error}`);
    }

    await advanceTo(electionId, "closed");
    await seal(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const rosterCount = await prisma.voter.count({ where: { electionId } });
    const { results, disclosures } = await decryptAndTally(
      keyFiles,
      (election.sealedBox as string[]) ?? [],
      {
        electionId,
        slug: SLUG,
        ballotMode: election.ballotMode as "choose" | "approval",
        seats: 1,
        maxChoices: 1,
        candidateIds,
        rosterCount,
      },
    );
    expect(results.candidates.find((c) => c.candidateId === candidateIds[0])!.votes).toBe(3);
    expect(results.candidates.find((c) => c.candidateId === candidateIds[0])!.elected).toBe(true);

    f = { electionId, keyFiles, candidateIds, results, disclosures };
  }, 180_000);

  it("翻轉 elected 旗標（票數誠實）：DB 存的是伺服器自算的正確當選人", async () => {
    const r = clone(f.results);
    r.candidates.find((c) => c.candidateId === f.candidateIds[0])!.elected = false;
    r.candidates.find((c) => c.candidateId === f.candidateIds[1])!.elected = true;
    const got = await as(ADMIN, () => submitResults(f.electionId, r, f.disclosures));
    expect(got.ok).toBe(true);

    const saved = (await prisma.election.findUniqueOrThrow({ where: { id: f.electionId } }))
      .resultsJson as unknown as TallyResult;
    expect(saved.candidates.find((c) => c.candidateId === f.candidateIds[0])!.elected).toBe(true);
    expect(saved.candidates.find((c) => c.candidateId === f.candidateIds[1])!.elected).toBe(false);
    expect(saved.hasTie).toBe(false);

    const log = await prisma.electionAuditLog.findFirstOrThrow({
      where: { electionId: f.electionId, action: "submit_results" },
    });
    expect((log.diff as Record<string, unknown>).clientMismatch).toBe(true);

    await resetSubmission(f.electionId);
  });

  it("rosterCount／turnoutPct 亂填：DB 存的是伺服器算出的 voter.count() 與對應投票率", async () => {
    const r = clone(f.results);
    r.rosterCount = 9999;
    r.turnoutPct = 100;
    const got = await as(ADMIN, () => submitResults(f.electionId, r, f.disclosures));
    expect(got.ok).toBe(true);

    const realRosterCount = await prisma.voter.count({ where: { electionId: f.electionId } });
    const saved = (await prisma.election.findUniqueOrThrow({ where: { id: f.electionId } }))
      .resultsJson as unknown as TallyResult;
    expect(saved.rosterCount).toBe(realRosterCount);
    expect(saved.turnoutPct).toBe(Math.round((r.totalBallots / realRosterCount) * 1000) / 10);

    await resetSubmission(f.electionId);
  });

  it("候選人在陣列裡重複出現：拒收", async () => {
    const r = clone(f.results);
    r.candidates.push(clone(r.candidates.find((c) => c.candidateId === f.candidateIds[0])!));
    const got = await as(ADMIN, () => submitResults(f.electionId, r, f.disclosures));
    expect(got.ok).toBe(false);
    await resetSubmission(f.electionId);
  });

  it("mode 與本場 ballotMode 不符：拒收", async () => {
    const r = clone(f.results) as TallyResult;
    r.mode = "approval";
    const got = await as(ADMIN, () => submitResults(f.electionId, r, f.disclosures));
    expect(got.ok).toBe(false);
    await resetSubmission(f.electionId);
  });

  // D3-1：明細順序本身是側通道——sealedBox 是公開的，提交者若把明細排成與
  // sealedBox 同索引，任何持彌封前 EncryptedBallot 快照者事後都能逐人還原
  // 誰投給誰。伺服器存檔前必須自己依 code 排序，不能照抄提交順序。
  it("明細改成 sealedBox 同索引順序送出：DB 存的仍是依 code 排序，提交順序不留痕跡", async () => {
    const election = await prisma.election.findUniqueOrThrow({ where: { id: f.electionId } });
    const box = (election.sealedBox as string[]) ?? [];
    const priv = combineKeyFiles(f.keyFiles);
    const byCode = new Map(f.disclosures.map((d) => [d.code, d]));
    const boxOrdered: DisclosureEntry[] = [];
    for (const ct of box) {
      const plain = await decryptBallot(priv, ct);
      boxOrdered.push(byCode.get(plain!.code)!);
    }

    const sortedCodes = [...f.disclosures].map((d) => d.code).sort();
    // 先確認「同索引順序」與「排序後順序」確實不同，測試才有意義。
    expect(boxOrdered.map((d) => d.code)).not.toEqual(sortedCodes);

    const got = await as(ADMIN, () => submitResults(f.electionId, f.results, boxOrdered));
    expect(got.ok).toBe(true);

    const saved = (await prisma.election.findUniqueOrThrow({ where: { id: f.electionId } }))
      .disclosuresJson as unknown as DisclosureEntry[];
    expect(saved.map((d) => d.code)).toEqual(sortedCodes);

    await resetSubmission(f.electionId);
  });
});

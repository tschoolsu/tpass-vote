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
  publishResult,
  registerAs,
  seal,
  voteAs,
} from "../helpers/flow";
import { decryptAndTally } from "@/lib/tally-client";
import { submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import type { TallyResult } from "@/lib/tally";
import type { DisclosureEntry } from "@/lib/disclosure";
import { combineKeyFiles, decryptBallot, type BallotPlain, type TallyKeyFile } from "@/lib/ballot-crypto";
import { APP_URL } from "../helpers/env";

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

// D12-3：可回溯代碼由投票人瀏覽器產生、封在密文內部，伺服器收票時看不到，
// 兩位串通的選舉人可以各自送出「代碼相同」的密文。修法前 verifyDisclosures 一遇到
// 重複代碼就讓 submitResults 整批拒收、全場開不了票；修法後改成把撞號的兩張票
// 全部算無效票（§26-1 Ⅷ），其餘照常開票。
const PADDED_PLAIN_SIZE = 2048; // 與 ballot-crypto.ts 的常數一致（那裡沒 export）
const LENGTH_PREFIX = 4;

function dupToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 攻擊者版本的 encryptBallot：唯一差別是「代碼可以自己指定」，用來重現串通投票。 */
async function encryptWithChosenCode(
  publicKeyJwk: JsonWebKey,
  plain: BallotPlain,
): Promise<string> {
  const json = JSON.stringify(plain);
  const payload = new TextEncoder().encode(json);
  const padded = globalThis.crypto.getRandomValues(new Uint8Array(PADDED_PLAIN_SIZE));
  new DataView(padded.buffer).setUint32(0, payload.length, false);
  padded.set(payload, LENGTH_PREFIX);

  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, padded);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const ek = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    await crypto.subtle.exportKey("raw", aesKey),
  );
  return JSON.stringify({
    v: 2,
    alg: "RSA-OAEP-256+A256GCM",
    ek: dupToB64(ek),
    iv: dupToB64(iv),
    ct: dupToB64(ct),
  });
}

describe("重複代碼（D12-3）：串通投票人送出同代碼，開票端把那幾張標為無效票，不再整場開不了票", () => {
  const DUP_SLUG = "results-integrity-dup-code";
  const DV = (n: number) => ({ email: `dc-v${n}@test.local`, name: `投票人${n}` });
  const DC = (n: number) => ({ email: `dc-c${n}@test.local`, name: `候選人${n}` });

  it("兩位投票人同代碼：submitResults ok、有效票數少 2、無效票數多 2", async () => {
    const created = await makeElection({ slug: DUP_SLUG, seats: 1, maxChoices: 1, kind: "other" });
    if (!created.ok) throw new Error(`建場失敗：${created.error}`);
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, DUP_SLUG);

    const cands = [DC(1), DC(2)];
    const voters = [DV(1), DV(2), DV(3)]; // 1、2 串通同代碼；3 誠實投票
    await importVoters(electionId, [...voters, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(DUP_SLUG, electionId, c);
    const approved = await approveAll(electionId);
    const candidateIds = approved.map((c) => c.id);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    // 串通者甲乙各自送出「代碼相同」的密文——密文是投票人瀏覽器造的，伺服器只驗形狀
    // （castBallot 唯一的內容檢查），完全看不到代碼；正常的 encryptBallot 只會產生
    // 隨機代碼，這裡直接組出攻擊者密文重現串通。
    const COLLUDING_CODE = "abcdef123456";
    const dupChoices: BallotPlain["choice"][] = [
      { type: "choose", candidateIds: [candidateIds[0]] },
      { type: "choose", candidateIds: [candidateIds[1]] },
    ];
    for (const [i, choice] of dupChoices.entries()) {
      const ciphertext = await encryptWithChosenCode(publicKeyJwk, {
        v: 2,
        electionId,
        code: COLLUDING_CODE,
        choice,
      });
      const cast = await as(voters[i], () => castBallot(DUP_SLUG, ciphertext));
      if (!cast.ok) throw new Error(`收票失敗：${cast.error}`);
    }
    // 誠實投票人正常投一號。
    const honest = await voteAs(DUP_SLUG, electionId, voters[2], publicKeyJwk, {
      type: "choose",
      candidateIds: [candidateIds[0]],
    });
    if (!honest.ok) throw new Error(`投票失敗：${honest.error}`);

    await advanceTo(electionId, "closed");
    await seal(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const rosterCount = await prisma.voter.count({ where: { electionId } });
    const { results, disclosures } = await decryptAndTally(
      keyFiles,
      (election.sealedBox as string[]) ?? [],
      {
        electionId,
        slug: DUP_SLUG,
        ballotMode: election.ballotMode as "choose" | "approval",
        seats: 1,
        maxChoices: 1,
        candidateIds,
        rosterCount,
      },
    );
    const submitted = await as(ADMIN, () => submitResults(electionId, results, disclosures));

    expect(submitted.ok).toBe(true);
    expect(results.totalBallots).toBe(3);
    expect(results.invalidCount).toBe(2);
    expect(results.validCount).toBe(1);
    expect(results.candidates.find((c) => c.candidateId === candidateIds[0])!.votes).toBe(1);
    expect(results.candidates.find((c) => c.candidateId === candidateIds[1])!.votes).toBe(0);

    const dupEntries = disclosures.filter((d) => d.code === COLLUDING_CODE);
    expect(dupEntries).toHaveLength(2);
    expect(dupEntries.every((d) => d.kind === "invalid")).toBe(true);

    // 規格第四項：撞號的無效票在公開明細要能與「純粹解不開的爛票」分開顯示，
    // 不能兩者都變成同一句「無效票」——否則投票人查自己的收據看不出發生了什麼事。
    // reason 要能撐過 submitResults 的 disclosureSchema、存進 disclosuresJson，
    // 再由 /disclosures 端點的收據查詢原樣講出來。
    await publishResult(electionId);
    const receipt = await fetch(
      `${APP_URL}/api/elections/${DUP_SLUG}/disclosures?code=${COLLUDING_CODE}`,
    );
    expect(receipt.status).toBe(200);
    const receiptBody = (await receipt.json()) as { found: boolean; summary: string };
    expect(receiptBody.summary).toBe("代碼重複，無效");
  }, 180_000);
});

// D11-3（approval 模式）：disclosuresJson 是 Prisma Json（Postgres jsonb），jsonb 落地時
// 會把物件的鍵重新正規化排序；approval 明細的 approvals 鍵序＝投票人瀏覽器的點擊順序，
// 跟正規序無關。submitResults 若對「記憶體裡未正規化的 sortedDisclosures」算雜湊，
// 事後對「DB 讀回來的正規化形」重算永遠對不上——稽核者拿公開明細核對雜湊會被誤判成
// 「被竄改」，isResubmit 的 previousDisclosuresSha256 也永遠接不上前一筆的
// disclosuresSha256。修法：落地前把 approvals 的鍵排序，讓記憶體形與 jsonb 正規化形
// 天生一致（見 tally/actions.ts 的 normalizeApprovals）。
import { createHash } from "node:crypto";
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
import type { TallyKeyFile } from "@/lib/ballot-crypto";

const SLUG = "refuter-approval";
const V = (n: number) => ({ email: `ra-v${n}@test.local`, name: `投票人${n}` });
const C = (n: number) => ({ email: `ra-c${n}@test.local`, name: `候選人${n}` });

describe("結果提交完整性：approval 模式的稽核雜湊鏈", () => {
  let electionId: string;
  let candidateIds: string[];
  let results: TallyResult;
  let disclosures: DisclosureEntry[];
  let keyFiles: TallyKeyFile[];

  beforeAll(async () => {
    await resetDb();
    // 3 席 3 位候選人 → advanceStatus 判定 ballotMode = approval。
    const created = await makeElection({ slug: SLUG, seats: 3, maxChoices: 3, kind: "other" });
    if (!created.ok) throw new Error(`建場失敗：${created.error}`);
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, SLUG);
    keyFiles = keys.keyFiles;

    const cands = [C(1), C(2), C(3)];
    const voters = [V(1), V(2), V(3), V(4), V(5)];
    await importVoters(electionId, [...voters, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(SLUG, electionId, c);
    const approved = await approveAll(electionId);
    candidateIds = approved.map((c) => c.id);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const e0 = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(e0.ballotMode).toBe("approval");

    // 投票人瀏覽器裡的 approvals 鍵序＝按鈕點擊順序，跟 candidateId 字典序無關。
    // 這裡用「反字典序」代表任一種非正規序（9 位候選人時，剛好命中正規序的機率是 1/9!）。
    const byDesc = [...candidateIds].sort().reverse();
    for (const v of voters) {
      const approvals: Record<string, boolean> = {};
      for (const id of byDesc) approvals[id] = true;
      const r = await voteAs(SLUG, electionId, v, e0.tallyPublicKeyJwk as never, {
        type: "approval",
        approvals,
      });
      if (!r.ok) throw new Error(`投票失敗：${r.error}`);
    }

    await advanceTo(electionId, "closed");
    await seal(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const rosterCount = await prisma.voter.count({ where: { electionId } });
    const t = await decryptAndTally(keyFiles, (election.sealedBox as string[]) ?? [], {
      electionId,
      slug: SLUG,
      ballotMode: "approval",
      seats: 3,
      maxChoices: 3,
      candidateIds,
      rosterCount,
    });
    results = t.results;
    disclosures = t.disclosures;
  });

  it("重新提交時 previousDisclosuresSha256 應等於前一筆 log 的 disclosuresSha256", async () => {
    const first = await as(ADMIN, () => submitResults(electionId, results, disclosures));
    expect(first).toEqual({ ok: true });

    // 第二次提交：內容完全相同（連明細都一字不差），只是重按一次提交。
    const second = await as(ADMIN, () => submitResults(electionId, results, disclosures));
    expect(second).toEqual({ ok: true });

    const logs = await prisma.electionAuditLog.findMany({
      where: { electionId, action: "submit_results" },
      orderBy: { createdAt: "asc" },
    });
    expect(logs).toHaveLength(2);
    const d1 = logs[0].diff as Record<string, unknown>;
    const d2 = logs[1].diff as Record<string, unknown>;
    // 兩次提交的明細一模一樣 → 這三個值理應全部相同。
    expect(d2.previousDisclosuresSha256).toBe(d1.disclosuresSha256);

    // 唯一留存的證物是 DB（也是公開明細 API 吐的那份）——稽核者只能拿它重算雜湊，
    // 記在 log 裡的 disclosuresSha256 必須對得上，否則誠實的選委會被誤判成竄改。
    const saved = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const rehash = createHash("sha256").update(JSON.stringify(saved.disclosuresJson)).digest("hex");
    expect(rehash).toBe(d1.disclosuresSha256);
  });
});

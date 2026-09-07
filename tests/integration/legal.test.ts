// 法規約束的負面測試：這些是「不該發生的事必須被擋下來」。
// 條號對應《臺北市數位實驗高級中等學校學生會選舉罷免條例》第三版。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, MODERATOR, VOTER_A, VOTER_B, as } from "../helpers/session";
import {
  HOUR,
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  registerAs,
  seal,
  tallyAndSubmit,
  voteAs,
  toLocalInput,
} from "../helpers/flow";
import { advanceStatus, redoElection } from "@/app/admin/elections/[id]/actions";
import { sealElection, submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { removeVoter } from "@/app/admin/elections/[id]/roster/actions";
import { approveCandidate } from "@/app/admin/elections/[id]/candidates/actions";
import type { DisclosureEntry } from "@/lib/disclosure";

const CAND = { email: "c@test.local", name: "候選人" };

beforeEach(async () => {
  await resetDb();
});

describe("§26-1 Ⅱ 投票期間不得少於 48 小時", () => {
  it("表單擋下 47 小時", async () => {
    const r = await makeElection({ slug: "short-window", votingHours: 47 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("48");
  });

  it("表單放行 48 小時整", async () => {
    const r = await makeElection({ slug: "exact-window", votingHours: 48 });
    expect(r.ok, r.error).toBe(true);
  });

  it("繞過表單把時間改短，開放投票時仍被擋", async () => {
    const created = await makeElection({ slug: "tampered-window" });
    const electionId = created.electionId!;
    await generateKeys(electionId, "tampered-window");
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs("tampered-window", electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");

    // 直接改 DB，模擬「表單驗證被繞過」或舊資料
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(),
        votingEndsAt: new Date(Date.now() + 10 * HOUR),
      },
    });

    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("48");
  });

  it("沒設投票時間就不能開放投票", async () => {
    const created = await makeElection({ slug: "no-window" });
    const electionId = created.electionId!;
    await generateKeys(electionId, "no-window");
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs("no-window", electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await prisma.election.update({
      where: { id: electionId },
      data: { votingStartsAt: null, votingEndsAt: null },
    });

    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("投票開始與截止時間");
  });

  it("D12-1：整段投票期間已經過去，不准從造勢期開放投票", async () => {
    const created = await makeElection({ slug: "voting-window-elapsed" });
    const electionId = created.electionId!;
    await generateKeys(electionId, "voting-window-elapsed");
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs("voting-window-elapsed", electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 72 * HOUR),
        votingEndsAt: new Date(Date.now() - 24 * HOUR),
      },
    });

    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("已過去");
  });
});

describe("D2-4／D12-2 開放投票時距截止不足 48 小時（選委晚按不能吃掉法定投票期間）", () => {
  async function setupAtCampaigning(slug: string) {
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    return electionId;
  }

  /** 從錯誤訊息「距投票截止只剩 X 小時」抓出 X，斷言真的算出「快沒了」而不是隨便一個含 48 的數字。 */
  function remainingHoursIn(message: string): number {
    const m = /距投票截止只剩 (-?\d+(?:\.\d+)?) 小時/.exec(message);
    if (!m) throw new Error(`錯誤訊息格式不符，抓不到剩餘小時數：${message}`);
    return Number(m[1]);
  }

  it("排程跨度仍有 48 小時，但選委晚按導致距截止只剩 1 小時，一般管理員不能開放投票", async () => {
    const electionId = await setupAtCampaigning("voting-force-mod");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 47 * HOUR),
        votingEndsAt: new Date(Date.now() + HOUR),
      },
    });

    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 剩餘時數要確實反映「只剩 1 小時左右」，不是隨便一個字串巧合含有 "48"（法定下限本身
      // 就含 "48"，光斷言 toContain("48") 就算訊息壞掉也會過）。
      const hours = remainingHoursIn(r.error);
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThan(1.5);
      expect(r.error).toContain(`法定投票期間為 ${48} 小時`);
    }
  });

  it("投票已排定但尚未開始，即使排程剛好卡在 48 小時法定下限，選委提早按下也能正常開放（不是只有超管逃生門這一條路）", async () => {
    // 反例：D2-4 的閘門若用「按下這一刻」而非「max(按下這一刻, votingStartsAt)」當起點，
    // 這種剛好 48 小時、選委提早按的合法場次會被閘門永久擋下——選委只能等到 votingStartsAt
    // 那一刻按，但那一刻一過就立刻不足 48 小時，等於整場沒有任何時間點按得下去。
    const created = await makeElection({
      slug: "voting-exact-48-early-press",
      votingHours: 48,
      votingStartsAt: new Date(Date.now() + 3 * 60_000),
    });
    const electionId = created.electionId!;
    await generateKeys(electionId, "voting-exact-48-early-press");
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs("voting-exact-48-early-press", electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.votingStartsAt!.getTime()).toBeGreaterThan(Date.now()); // 還沒開始
    expect(election.votingEndsAt!.getTime() - election.votingStartsAt!.getTime()).toBe(48 * HOUR);

    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("同樣只剩 1 小時，超級管理員附理由可以強制開放，audit log 記下理由", async () => {
    const electionId = await setupAtCampaigning("voting-force-super");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 47 * HOUR),
        votingEndsAt: new Date(Date.now() + HOUR),
      },
    });

    const r = await as(ADMIN, () => advanceStatus(electionId, "選委晚按，選情緊急先行開放"));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.status).toBe("voting");
    const log = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "advance_status" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(log?.diff)).toContain("選委晚按");
  });

  it("超級管理員不附理由一樣被擋", async () => {
    const electionId = await setupAtCampaigning("voting-force-super-no-reason");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 47 * HOUR),
        votingEndsAt: new Date(Date.now() + HOUR),
      },
    });

    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const hours = remainingHoursIn(r.error);
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThan(1.5);
    }
  });

  it("一般管理員即使帶 reason，距截止不足 48 小時一樣被擋（reason 只有超管用得到）", async () => {
    const electionId = await setupAtCampaigning("voting-force-mod-with-reason");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 47 * HOUR),
        votingEndsAt: new Date(Date.now() + HOUR),
      },
    });

    const r = await as(MODERATOR, () => advanceStatus(electionId, "我也想附理由強制開放"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const hours = remainingHoursIn(r.error);
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThan(1.5);
    }
    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.status).toBe("campaigning");
  });

  it("反例：剩餘小時數的顯示不四捨五入進位——快到 48 小時但仍不足時，訊息裡的數字要小於 48，不能印出跟法定下限一樣的「48」造成自相矛盾", async () => {
    // 47 小時 59 分：故意選在 Math.round 到小數點下一位會進位成 48.0 的區間，
    // 用來抓「距投票截止只剩 48 小時，法定投票期間為 48 小時」這種讓人看不懂為什麼被擋的訊息。
    const electionId = await setupAtCampaigning("voting-force-rounding-edge");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(Date.now() - 49 * HOUR),
        votingEndsAt: new Date(Date.now() + 47 * HOUR + 59 * 60_000),
      },
    });

    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const hours = remainingHoursIn(r.error);
      expect(hours).toBeLessThan(48);
    }
  });

  it("距截止還有 49 小時，一般管理員可以正常開放投票", async () => {
    const electionId = await setupAtCampaigning("voting-force-ok");
    await prisma.election.update({
      where: { id: electionId },
      data: {
        votingStartsAt: new Date(),
        votingEndsAt: new Date(Date.now() + 49 * HOUR),
      },
    });

    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });
});

describe("D2-3／D12-1 投票截止前不能關票", () => {
  async function setupAtVoting(slug: string) {
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "voting");
    return electionId;
  }

  it("截止時間未到，一般管理員不能關票", async () => {
    const electionId = await setupAtVoting("close-gate-mod");
    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("尚不能關票");
  });

  it("截止時間未到，超級管理員不附理由一樣不能關票", async () => {
    const electionId = await setupAtVoting("close-gate-super-no-reason");
    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("尚不能關票");
  });

  it("截止時間未到，超級管理員附理由可以強制關票，理由寫進 audit log", async () => {
    const electionId = await setupAtVoting("close-gate-super-forced");
    const r = await as(ADMIN, () => advanceStatus(electionId, "選情膠著，選委會決議提前關票"));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.status).toBe("closed");
    const log = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "advance_status" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(log?.diff)).toContain("選情膠著");
  });

  it("截止時間已到，一般管理員可以正常關票", async () => {
    const electionId = await setupAtVoting("close-gate-on-time");
    await prisma.election.update({
      where: { id: electionId },
      data: { votingEndsAt: new Date(Date.now() - HOUR) },
    });
    const r = await as(MODERATOR, () => advanceStatus(electionId));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("強制關票理由超過 200 字會被截斷，不會整段塞進稽核紀錄", async () => {
    const electionId = await setupAtVoting("close-gate-reason-cap");
    const longReason = "理由".repeat(150); // 300 字
    const r = await as(ADMIN, () => advanceStatus(electionId, longReason));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const log = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "advance_status" },
      orderBy: { createdAt: "desc" },
    });
    const diff = log?.diff as { reason?: string } | null;
    expect(diff?.reason?.length).toBe(200);
    expect(longReason.length).toBeGreaterThan(200);
  });
});

describe("§13 學生代表：複數選區單記不可讓渡", () => {
  it("grade_rep 場次不得連記（maxChoices 只能是 1）", async () => {
    const r = await makeElection({ slug: "sntv-bad", kind: "grade_rep", seats: 3, maxChoices: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("單記");
  });

  it("seats=3、maxChoices=1 的場次可以建立並跑完，取前三名", async () => {
    const slug = "sntv-good";
    const created = await makeElection({ slug, kind: "grade_rep", seats: 3, maxChoices: 1 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug);

    const voters = Array.from({ length: 5 }, (_, i) => ({
      email: `v${i}@test.local`,
      name: `選舉人${i}`,
    }));
    const cands = Array.from({ length: 4 }, (_, i) => ({
      email: `sc${i}@test.local`,
      name: `代表候選人${i}`,
    }));
    await importVoters(electionId, [...voters, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(slug, electionId, c);
    const approved = await approveAll(electionId);
    await advanceTo(electionId, "voting");

    // 得票 3 / 1 / 1 / 0：前三名當選，第 3、4 名同票會落在席次邊界
    const picks = [0, 0, 0, 1, 2];
    for (let i = 0; i < voters.length; i++) {
      const r = await voteAs(slug, electionId, voters[i], publicKeyJwk, {
        type: "choose",
        candidateIds: [approved[picks[i]].id],
      });
      expect(r.ok).toBe(true);
    }

    await advanceTo(electionId, "closed");
    await seal(electionId);
    const { results } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(results.mode).toBe("choose");
    expect(results.candidates.find((c) => c.candidateId === approved[0].id)!.votes).toBe(3);
    // 第 3 席邊界：兩人各 1 票、一人 0 票 → 邊界票數是 1，第 4 名 0 票不同票
    expect(results.hasTie).toBe(false);
    expect(results.candidates.filter((c) => c.elected).length).toBe(3);
  }, 90_000);

  it("單記場次圈兩人的票算無效票", async () => {
    const slug = "sntv-overvote";
    const created = await makeElection({ slug, kind: "grade_rep", seats: 2, maxChoices: 1 });
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug);
    const cands = [
      { email: "oc1@test.local", name: "甲" },
      { email: "oc2@test.local", name: "乙" },
      { email: "oc3@test.local", name: "丙" },
    ];
    await importVoters(electionId, [VOTER_A, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(slug, electionId, c);
    const approved = await approveAll(electionId);
    await advanceTo(electionId, "voting");

    // 客戶端限制被繞過的情境：直接送出圈兩人的密文
    await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "choose",
      candidateIds: [approved[0].id, approved[1].id],
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);
    const { results, disclosures } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(results.invalidCount).toBe(1);
    expect(results.validCount).toBe(0);
    expect(disclosures[0].kind).toBe("invalid");
  }, 60_000);
});

describe("§26-1 Ⅳ／Ⅴ 明細與名冊", () => {
  it("竄改過的明細會被伺服器擋下（沒有私鑰也驗得出來）", async () => {
    const slug = "tamper-disclosure";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await voteAs(slug, electionId, VOTER_B, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: false },
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    const { results, disclosures } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(results.candidates[0]).toMatchObject({ votes: 1, disagree: 1 });

    // 把「不同意」偷改成「同意」，票數維持不變 → 明細與結果不一致，必須被拒
    const forged: DisclosureEntry[] = disclosures.map((d) =>
      d.kind === "approval" ? { ...d, approvals: { [cand.id]: true } } : d,
    );
    const r = await as(ADMIN, () => submitResults(electionId, results, forged));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("明細");

    // ⚠️ 代碼對不上票匭「不再」被拒——這是刻意的取捨，不是退步。
    // 代碼改由投票人瀏覽器產生、封在加密選票內部之後，伺服器沒有開票私鑰就算不出
    // 代碼，無從比對。換到的是：彌封前任何有 EncryptedBallot 讀權限者，再也不能
    // 單獨一人建出 voterId↔代碼對照表、與公告後的公開明細 join 出「誰投給誰」。
    // 這條斷言方向是反的，好讓日後有人改壞時會紅在這裡而不是默默恢復對帳。
    // 結果造假的防線改為兩位選委各自獨立開票比對（docs/election-sop.md）。
    const wrongCodes: DisclosureEntry[] = disclosures.map((d, i) =>
      i === 0 ? { ...d, code: "ffffffffffff" } : d,
    );
    const r2 = await as(ADMIN, () => submitResults(electionId, results, wrongCodes));
    expect(r2.ok, "代碼對帳應已隨『代碼封進密文』一併取消").toBe(true);

    // 原始明細仍可正常提交
    const ok = await as(ADMIN, () => submitResults(electionId, results, disclosures));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(election.status).toBe("sealed");
  }, 90_000);

  // D4-3 稽核駁回附件重現：verifyDisclosures 曾只靠提交者自己填的 results.mode 判定
  // 明細 kind 是否一致——攻擊者把 choose 場的 results.mode 與整批明細 kind 一起改成
  // "approval"（判定較寬鬆、且不受 maxChoices 限制），就能讓 choose 場整套 well-formed
  // 判定被跳過，構造出「有效票數對得上、卻沒有加給任何候選人」的自洽假結果。
  // 修法後 submitResults 在碰明細之前就先比對 r.mode 與 election.ballotMode（DB 真相），
  // 不一致直接拒絕，攻擊者無從讓「自稱 mode」與「明細 kind」聯手繞過真實模式的限制。
  it("計票結果宣告的 mode 與本場真實 ballotMode 不符會被拒絕", async () => {
    const slug = "mode-mismatch";
    const created = await makeElection({ slug, kind: "grade_rep", seats: 1, maxChoices: 1 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;
    const { publicKeyJwk, keyFiles } = await generateKeys(electionId, slug);

    // 3 位候選人角逐 1 席 → candidates.length > seats，本場真實 ballotMode 定案為 choose。
    const cands = Array.from({ length: 3 }, (_, i) => ({
      email: `mmc${i}@test.local`,
      name: `模式候選人${i}`,
    }));
    await importVoters(electionId, [VOTER_A, ...cands]);
    await advanceTo(electionId, "registration");
    for (const c of cands) await registerAs(slug, electionId, c);
    const approved = await approveAll(electionId);
    await advanceTo(electionId, "voting");

    await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "choose",
      candidateIds: [approved[0].id],
    });
    await advanceTo(electionId, "closed");
    await seal(electionId);

    const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(election.ballotMode).toBe("choose");

    const { results, disclosures } = await tallyAndSubmit(electionId, slug, keyFiles);
    expect(results.mode).toBe("choose");
    expect(results.candidates.find((c) => c.candidateId === approved[0].id)).toMatchObject({
      votes: 1,
    });

    // 偽造：results.mode 與整批明細 kind 一起改成 approval，approvals 全填 false，
    // 藉此把候選人票數灌成 0（approval 模式不受 maxChoices 限制、且不檢查圈選數）。
    const forgedResults = { ...results, mode: "approval" as const };
    const forgedDisclosures: DisclosureEntry[] = disclosures.map((d) => ({
      code: d.code,
      kind: "approval" as const,
      approvals: { [approved[0].id]: false },
    }));
    const r = await as(ADMIN, () => submitResults(electionId, forgedResults, forgedDisclosures));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("模式");
  }, 60_000);

  it("名冊在投票開始後不可刪除（避免投票率對不上）", async () => {
    const slug = "roster-lock";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);

    const voter = await prisma.voter.findFirstOrThrow({ where: { electionId } });
    const before = await as(ADMIN, () => removeVoter(electionId, voter.id));
    expect(before.ok, "投票前應該可以刪").toBe(true);

    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "voting");
    const after = await prisma.voter.findFirstOrThrow({ where: { electionId } });
    const r = await as(ADMIN, () => removeVoter(electionId, after.id));
    expect(r.ok).toBe(false);
  }, 60_000);
});

describe("狀態機與名單鎖定", () => {
  it("投票開始後不能再核准候選人", async () => {
    const slug = "lock-candidates";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "voting");

    const other = await prisma.candidate.create({
      data: {
        electionId,
        members: [{ name: "偷渡者", email: "x@test.local", grade: "一年級" }],
        platform: "x",
        status: "pending",
        createdBy: "x@test.local",
      },
    });
    const r = await as(ADMIN, () => approveCandidate(electionId, other.id));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("鎖定");
  }, 60_000);

  it("沒有金鑰不能開放投票（否則選票無法加密）", async () => {
    const slug = "no-key";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    const r = await as(ADMIN, () => advanceStatus(electionId));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("金鑰");
  }, 60_000);

  it("金鑰只能產生一次（重產會讓已下載的金鑰檔失效）", async () => {
    const created = await makeElection({ slug: "key-once" });
    const electionId = created.electionId!;
    await generateKeys(electionId, "key-once");
    await expect(generateKeys(electionId, "key-once")).rejects.toThrow(/已有開票金鑰/);
  });

  it("未截止不能彌封", async () => {
    const slug = "seal-early";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await expect(seal(electionId)).rejects.toThrow(/已截止/);
  }, 60_000);

  it("投票期間結束後就不收票", async () => {
    const slug = "window-closed";
    // 窗口在開放投票當下必須還沒過去（見 D12-1 的新閘門），所以先用預設（未來）窗口正常
    // 推進到 voting，「已截止」的情境改成推進之後才把 votingEndsAt 撥回過去來模擬。
    const created = await makeElection({ slug });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await prisma.election.update({
      where: { id: electionId },
      data: { votingEndsAt: new Date(Date.now() - HOUR) },
    });

    const r = await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("截止");
  }, 60_000);
});

describe("候選人登記", () => {
  it("同一人不能重複登記", async () => {
    const slug = "dup-register";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await advanceTo(electionId, "registration");
    expect((await registerAs(slug, electionId, CAND)).ok).toBe(true);
    const second = await registerAs(slug, electionId, CAND);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("已經登記");
  });

  it("登記期間以外不能登記", async () => {
    const slug = "register-closed";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const r = await registerAs(slug, electionId, CAND); // 還在 draft
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("登記期間");
  });

  it("大頭照必填（§26-1 Ⅶ 一：選票要載明相片）", async () => {
    const slug = "photo-required";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    await advanceTo(electionId, "registration");
    const { registerCandidate } = await import("@/app/e/[slug]/register/actions");
    const { makeUploads } = await import("../helpers/flow");
    const { attachmentId } = await makeUploads(electionId, CAND);
    const r = await as(CAND, () =>
      registerCandidate(slug, {
        members: [{ name: "無照者", email: CAND.email, grade: "二年級", photo: "" }],
        platform: "政見",
        attachmentIds: [attachmentId],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("大頭照");
  });
});

/** sealElection 失敗時把原因印成字串——ok:false 有兩種形狀，斷言訊息不能只挑一種。 */
function sealFailureReason(r: { ok: false; error: string } | { ok: false; needsConfirm: true; ballots: number }) {
  return "error" in r ? r.error : `未預期的 needsConfirm（${r.ballots} 張票）`;
}

describe("D3-2 小票匭彌封前需二次確認（避免公開明細變相具名）", () => {
  it("1 張票時不帶 confirm 回 needsConfirm 且不彌封，帶 confirm 才真的彌封", async () => {
    const slug = "seal-confirm-small";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await advanceTo(electionId, "closed");

    const r1 = await as(ADMIN, () => sealElection(electionId));
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect("needsConfirm" in r1 ? r1.needsConfirm : undefined).toBe(true);
      expect("ballots" in r1 ? r1.ballots : undefined).toBe(1);
    }
    const stillClosed = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(stillClosed.status).toBe("closed");

    const r2 = await as(ADMIN, () => sealElection(electionId, true));
    expect(r2.ok, r2.ok ? "" : sealFailureReason(r2)).toBe(true);
    const sealed = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(sealed.status).toBe("sealed");
  }, 60_000);

  it("5 張票不需要 confirm，直接彌封成功", async () => {
    const slug = "seal-confirm-enough";
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug);
    const voters = Array.from({ length: 5 }, (_, i) => ({
      email: `sc-v${i}@test.local`,
      name: `投票人${i}`,
    }));
    await importVoters(electionId, [...voters, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");
    for (const v of voters) {
      const r = await voteAs(slug, electionId, v, publicKeyJwk, {
        type: "approval",
        approvals: { [cand.id]: true },
      });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
    await advanceTo(electionId, "closed");

    const r = await as(ADMIN, () => sealElection(electionId));
    expect(r.ok, r.ok ? "" : sealFailureReason(r)).toBe(true);
    const sealed = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(sealed.status).toBe("sealed");
  }, 60_000);
});

describe("D14-1 投票中重辦需超級管理員附理由", () => {
  async function setupVotingWithOneBallot(slug: string) {
    const created = await makeElection({ slug });
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug, 1);
    await importVoters(electionId, [VOTER_A]);
    await advanceTo(electionId, "registration");
    const reg = await registerAs(slug, electionId, CAND);
    if (!reg.ok) throw new Error(`候選人登記失敗：${reg.error}`);
    await approveAll(electionId);
    await advanceTo(electionId, "campaigning");
    await advanceTo(electionId, "voting");

    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId } });
    const cast = await voteAs(slug, electionId, VOTER_A, publicKeyJwk, {
      type: "approval",
      approvals: { [candidate.id]: true },
    });
    expect(cast.ok, `投票應該成功：${JSON.stringify(cast)}`).toBe(true);
    return electionId;
  }

  it("voting 狀態下一般管理員重辦被拒絕，來源場次不會被隱藏", async () => {
    const electionId = await setupVotingWithOneBallot("d14-redo-voting-mod");

    const redo = await as(MODERATOR, () => redoElection(electionId));
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.error).toContain("1 張票");
    expect(redo.error).toContain("超級管理員");

    const source = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(source.hiddenAt, "一般管理員被拒絕時，來源場次不能被隱藏").toBeNull();
  });

  it("voting 狀態下超級管理員不附理由一樣被拒絕", async () => {
    const electionId = await setupVotingWithOneBallot("d14-redo-voting-noreason");

    const redo = await as(ADMIN, () => redoElection(electionId));
    expect(redo.ok).toBe(false);
    if (redo.ok) return;
    expect(redo.error).toContain("超級管理員");

    const source = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(source.hiddenAt).toBeNull();
  });

  it("voting 狀態下超級管理員附理由才能重辦，且 audit log 記下理由與作廢票數", async () => {
    const electionId = await setupVotingWithOneBallot("d14-redo-voting-ok");

    const redo = await as(ADMIN, () => redoElection(electionId, "金鑰檔損毀，確認遺失"));
    expect(redo.ok, redo.ok ? "" : redo.error).toBe(true);
    if (!redo.ok) return;

    const source = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
    expect(source.hiddenAt, "超管附理由成功後，來源場次應該被隱藏").not.toBeNull();

    const log = await prisma.electionAuditLog.findFirst({
      where: { electionId, action: "redo_election" },
      orderBy: { createdAt: "desc" },
    });
    const diff = log?.diff as { reason?: string; voidedBallotCount?: number } | null;
    expect(diff?.reason).toBe("金鑰檔損毀，確認遺失");
    expect(diff?.voidedBallotCount).toBe(1);
  });
});

// toLocalInput 是 helper 的一部分，這裡順手把它的時區行為釘住——
// 它錯了會讓上面所有「投票期間」的測試都在測錯的東西。
describe("測試 helper 自身", () => {
  it("toLocalInput 產出的字串被 z.coerce.date 解回同一個本地時間", () => {
    const d = new Date(2026, 8, 4, 13, 45, 0, 0);
    const parsed = new Date(toLocalInput(d));
    expect(parsed.getTime()).toBe(d.getTime());
  });
});

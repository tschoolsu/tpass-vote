// 法規約束的負面測試：這些是「不該發生的事必須被擋下來」。
// 條號對應《臺北市數位實驗高級中等學校學生會選舉罷免條例》第三版。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, VOTER_A, VOTER_B, as } from "../helpers/session";
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
import { advanceStatus } from "@/app/admin/elections/[id]/actions";
import { submitResults } from "@/app/admin/elections/[id]/tally/actions";
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
    const start = new Date(Date.now() - 72 * HOUR);
    const created = await makeElection({ slug, votingStartsAt: start, votingHours: 48 });
    expect(created.ok, created.error).toBe(true);
    const electionId = created.electionId!;
    const { publicKeyJwk } = await generateKeys(electionId, slug);
    await importVoters(electionId, [VOTER_A, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    await advanceTo(electionId, "voting");

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

// toLocalInput 是 helper 的一部分，這裡順手把它的時區行為釘住——
// 它錯了會讓上面所有「投票期間」的測試都在測錯的東西。
describe("測試 helper 自身", () => {
  it("toLocalInput 產出的字串被 z.coerce.date 解回同一個本地時間", () => {
    const d = new Date(2026, 8, 4, 13, 45, 0, 0);
    const parsed = new Date(toLocalInput(d));
    expect(parsed.getTime()).toBe(d.getTime());
  });
});

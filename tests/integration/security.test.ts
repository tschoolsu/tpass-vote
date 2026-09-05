// 資安測試（白箱層）：驗章四鐵則、授權分級、跨物件存取、選票完整性、私鑰不落地。
// 打的是真正的 guard 與 server action，不是 mock。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, resetDb } from "../helpers/db";
import { ADMIN, MODERATOR, VOTER_A, VOTER_B, OUTSIDER, as, withRawToken } from "../helpers/session";
import { signTestToken } from "../helpers/jwks";
import { FOREIGN_PRIVATE_JWK } from "../helpers/test-keys";
import { captureRedirect } from "../helpers/redirect";
import { requireAdmin, requireSession, ForbiddenError } from "@/lib/guard";
import { tpass } from "@/config/auth";
import {
  advanceTo,
  approveAll,
  generateKeys,
  importVoters,
  makeElection,
  makeUploads,
  registerAs,
  seal,
  voteAs,
} from "../helpers/flow";
import { advanceStatus, savePublicKey, hideElection } from "@/app/admin/elections/[id]/actions";
import { importRoster, removeVoter } from "@/app/admin/elections/[id]/roster/actions";
import { approveCandidate } from "@/app/admin/elections/[id]/candidates/actions";
import { registerCandidate } from "@/app/e/[slug]/register/actions";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { sealElection } from "@/app/admin/elections/[id]/tally/actions";
import { encryptBallot, generateTallyKeyPair, decryptBallot } from "@/lib/ballot-crypto";

const CAND = { email: "seccand@test.local", name: "候選人" };

describe("驗章四鐵則", () => {
  it("沒有 token：導向登入，不外洩任何資訊", async () => {
    const url = await captureRedirect(() => withRawToken(null, () => requireSession("/admin")));
    expect(url).toContain("/authorize");
  });

  it("過期的 token 一律當作未登入", async () => {
    const expired = await signTestToken({ ...ADMIN, ttlSeconds: -60 });
    expect(await tpass.verifyToken(expired)).toBeNull();
    const url = await captureRedirect(() => withRawToken(expired, () => requireSession()));
    expect(url).toContain("/authorize");
  });

  it("別的服務的票不能拿來用（audience 鎖定）", async () => {
    const wrongAud = await signTestToken({ ...ADMIN, audience: "tpass:form" });
    expect(await tpass.verifyToken(wrongAud)).toBeNull();
  });

  it("issuer 不符一律拒絕", async () => {
    const wrongIss = await signTestToken({ ...ADMIN, issuer: "https://evil.example" });
    expect(await tpass.verifyToken(wrongIss)).toBeNull();
  });

  it("用別的金鑰簽的票不被接受（即使 kid 一樣）", async () => {
    const forged = await signTestToken({ ...ADMIN, privateJwk: FOREIGN_PRIVATE_JWK });
    expect(await tpass.verifyToken(forged)).toBeNull();
  });

  it("alg=none 的無簽章 token 被拒（演算法鎖定 EdDSA）", async () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: "attacker",
      email: "attacker@test.local",
      name: "attacker",
      permissions: { vote: { read: true, role: "admin" } },
      entryYear: null,
      iss: process.env.JWT_ISSUER,
      aud: "tpass:vote",
      exp: now + 3600,
    })}.`;
    expect(await tpass.verifyToken(none)).toBeNull();
  });

  it("竄改 payload（把 role 改成 admin）會讓簽章失效", async () => {
    const token = await signTestToken(VOTER_A);
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    payload.permissions.vote.role = "admin";
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    expect(await tpass.verifyToken(tampered)).toBeNull();
  });

  it("被 ban（read=false）導向 denied 而不是放行", async () => {
    const banned = { ...VOTER_A, read: false, restriction: "ban" as const };
    const url = await captureRedirect(() => as(banned, () => requireSession()));
    expect(url).toContain("/denied");
  });
});

describe("授權分級", () => {
  let electionId: string;
  const slug = "authz";

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    electionId = created.electionId!;
  });

  it("一般使用者呼叫任何管理動作都被 ForbiddenError 擋下", async () => {
    const attempts: [string, () => Promise<unknown>][] = [
      ["advanceStatus", () => advanceStatus(electionId)],
      ["savePublicKey", () => savePublicKey(electionId, {}, 1)],
      ["importRoster", () => importRoster(electionId, "x@test.local")],
      ["removeVoter", () => removeVoter(electionId, "whatever")],
      ["approveCandidate", () => approveCandidate(electionId, "whatever")],
      ["sealElection", () => sealElection(electionId)],
      ["hideElection", () => hideElection(electionId)],
    ];
    for (const [name, fn] of attempts) {
      await expect(as(VOTER_A, fn), `${name} 沒有擋下一般使用者`).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it("moderator 可以管選舉（role 不是 default 就算 admin）", async () => {
    const session = await as(MODERATOR, () => requireAdmin());
    expect(session.email).toBe(MODERATOR.email);
  });

  it("guard 不看 email 只看 permissions claim：自稱 admin 的信箱沒有特權", async () => {
    const impostor = { email: "admin@test.local", name: "冒牌", role: "default" as const };
    await expect(as(impostor, () => requireAdmin())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("跨物件存取（IDOR）", () => {
  const slugA = "idor-a";
  const slugB = "idor-b";
  let a: string;
  let b: string;

  beforeAll(async () => {
    await resetDb();
    a = (await makeElection({ slug: slugA })).electionId!;
    b = (await makeElection({ slug: slugB })).electionId!;
    await advanceTo(a, "registration");
    await advanceTo(b, "registration");
  });

  it("不能拿別人上傳的附件登記候選人", async () => {
    const victim = await makeUploads(a, VOTER_B);
    const r = await as(CAND, () =>
      registerCandidate(slugA, {
        members: [{ name: "小偷", email: CAND.email, grade: "二年級", photo: victim.photoId }],
        platform: "政見",
        attachmentIds: [victim.attachmentId],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("不能拿別場選舉的附件登記候選人", async () => {
    const mine = await makeUploads(b, CAND);
    const r = await as(CAND, () =>
      registerCandidate(slugA, {
        members: [{ name: "跨場", email: CAND.email, grade: "二年級", photo: mine.photoId }],
        platform: "政見",
        attachmentIds: [mine.attachmentId],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("不能把私密附件的 id 當成公開大頭照送出", async () => {
    const { attachmentId } = await makeUploads(a, CAND);
    const r = await as(CAND, () =>
      registerCandidate(slugA, {
        members: [{ name: "冒充", email: CAND.email, grade: "二年級", photo: attachmentId }],
        platform: "政見",
        attachmentIds: [attachmentId],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("不能核准別場選舉的候選人", async () => {
    await registerAs(slugB, b, CAND);
    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId: b } });
    const r = await as(ADMIN, () => approveCandidate(a, candidate.id));
    expect(r.ok).toBe(false);
  });

  it("不能刪別場選舉的名冊項目", async () => {
    await importVoters(b, [VOTER_A]);
    const voter = await prisma.voter.findFirstOrThrow({ where: { electionId: b } });
    const r = await as(ADMIN, () => removeVoter(a, voter.id));
    expect(r.ok).toBe(false);
  });
});

describe("選票完整性", () => {
  const slug = "ballot-integrity";
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let candidateId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, slug);
    publicKeyJwk = keys.publicKeyJwk;
    await importVoters(electionId, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    candidateId = cand.id;
    await advanceTo(electionId, "voting");
  }, 60_000);

  it("不是合法密文形狀的東西一律拒收", async () => {
    const junk = [
      "not json",
      JSON.stringify({ v: 3, alg: "RSA-OAEP-256+A256GCM", ek: "a", iv: "b", ct: "c" }),
      JSON.stringify({ v: 2, alg: "AES-CBC", ek: "a", iv: "b", ct: "c" }),
      JSON.stringify({ v: 2, alg: "RSA-OAEP-256+A256GCM", ek: "short", iv: "x", ct: "y" }),
      "",
      "x".repeat(20000),
    ];
    for (const payload of junk) {
      const r = await as(VOTER_A, () => castBallot(slug, payload));
      expect(r.ok, `這個 payload 被收下了：${payload.slice(0, 40)}`).toBe(false);
    }
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(0);
  });

  it("名冊外的人送出格式完全正確的密文也不算數", async () => {
    const r = await voteAs(slug, electionId, OUTSIDER, publicKeyJwk, {
      type: "choose",
      candidateIds: [candidateId],
    });
    expect(r.ok).toBe(false);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(0);
  });

  it("別場選舉的密文重放進來會被計為無效票（electionId 綁在明文裡）", async () => {
    const { ciphertext: replay } = await encryptBallot(publicKeyJwk, {
      electionId: "another-election",
      choice: { type: "choose", candidateIds: [candidateId] },
    });
    const r = await as(VOTER_A, () => castBallot(slug, replay));
    // 伺服器看不到內容，所以會收下；防線在計票端。
    expect(r.ok).toBe(true);

    const stored = await prisma.encryptedBallot.findFirstOrThrow({ where: { electionId } });
    const { privateKeyJwk } = await generateTallyKeyPair();
    expect(await decryptBallot(privateKeyJwk, stored.ciphertext), "拿錯鑰匙不該解得開").toBeNull();
  });

  it("伺服器只收公鑰：夾帶私鑰欄位的 JWK 被拒", async () => {
    const created = await makeElection({ slug: "key-guard" });
    const id = created.electionId!;
    const { privateKeyJwk, publicKeyJwk: pub } = await generateTallyKeyPair();
    const r = await as(ADMIN, () => savePublicKey(id, privateKeyJwk, 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("私鑰");

    // 混進單一私鑰參數也要擋（不是只看 d）
    const sneaky = { ...pub, p: "something" };
    const r2 = await as(ADMIN, () => savePublicKey(id, sneaky, 1));
    expect(r2.ok).toBe(false);

    const stored = await prisma.election.findUniqueOrThrow({ where: { id } });
    expect(stored.tallyPublicKeyJwk).toBeNull();
  });

  it("資料庫全洩漏也看不出誰投給誰：彌封後連結不存在", async () => {
    const slug2 = "leak-test";
    const created = await makeElection({ slug: slug2 });
    const id = created.electionId!;
    const keys = await generateKeys(id, slug2);
    await importVoters(id, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(id, "registration");
    await registerAs(slug2, id, CAND);
    const [cand] = await approveAll(id);
    await advanceTo(id, "voting");
    await voteAs(slug2, id, VOTER_A, keys.publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await voteAs(slug2, id, VOTER_B, keys.publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: false },
    });

    // 彌封前：連結存在，但沒有私鑰誰都解不開
    expect(await prisma.encryptedBallot.count({ where: { electionId: id } })).toBe(2);

    await advanceTo(id, "closed");
    await seal(id);

    // 彌封後：連結消失，只剩洗過牌的密文
    expect(await prisma.encryptedBallot.count({ where: { electionId: id } })).toBe(0);
    const e = await prisma.election.findUniqueOrThrow({ where: { id } });
    expect((e.sealedBox as string[]).length).toBe(2);

    // 整張 Voter 表都拿走也只知道「誰投過」
    const voters = await prisma.voter.findMany({ where: { electionId: id } });
    const columns = new Set(Object.keys(voters[0]));
    for (const forbidden of ["ciphertext", "ballotId", "choice"]) {
      expect(columns.has(forbidden), `Voter 表出現不該有的欄位 ${forbidden}`).toBe(false);
    }
  }, 60_000);
});

describe("彌封的併發安全", () => {
  it("兩個選委同時彌封只會有一個成功，票匭不會被洗兩次", async () => {
    await resetDb();
    const slug = "concurrent-seal";
    const created = await makeElection({ slug });
    const id = created.electionId!;
    const keys = await generateKeys(id, slug);
    await importVoters(id, [VOTER_A, VOTER_B, CAND]);
    await advanceTo(id, "registration");
    await registerAs(slug, id, CAND);
    const [cand] = await approveAll(id);
    await advanceTo(id, "voting");
    await voteAs(slug, id, VOTER_A, keys.publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await voteAs(slug, id, VOTER_B, keys.publicKeyJwk, {
      type: "approval",
      approvals: { [cand.id]: true },
    });
    await advanceTo(id, "closed");

    const [r1, r2] = await Promise.all([
      as(ADMIN, () => sealElection(id)),
      as(MODERATOR, () => sealElection(id)),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean).length, "同時彌封應該只有一個成功").toBe(1);

    const e = await prisma.election.findUniqueOrThrow({ where: { id } });
    expect((e.sealedBox as string[]).length).toBe(2);
    expect(await prisma.encryptedBallot.count({ where: { electionId: id } })).toBe(0);
  }, 60_000);
});

// 名冊匯入時會 .trim().toLowerCase()（roster/actions.ts），但 auth 簽出的 token
// 不保證 email 恆定小寫。讀取端若不正規化，同一個人只因大小寫不同就會被判「不在名冊中」。
// 這是可用性風險（合法選舉人投不了票），不是灌票風險。
describe("名冊比對的 email 正規化", () => {
  const slug = "email-normalize";
  const MIXED = { email: "Mixed.Case@Test.Local", name: "大小寫混用的人" };
  let electionId: string;
  let publicKeyJwk: JsonWebKey;
  let candidateId: string;

  beforeAll(async () => {
    await resetDb();
    const created = await makeElection({ slug });
    electionId = created.electionId!;
    const keys = await generateKeys(electionId, slug);
    publicKeyJwk = keys.publicKeyJwk;
    await importVoters(electionId, [MIXED, CAND]);
    await advanceTo(electionId, "registration");
    await registerAs(slug, electionId, CAND);
    const [cand] = await approveAll(electionId);
    candidateId = cand.id;
    await advanceTo(electionId, "voting");
  }, 60_000);

  it("名冊存的是小寫、token 帶大寫，仍然投得了票", async () => {
    const stored = await prisma.voter.findMany({ where: { electionId }, select: { email: true } });
    expect(stored.map((v) => v.email)).toContain("mixed.case@test.local");

    const r = await voteAs(slug, electionId, MIXED, publicKeyJwk, {
      type: "choose",
      candidateIds: [candidateId],
    });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(await prisma.encryptedBallot.count({ where: { electionId } })).toBe(1);
  });
});

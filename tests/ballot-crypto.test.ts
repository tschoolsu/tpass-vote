import { describe, it, expect } from "vitest";
import {
  generateTallyKeyPair,
  makeKeyFiles,
  combineKeyFiles,
  encryptBallot,
  decryptBallot,
  isValidCiphertextShape,
  receiptOf,
  newBallotCode,
  type BallotInput,
} from "@/lib/ballot-crypto";

const input: BallotInput = {
  electionId: "election-1",
  choice: { type: "choose", candidateIds: ["cand-a"] },
};

/** 真實 id 是 cuid，長度 25。長度測試要用真實長度才有意義。 */
const cuid = (tag: string) => `c${tag}`.padEnd(25, "0").slice(0, 25);

describe("信封加密 round-trip", () => {
  it("加密後可用私鑰解回原文，代碼一併封在密文裡", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const { ciphertext, code } = await encryptBallot(publicKeyJwk, input);
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(await decryptBallot(privateKeyJwk, ciphertext)).toEqual({
      v: 2,
      electionId: input.electionId,
      code,
      choice: input.choice,
    });
  });

  it("同一張選票兩次加密產生不同密文與不同代碼", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const a = await encryptBallot(publicKeyJwk, input);
    const b = await encryptBallot(publicKeyJwk, input);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    expect(a.code).not.toEqual(b.code);
  });

  it("拿錯鑰匙解密回 null（計為無效票，不炸）", async () => {
    const a = await generateTallyKeyPair();
    const b = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(a.publicKeyJwk, input);
    expect(await decryptBallot(b.privateKeyJwk, ciphertext)).toBeNull();
  });

  it("密文被竄改解密回 null", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    const env = JSON.parse(ciphertext);
    env.ct = env.ct.slice(0, -8) + "AAAAAAAA";
    expect(await decryptBallot(privateKeyJwk, JSON.stringify(env))).toBeNull();
  });

  it("v1 舊格式一律解不開也收不下（格式已遷移，刻意不做相容）", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    const env = JSON.parse(ciphertext);
    env.v = 1;
    const downgraded = JSON.stringify(env);
    expect(isValidCiphertextShape(downgraded)).toBe(false);
    expect(await decryptBallot(privateKeyJwk, downgraded)).toBeNull();
  });
});

// 2-2：AES-GCM 密文長度 = 明文 + 16。不填充的話，光看密文長度就 100% 分辨得出
// 「這張是廢票還是有效票」與「圈了幾個人」——不需要任何金鑰。
describe("密文長度不洩漏選票內容", () => {
  it("不同投票內容的密文長度必須完全相同", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const E = cuid("election");
    const a = cuid("canda");
    const b = cuid("candb");
    const cases: BallotInput[] = [
      { electionId: E, choice: { type: "blank" } }, // 廢票——原本最穩定的洩漏
      { electionId: E, choice: { type: "choose", candidateIds: [a] } },
      { electionId: E, choice: { type: "choose", candidateIds: [a, b] } }, // 圈選人數
      { electionId: E, choice: { type: "approval", approvals: { [a]: true } } },
      { electionId: E, choice: { type: "approval", approvals: { [a]: false } } }, // 同意／不同意
      { electionId: E, choice: { type: "approval", approvals: { [a]: true, [b]: false } } },
    ];

    const whole = new Set<number>();
    const ctOnly = new Set<number>();
    for (const c of cases) {
      const { ciphertext } = await encryptBallot(publicKeyJwk, c);
      whole.add(ciphertext.length);
      ctOnly.add((JSON.parse(ciphertext) as { ct: string }).ct.length);
    }
    expect(whole.size, `密文整包長度不唯一：${[...whole]}`).toBe(1);
    expect(ctOnly.size, `AES 密文長度不唯一：${[...ctOnly]}`).toBe(1);
  });

  it("伺服器會拒收長度不對的密文（不變量不能只靠前端誠實）", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    expect(isValidCiphertextShape(ciphertext)).toBe(true);

    const env = JSON.parse(ciphertext);
    env.ct = env.ct.slice(0, 100);
    expect(isValidCiphertextShape(JSON.stringify(env))).toBe(false);
  });

  it("50 位候選人的同意票仍在上限內（實際選舉規模的安全邊際）", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const approvals: Record<string, boolean> = {};
    for (let i = 0; i < 50; i++) approvals[cuid(`cand${i}`)] = i % 2 === 0;
    const { ciphertext } = await encryptBallot(publicKeyJwk, {
      electionId: cuid("election"),
      choice: { type: "approval", approvals },
    });
    expect(await decryptBallot(privateKeyJwk, ciphertext)).not.toBeNull();
  });

  it("選票內容超出上限直接失敗，不會靜默截斷", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const approvals: Record<string, boolean> = {};
    for (let i = 0; i < 300; i++) approvals[cuid(`cand${i}`)] = true;
    await expect(
      encryptBallot(publicKeyJwk, {
        electionId: cuid("election"),
        choice: { type: "approval", approvals },
      }),
    ).rejects.toThrow(/超出固定長度上限/);
  });
});

describe("金鑰檔分持", () => {
  it("單份金鑰檔可還原私鑰", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const files = makeKeyFiles(privateKeyJwk, "2026-president", 1);
    expect(files).toHaveLength(1);
    const restored = combineKeyFiles(files);
    const { ciphertext, code } = await encryptBallot(publicKeyJwk, input);
    expect(await decryptBallot(restored, ciphertext)).toMatchObject({ code });
  });

  it("兩份分持：兩份齊才能還原，單獨一份不行", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const files = makeKeyFiles(privateKeyJwk, "2026-president", 2);
    expect(files).toHaveLength(2);
    const restored = combineKeyFiles(files);
    const { ciphertext, code } = await encryptBallot(publicKeyJwk, input);
    expect(await decryptBallot(restored, ciphertext)).toMatchObject({ code });
    expect(() => combineKeyFiles([files[0]])).toThrow();
    expect(() => combineKeyFiles([files[0], files[0]])).toThrow();
  });

  it("拿不同場選舉的金鑰檔合併會被拒絕", async () => {
    const a = await generateTallyKeyPair();
    const b = await generateTallyKeyPair();
    const [fa] = makeKeyFiles(a.privateKeyJwk, "election-a", 2);
    const [, fb] = makeKeyFiles(b.privateKeyJwk, "election-b", 2);
    expect(() => combineKeyFiles([fa, fb])).toThrow(/不同場/);
  });
});

describe("伺服器端形狀檢查", () => {
  it("真密文通過、垃圾字串被拒", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    expect(isValidCiphertextShape(ciphertext)).toBe(true);
    expect(isValidCiphertextShape("")).toBe(false);
    expect(isValidCiphertextShape("not json")).toBe(false);
    expect(isValidCiphertextShape(JSON.stringify({ v: 2 }))).toBe(false);
    expect(isValidCiphertextShape("x".repeat(20000))).toBe(false);
  });

  it("ek 長度不是 RSA-2048 輸出（256 bytes）被拒", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    const env = JSON.parse(ciphertext);
    env.ek = btoa("short");
    expect(isValidCiphertextShape(JSON.stringify(env))).toBe(false);
  });
});

describe("可回溯代碼", () => {
  it("newBallotCode 是 12 碼 hex 且不重複", () => {
    const codes = new Set(Array.from({ length: 500 }, () => newBallotCode()));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{12}$/);
  });

  it("receiptOf 仍是密文 sha256 前 12 碼（只用於解不開的票）", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    expect(await receiptOf(ciphertext)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("伺服器拿不到代碼：代碼不出現在密文字串裡", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext, code } = await encryptBallot(publicKeyJwk, input);
    expect(ciphertext).not.toContain(code);
    expect(await receiptOf(ciphertext)).not.toBe(code);
  });
});

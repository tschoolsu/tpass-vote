import { describe, it, expect } from "vitest";
import {
  generateTallyKeyPair,
  makeKeyFiles,
  combineKeyFiles,
  encryptBallot,
  decryptBallot,
  isValidCiphertextShape,
  receiptOf,
  type BallotPlain,
} from "@/lib/ballot-crypto";

const plain: BallotPlain = {
  v: 1,
  electionId: "election-1",
  choice: { type: "choose", candidateIds: ["cand-a"] },
};

describe("信封加密 round-trip", () => {
  it("加密後可用私鑰解回原文", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const ciphertext = await encryptBallot(publicKeyJwk, plain);
    expect(await decryptBallot(privateKeyJwk, ciphertext)).toEqual(plain);
  });

  it("同一張選票兩次加密產生不同密文（防內容比對）", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const c1 = await encryptBallot(publicKeyJwk, plain);
    const c2 = await encryptBallot(publicKeyJwk, plain);
    expect(c1).not.toEqual(c2);
  });

  it("拿錯鑰匙解密回 null（計為無效票，不炸）", async () => {
    const a = await generateTallyKeyPair();
    const b = await generateTallyKeyPair();
    const ciphertext = await encryptBallot(a.publicKeyJwk, plain);
    expect(await decryptBallot(b.privateKeyJwk, ciphertext)).toBeNull();
  });

  it("密文被竄改解密回 null", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const env = JSON.parse(await encryptBallot(publicKeyJwk, plain));
    env.ct = env.ct.slice(0, -8) + "AAAAAAAA";
    expect(await decryptBallot(privateKeyJwk, JSON.stringify(env))).toBeNull();
  });
});

describe("金鑰檔分持", () => {
  it("單份金鑰檔可還原私鑰", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const files = makeKeyFiles(privateKeyJwk, "2026-president", 1);
    expect(files).toHaveLength(1);
    const restored = combineKeyFiles(files);
    const ciphertext = await encryptBallot(publicKeyJwk, plain);
    expect(await decryptBallot(restored, ciphertext)).toEqual(plain);
  });

  it("兩份分持：兩份齊才能還原，單獨一份不行", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const files = makeKeyFiles(privateKeyJwk, "2026-president", 2);
    expect(files).toHaveLength(2);
    const restored = combineKeyFiles(files);
    const ciphertext = await encryptBallot(publicKeyJwk, plain);
    expect(await decryptBallot(restored, ciphertext)).toEqual(plain);
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
    const ciphertext = await encryptBallot(publicKeyJwk, plain);
    expect(isValidCiphertextShape(ciphertext)).toBe(true);
    expect(isValidCiphertextShape("")).toBe(false);
    expect(isValidCiphertextShape("not json")).toBe(false);
    expect(isValidCiphertextShape(JSON.stringify({ v: 1 }))).toBe(false);
    expect(isValidCiphertextShape("x".repeat(20000))).toBe(false);
  });

  it("ek 長度不是 RSA-2048 輸出（256 bytes）被拒", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const env = JSON.parse(await encryptBallot(publicKeyJwk, plain));
    env.ek = btoa("short");
    expect(isValidCiphertextShape(JSON.stringify(env))).toBe(false);
  });
});

describe("收據", () => {
  it("是密文 sha256 前 12 碼（hex）", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const ciphertext = await encryptBallot(publicKeyJwk, plain);
    const r = await receiptOf(ciphertext);
    expect(r).toMatch(/^[0-9a-f]{12}$/);
  });
});

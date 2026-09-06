import { describe, it, expect } from "vitest";
import {
  generateTallyKeyPair,
  makeKeyFiles,
  combineKeyFiles,
  encryptBallot,
  decryptBallot,
  isValidCiphertextShape,
  canonicalizeCiphertext,
  fallbackCodeFor,
  newBallotCode,
  sha256Hex,
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

  // D3-3：choose 模式下 candidateIds 是投票人點選的先後順序，原封不動封進明文，
  // 解密後原封不動印在公開明細上——順序本身是多餘資訊，可能成為指紋。加密時應
  // 正規化（排序）掉這個順序，讓「同一組人、不同點法」解密回同一個陣列。
  it("choose 模式：同一組候選人不同點選順序，解密後 candidateIds 相同且排序", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const a = cuid("a");
    const b = cuid("b");
    const c = cuid("c");
    const sorted = [a, b, c].sort();
    const orders: BallotInput[] = [
      { electionId: "election-1", choice: { type: "choose", candidateIds: [a, b, c] } },
      { electionId: "election-1", choice: { type: "choose", candidateIds: [c, b, a] } },
      { electionId: "election-1", choice: { type: "choose", candidateIds: [b, a, c] } },
    ];
    for (const o of orders) {
      const { ciphertext } = await encryptBallot(publicKeyJwk, o);
      const plain = await decryptBallot(privateKeyJwk, ciphertext);
      expect(plain?.choice).toEqual({ type: "choose", candidateIds: sorted });
    }
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

  // D3-4：JSON 允許物件內任意空白、重複 key（取最後一個）、欄位順序、多餘欄位——
  // 這些都是「合法的 JSON」，光數 key 數量擋不住。真正的防線是 canonicalizeCiphertext
  // 把信封重建成固定欄位、固定順序、無多餘空白的正規字串，讓這整類花招帶進來的
  // 多餘位元組沒有機會被存下來（見 castBallot：存的是這個函式的回傳值，不是
  // client 送來的原始字串）。
  it("canonicalizeCiphertext 把多餘欄位、重新排版過的信封收斂成同一個正規字串", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    const env = JSON.parse(ciphertext);

    // 多一個未知欄位：形狀仍合法（5 個已知欄位都對），但正規化後那個欄位消失。
    const withExtra = JSON.stringify({ ...env, extra: "x".repeat(5000) });
    expect(isValidCiphertextShape(withExtra)).toBe(true);
    expect(canonicalizeCiphertext(withExtra)).toBe(ciphertext);

    // 欄位順序不同：正規化後與原始密文逐字相同。
    const reordered = JSON.stringify({ ct: env.ct, iv: env.iv, ek: env.ek, alg: env.alg, v: env.v });
    expect(canonicalizeCiphertext(reordered)).toBe(ciphertext);

    // 開頭塞大量空白：JSON 語法合法，但正規化後空白不見，長度回到原本大小。
    const padded = "{" + " ".repeat(5000) + ciphertext.slice(1);
    expect(canonicalizeCiphertext(padded)).toBe(ciphertext);
  });

  it("canonicalizeCiphertext 對真正不合法的形狀回傳 null", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    const env = JSON.parse(ciphertext);
    env.ek = btoa("short");
    expect(canonicalizeCiphertext(JSON.stringify(env))).toBeNull();
    expect(canonicalizeCiphertext("not json")).toBeNull();
    expect(canonicalizeCiphertext("")).toBeNull();
  });
});

describe("可回溯代碼", () => {
  it("newBallotCode 是 12 碼 hex 且不重複", () => {
    const codes = new Set(Array.from({ length: 500 }, () => newBallotCode()));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{12}$/);
  });

  it("伺服器拿不到代碼：代碼不在密文字串裡，也算不出來", async () => {
    const { publicKeyJwk } = await generateTallyKeyPair();
    const { ciphertext, code } = await encryptBallot(publicKeyJwk, input);
    expect(ciphertext).not.toContain(code);
    // 密文雜湊是彌封前 DB 讀取者唯一算得出來的東西，它不等於代碼。
    expect((await sha256Hex(ciphertext)).slice(0, 12)).not.toBe(code);
  });

  // 解不開的票沒有內部代碼，明細仍需要代碼欄位。如果那個 fallback 是密文雜湊，
  // 有 DB 讀權限的人就能算出來反查回 voterId——而且只要有寫權限、把某張票改壞
  // 一個 byte，就能把「特定一個人」推進這條路徑再精準反查。
  it("解不開的票：代碼靠私鑰派生，沒有私鑰的人算不出來", async () => {
    const a = await generateTallyKeyPair();
    const b = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(a.publicKeyJwk, input);

    const code = await fallbackCodeFor(a.privateKeyJwk, ciphertext);
    expect(code).toMatch(/^[0-9a-f]{12}$/);
    expect(
      (await sha256Hex(ciphertext)).slice(0, 12),
      "fallback 代碼可以用純雜湊算出來，去匿名化防線破了",
    ).not.toBe(code);
    expect(await fallbackCodeFor(b.privateKeyJwk, ciphertext)).not.toBe(code);
  });

  it("解不開的票：兩位選委拿同一把私鑰會算出同一個代碼（明細才對得起來）", async () => {
    const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
    const { ciphertext } = await encryptBallot(publicKeyJwk, input);
    expect(await fallbackCodeFor(privateKeyJwk, ciphertext)).toBe(
      await fallbackCodeFor(privateKeyJwk, ciphertext),
    );
  });
});

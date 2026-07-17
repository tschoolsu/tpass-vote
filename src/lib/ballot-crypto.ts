// 雙信封制選票加密核心。
//
// 這個模組必須同時能在「瀏覽器」與「Node（server action / 測試）」執行，
// 所以只用 WebCrypto（globalThis.crypto），禁止 import "server-only" 或 node:crypto。
//
// 職責邊界（違反就是資安事故）：
// - 開票私鑰只存在於選委瀏覽器與下載的金鑰檔，永遠不得出現在任何送往伺服器的
//   payload、log、cookie、localStorage。
// - 伺服器端只允許用到 isValidCiphertextShape / sha256Hex（不碰金鑰）。

export type BallotChoice =
  | { type: "choose"; candidateIds: string[] } // 超額：單記/限記相對多數
  | { type: "approval"; approvals: Record<string, boolean> } // 同額：每人同意/不同意
  | { type: "blank" }; // 自主廢票

export interface BallotPlain {
  v: 1;
  electionId: string; // 綁定選舉，防止密文跨場重放
  choice: BallotChoice;
}

/** 密文外層格式（存 DB 的字串就是這個 JSON）。 */
interface CiphertextEnvelope {
  v: 1;
  alg: "RSA-OAEP-256+A256GCM";
  ek: string; // base64：RSA-OAEP 包住的 AES-256 金鑰
  iv: string; // base64：AES-GCM IV（12 bytes）
  ct: string; // base64：AES-GCM 密文（含 tag）
}

/** 下載給選委保管的金鑰檔。shares=2 時為 XOR 兩份分持，兩份齊才能開票。 */
export interface TallyKeyFile {
  v: 1;
  type: "tvote-tally-key";
  election: string; // slug，防拿錯場次的鑰匙
  share: number; // 1-based
  shares: 1 | 2;
  data: string; // base64；shares=1 是私鑰 JWK JSON，shares=2 是 XOR 份
}

const subtle = () => globalThis.crypto.subtle;

// ---- base64 / hex（瀏覽器與 Node 通用，不依賴 Buffer）----

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 投票收據＝密文雜湊前 12 碼。只能證明「這張密文在票匭裡」，證明不了內容。 */
export async function receiptOf(ciphertext: string): Promise<string> {
  return (await sha256Hex(ciphertext)).slice(0, 12);
}

// ---- 金鑰生命週期（只在選委瀏覽器執行）----

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

export async function generateTallyKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}> {
  const pair = await subtle().generateKey(RSA_PARAMS, true, ["encrypt", "decrypt"]);
  return {
    publicKeyJwk: await subtle().exportKey("jwk", pair.publicKey),
    privateKeyJwk: await subtle().exportKey("jwk", pair.privateKey),
  };
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.length !== b.length) throw new Error("XOR 份長度不一致");
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** 私鑰序列化成 1 或 2 份金鑰檔。2 份＝XOR 分持，單獨一份不含任何可用資訊。 */
export function makeKeyFiles(
  privateKeyJwk: JsonWebKey,
  electionSlug: string,
  shares: 1 | 2,
): TallyKeyFile[] {
  const bytes = new TextEncoder().encode(JSON.stringify(privateKeyJwk));
  const base = { v: 1 as const, type: "tvote-tally-key" as const, election: electionSlug, shares };
  if (shares === 1) return [{ ...base, share: 1, data: toB64(bytes) }];
  const pad = globalThis.crypto.getRandomValues(new Uint8Array(bytes.length));
  return [
    { ...base, share: 1, data: toB64(pad) },
    { ...base, share: 2, data: toB64(xorBytes(bytes, pad)) },
  ];
}

/** 合併金鑰檔還原私鑰 JWK。檔案不合規/場次不符/份數不齊都直接 throw。 */
export function combineKeyFiles(files: TallyKeyFile[]): JsonWebKey {
  if (files.length === 0) throw new Error("沒有金鑰檔");
  for (const f of files) {
    if (f.v !== 1 || f.type !== "tvote-tally-key") throw new Error("不是 T-Vote 金鑰檔");
    if (f.election !== files[0].election) throw new Error("金鑰檔屬於不同場選舉");
    if (f.shares !== files[0].shares) throw new Error("金鑰檔份數設定不一致");
  }
  const shares = files[0].shares;
  let bytes: Uint8Array;
  if (shares === 1) {
    bytes = fromB64(files[0].data);
  } else {
    const [a, b] = files;
    if (files.length !== 2 || !a || !b || a.share === b.share) {
      throw new Error("兩份分持需要兩份不同的金鑰檔");
    }
    bytes = xorBytes(fromB64(a.data), fromB64(b.data));
  }
  const jwk = JSON.parse(new TextDecoder().decode(bytes)) as JsonWebKey;
  if (jwk.kty !== "RSA" || !jwk.d) throw new Error("金鑰檔內容毀損");
  return jwk;
}

// ---- 信封加密（投票端：瀏覽器）----

export async function encryptBallot(
  publicKeyJwk: JsonWebKey,
  plain: BallotPlain,
): Promise<string> {
  const aesKey = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    new TextEncoder().encode(JSON.stringify(plain)),
  );
  const publicKey = await subtle().importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const ek = await subtle().encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    await subtle().exportKey("raw", aesKey),
  );
  const envelope: CiphertextEnvelope = {
    v: 1,
    alg: "RSA-OAEP-256+A256GCM",
    ek: toB64(ek),
    iv: toB64(iv),
    ct: toB64(ct),
  };
  return JSON.stringify(envelope);
}

// ---- 解密（開票端：選委瀏覽器）----

/** 解不開（毀損/亂造/拿錯鑰匙）一律回 null，由計票端計為無效票。 */
export async function decryptBallot(
  privateKeyJwk: JsonWebKey,
  ciphertext: string,
): Promise<BallotPlain | null> {
  try {
    const env = JSON.parse(ciphertext) as CiphertextEnvelope;
    if (env.v !== 1 || env.alg !== "RSA-OAEP-256+A256GCM") return null;
    const privateKey = await subtle().importKey(
      "jwk",
      privateKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const rawAes = await subtle().decrypt({ name: "RSA-OAEP" }, privateKey, fromB64(env.ek));
    const aesKey = await subtle().importKey("raw", rawAes, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: fromB64(env.iv) },
      aesKey,
      fromB64(env.ct),
    );
    const plain = JSON.parse(new TextDecoder().decode(pt)) as BallotPlain;
    if (plain.v !== 1 || typeof plain.electionId !== "string" || !plain.choice) return null;
    return plain;
  } catch {
    return null;
  }
}

// ---- 伺服器端形狀檢查（收票時的 sanity check，不碰金鑰）----

const MAX_CIPHERTEXT_LENGTH = 16384;

export function isValidCiphertextShape(s: string): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_CIPHERTEXT_LENGTH) return false;
  let env: CiphertextEnvelope;
  try {
    env = JSON.parse(s) as CiphertextEnvelope;
  } catch {
    return false;
  }
  return (
    env !== null &&
    typeof env === "object" &&
    env.v === 1 &&
    env.alg === "RSA-OAEP-256+A256GCM" &&
    typeof env.ek === "string" &&
    B64_RE.test(env.ek) &&
    fromB64Length(env.ek) === 256 && // RSA-2048 輸出固定 256 bytes
    typeof env.iv === "string" &&
    B64_RE.test(env.iv) &&
    fromB64Length(env.iv) === 12 &&
    typeof env.ct === "string" &&
    B64_RE.test(env.ct) &&
    fromB64Length(env.ct) >= 16 // 至少要有 GCM tag
  );
}

function fromB64Length(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

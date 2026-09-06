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
  v: 2;
  electionId: string; // 綁定選舉，防止密文跨場重放
  code: string; // §26-1 Ⅳ 的可回溯代碼。由投票人瀏覽器產生，只存在於加密後的明文裡
  choice: BallotChoice;
}

/** encryptBallot 的輸入：代碼由它自己產生，呼叫端給不了也不必給。 */
export interface BallotInput {
  electionId: string;
  choice: BallotChoice;
}

/** 密文外層格式（存 DB 的字串就是這個 JSON）。 */
interface CiphertextEnvelope {
  v: 2;
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
const BALLOT_CODE_RE = /^[0-9a-f]{12}$/;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 可回溯代碼：12 碼 hex，投票當下由瀏覽器產生（§26-1 Ⅳ 要求投票時就提供）。 */
export function newBallotCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- 定長填充（消除密文長度側通道）----
//
// AES-GCM 密文長度 = 明文長度 + 16。不填充的話，光看密文長度就能 100% 分辨
// 「這張是廢票還是有效票」與「圈了幾個人」。所有明文一律填到同一個長度。
//
// 2048 的邊際：approval 模式每位候選人約佔 34 bytes（cuid 25 + 引號冒號布林），
// 骨架約 100 bytes ⇒ 50 位候選人約 1800 bytes。學生會選舉遠不會到這個量級。
const PADDED_PLAIN_SIZE = 2048;
const LENGTH_PREFIX = 4;

function padPlaintext(json: string): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(json);
  if (payload.length + LENGTH_PREFIX > PADDED_PLAIN_SIZE) {
    throw new Error(
      `選票內容 ${payload.length} bytes，超出固定長度上限 ${PADDED_PLAIN_SIZE - LENGTH_PREFIX}`,
    );
  }
  // 先整塊填隨機，再蓋上長度前綴與內容——尾端填充必須不可預測，否則等於沒填。
  const out = globalThis.crypto.getRandomValues(new Uint8Array(PADDED_PLAIN_SIZE));
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, LENGTH_PREFIX);
  return out;
}

function unpadPlaintext(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  if (bytes.length !== PADDED_PLAIN_SIZE) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (len > PADDED_PLAIN_SIZE - LENGTH_PREFIX) return null;
  return new TextDecoder().decode(bytes.subarray(LENGTH_PREFIX, LENGTH_PREFIX + len));
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

/**
 * 回傳密文與代碼。代碼在這裡產生、封進密文，並交給呼叫端當場顯示給投票人——
 * 伺服器全程看不到它，所以伺服器也無從建立「代碼↔選舉人」的對照表。
 */
export async function encryptBallot(
  publicKeyJwk: JsonWebKey,
  input: BallotInput,
): Promise<{ ciphertext: string; code: string }> {
  const code = newBallotCode();
  // choose 模式的 candidateIds 是投票人點選的先後順序，跟內容無關的多餘資訊，
  // 解密後會原封不動流進公開明細——不排序的話點選順序就是可指紋辨識的側通道。
  const choice: BallotChoice =
    input.choice.type === "choose"
      ? { type: "choose", candidateIds: [...input.choice.candidateIds].sort() }
      : input.choice;
  const plain: BallotPlain = { v: 2, electionId: input.electionId, code, choice };
  const aesKey = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    padPlaintext(JSON.stringify(plain)),
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
    v: 2,
    alg: "RSA-OAEP-256+A256GCM",
    ek: toB64(ek),
    iv: toB64(iv),
    ct: toB64(ct),
  };
  return { ciphertext: JSON.stringify(envelope), code };
}

// ---- 解密（開票端：選委瀏覽器）----

/**
 * 解不開的票（毀損／亂造）沒有內部代碼，但明細仍需要代碼欄位。
 *
 * **絕對不能用密文雜湊當這個 fallback**：那樣彌封前有 DB 讀權限的人就能自己算出來，
 * 與公告後的公開明細 join 回 voterId——正是整套設計要擋的事。更糟的是，有寫權限的人
 * 只要把某張票改壞一個 byte，就能把「特定一個人」推進這條路徑再精準反查。
 *
 * 改用開票私鑰派生的 HMAC：兩位選委各自開票算得出同一個值（明細才對得起來，
 * 見 docs/election-sop.md 的雙人比對），沒有私鑰的人算不出來。
 */
export async function fallbackCodeFor(
  privateKeyJwk: JsonWebKey,
  ciphertext: string,
): Promise<string> {
  const seed = await subtle().digest("SHA-256", new TextEncoder().encode(privateKeyJwk.d ?? ""));
  const key = await subtle().importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle().sign("HMAC", key, new TextEncoder().encode(ciphertext));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** 解不開（毀損/亂造/拿錯鑰匙）一律回 null，由計票端計為無效票。 */
export async function decryptBallot(
  privateKeyJwk: JsonWebKey,
  ciphertext: string,
): Promise<BallotPlain | null> {
  try {
    const env = JSON.parse(ciphertext) as CiphertextEnvelope;
    if (env.v !== 2 || env.alg !== "RSA-OAEP-256+A256GCM") return null;
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
    const json = unpadPlaintext(pt);
    if (json === null) return null;
    const plain = JSON.parse(json) as BallotPlain;
    if (plain.v !== 2 || typeof plain.electionId !== "string" || !plain.choice) return null;
    // 代碼形狀不對的票一律當無效票：明細的代碼欄位有格式契約（disclosureSchema），
    // 讓畸形代碼流進去會讓整份明細被伺服器拒收，全場開不了票。
    if (typeof plain.code !== "string" || !BALLOT_CODE_RE.test(plain.code)) return null;
    return plain;
  } catch {
    return null;
  }
}

// ---- 伺服器端形狀檢查（收票時的 sanity check，不碰金鑰）----

const MAX_CIPHERTEXT_LENGTH = 16384;

/**
 * 驗證信封並回傳「重新序列化過」的正規字串；不合法回傳 null。
 *
 * JSON 允許物件內任意空白、重複 key（取最後一個）、欄位順序不影響語意——這些花招
 * 都是「合法的 JSON」，光數 key 數量或檢查欄位值擋不住。真正的防線不是想辦法在
 * 形狀檢查裡窮舉擋掉每一種花招，而是伺服器存進 DB／公開 sealedBox 的字串一律用
 * 這裡重建出來的正規字串，不是投票端送來的原始位元組——花招留下的多餘位元組
 * 從來沒有機會被存下來。
 */
export function canonicalizeCiphertext(s: string): string | null {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_CIPHERTEXT_LENGTH) return null;
  let env: CiphertextEnvelope;
  try {
    env = JSON.parse(s) as CiphertextEnvelope;
  } catch {
    return null;
  }
  if (
    env === null ||
    typeof env !== "object" ||
    env.v !== 2 ||
    env.alg !== "RSA-OAEP-256+A256GCM" ||
    typeof env.ek !== "string" ||
    !B64_RE.test(env.ek) ||
    fromB64Length(env.ek) !== 256 || // RSA-2048 輸出固定 256 bytes
    typeof env.iv !== "string" ||
    !B64_RE.test(env.iv) ||
    fromB64Length(env.iv) !== 12 ||
    typeof env.ct !== "string" ||
    !B64_RE.test(env.ct) ||
    // 定長：AES-GCM 密文 = 填充後明文 + 16 bytes tag。長度不變量在伺服器這一關就
    // 強制，否則有人繞過前端送不等長密文，長度側通道就從那條路回來了。
    fromB64Length(env.ct) !== PADDED_PLAIN_SIZE + 16
  ) {
    return null;
  }
  return JSON.stringify({ v: env.v, alg: env.alg, ek: env.ek, iv: env.iv, ct: env.ct });
}

export function isValidCiphertextShape(s: string): boolean {
  return canonicalizeCiphertext(s) !== null;
}

function fromB64Length(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

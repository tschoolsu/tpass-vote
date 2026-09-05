// 開票端組合流程：金鑰檔 → 本地解密 → 計票。只准在「選委瀏覽器」執行。
// UI 層（開票頁）只需要呼叫這一個函式，不碰任何密碼學細節。

import { combineKeyFiles, decryptBallot, receiptOf, type TallyKeyFile } from "@/lib/ballot-crypto";
import { tallyBallots, type TallyResult } from "@/lib/tally";
import { buildDisclosures, type DisclosureEntry } from "@/lib/disclosure";

export interface TallyMeta {
  electionId: string;
  slug: string;
  ballotMode: "choose" | "approval";
  seats: number;
  maxChoices: number;
  candidateIds: string[];
  rosterCount: number;
}

/**
 * 金鑰檔不合規（拿錯場、份數不齊、毀損）會直接 throw，讓 UI 顯示錯誤。
 * 除了計票結果，同時產出 §26-1 Ⅳ/Ⅴ 要公告的「可回溯代碼↔去識別化個別意思」明細——
 * 明文本來就在手上，不必為了明細再解密一次。
 */
export async function decryptAndTally(
  keyFiles: TallyKeyFile[],
  sealedBox: string[],
  meta: TallyMeta,
): Promise<{ results: TallyResult; disclosures: DisclosureEntry[] }> {
  for (const f of keyFiles) {
    if (f.election !== meta.slug) {
      throw new Error(`金鑰檔屬於「${f.election}」，不是本場選舉（${meta.slug}）`);
    }
  }
  const privateKeyJwk = combineKeyFiles(keyFiles);
  const plaintexts = await Promise.all(
    sealedBox.map((ciphertext) => decryptBallot(privateKeyJwk, ciphertext)),
  );
  const results = tallyBallots({
    electionId: meta.electionId,
    ballotMode: meta.ballotMode,
    seats: meta.seats,
    maxChoices: meta.maxChoices,
    candidateIds: meta.candidateIds,
    plaintexts,
    rosterCount: meta.rosterCount,
  });
  // 代碼取自解密後的明文（投票人瀏覽器當初產生的那個）。解不開的票沒有內部代碼，
  // 退回密文雜湊當佔位——那種票本來就對應不到任何有效意思。
  const codes = await Promise.all(
    sealedBox.map(async (ciphertext, i) => plaintexts[i]?.code ?? (await receiptOf(ciphertext))),
  );
  const disclosures = buildDisclosures(
    codes,
    plaintexts,
    meta.electionId,
    meta.ballotMode,
    meta.candidateIds,
    meta.maxChoices,
  );
  return { results, disclosures };
}

// 開票端組合流程：金鑰檔 → 本地解密 → 計票。只准在「選委瀏覽器」執行。
// UI 層（開票頁）只需要呼叫這一個函式，不碰任何密碼學細節。

import { combineKeyFiles, decryptBallot, type TallyKeyFile } from "@/lib/ballot-crypto";
import { tallyBallots, type TallyResult } from "@/lib/tally";

export interface TallyMeta {
  electionId: string;
  slug: string;
  ballotMode: "choose" | "approval";
  seats: number;
  maxChoices: number;
  candidateIds: string[];
  rosterCount: number;
}

/** 金鑰檔不合規（拿錯場、份數不齊、毀損）會直接 throw，讓 UI 顯示錯誤。 */
export async function decryptAndTally(
  keyFiles: TallyKeyFile[],
  sealedBox: string[],
  meta: TallyMeta,
): Promise<TallyResult> {
  for (const f of keyFiles) {
    if (f.election !== meta.slug) {
      throw new Error(`金鑰檔屬於「${f.election}」，不是本場選舉（${meta.slug}）`);
    }
  }
  const privateKeyJwk = combineKeyFiles(keyFiles);
  const plaintexts = await Promise.all(
    sealedBox.map((ciphertext) => decryptBallot(privateKeyJwk, ciphertext)),
  );
  return tallyBallots({
    electionId: meta.electionId,
    ballotMode: meta.ballotMode,
    seats: meta.seats,
    maxChoices: meta.maxChoices,
    candidateIds: meta.candidateIds,
    plaintexts,
    rosterCount: meta.rosterCount,
  });
}

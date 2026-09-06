// 把「辦完一場選舉」拆成可組合的步驟，程序測試與資安測試共用。
//
// 每一步都走真正的 server action（不是直接寫 DB），所以流程測試順帶把授權、狀態機、
// 表單驗證全部走過一遍。只有「上傳檔案」例外——那需要 multipart 與 storage driver，
// 測試改成直接建 Upload 列，因為要測的是登記邏輯不是上傳本身。
import { prisma } from "@/lib/db";
import { createElection } from "@/app/admin/elections/new/actions";
import { savePublicKey, advanceStatus } from "@/app/admin/elections/[id]/actions";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";
import { registerCandidate } from "@/app/e/[slug]/register/actions";
import { approveCandidate } from "@/app/admin/elections/[id]/candidates/actions";
import { castBallot } from "@/app/e/[slug]/vote/actions";
import { sealElection, submitResults } from "@/app/admin/elections/[id]/tally/actions";
import { publishAnnouncement } from "@/app/admin/elections/[id]/announcements/actions";
import {
  encryptBallot,
  generateTallyKeyPair,
  makeKeyFiles,
  type BallotChoice,
  type TallyKeyFile,
} from "@/lib/ballot-crypto";
import { decryptAndTally } from "@/lib/tally-client";
import { as, ADMIN } from "./session";
import type { TestIdentity } from "./jwks";

export const HOUR = 3_600_000;

export interface ElectionSpec {
  slug: string;
  title?: string;
  kind?: "leader" | "grade_rep" | "other";
  seats?: number;
  maxChoices?: number;
  /** 投票期間長度（小時）。預設 48，剛好踩在 §26-1 Ⅱ 的下限。 */
  votingHours?: number;
  votingStartsAt?: Date;
}

/** 用 createElection action 建一場選舉（會走完整的表單驗證）。 */
export async function makeElection(spec: ElectionSpec, actor: TestIdentity = ADMIN) {
  const start = spec.votingStartsAt ?? new Date(Date.now() - HOUR);
  const end = new Date(start.getTime() + (spec.votingHours ?? 48) * HOUR);

  const form = new FormData();
  form.set("title", spec.title ?? `測試選舉 ${spec.slug}`);
  form.set("slug", spec.slug);
  form.set("kind", spec.kind ?? "other");
  form.set("seats", String(spec.seats ?? 1));
  form.set("maxChoices", String(spec.maxChoices ?? 1));
  form.set("votingStartsAt", toLocalInput(start));
  form.set("votingEndsAt", toLocalInput(end));

  const result = await as(actor, () => createElection(null, form));
  // 表單驗證失敗時，把 fieldErrors 併進 error——否則測試只會看到「表單有欄位不正確」。
  if (!result.ok && result.fieldErrors) {
    return { ...result, error: `${result.error}｜${JSON.stringify(result.fieldErrors)}` };
  }
  return result;
}

/** datetime-local 的字串格式（本地時間、無時區），與 ElectionForm 送出的一致。 */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 在「選委瀏覽器」產金鑰、只把公鑰送上伺服器。回傳私鑰檔供之後開票。 */
export async function generateKeys(electionId: string, slug: string, shares: 1 | 2 = 1) {
  const { publicKeyJwk, privateKeyJwk } = await generateTallyKeyPair();
  const saved = await as(ADMIN, () => savePublicKey(electionId, publicKeyJwk, shares));
  if (!saved.ok) throw new Error(`存公鑰失敗：${saved.error}`);
  return { publicKeyJwk, keyFiles: makeKeyFiles(privateKeyJwk, slug, shares) };
}

export async function importVoters(electionId: string, voters: TestIdentity[]) {
  const raw = voters.map((v) => `${v.email},${v.name ?? ""}`).join("\n");
  const r = await as(ADMIN, () => importRoster(electionId, raw));
  if (!r.ok) throw new Error(`匯入名冊失敗：${r.error}`);
  return r;
}

/** 建一組「本人上傳」的相片與學生證影本，回傳可餵給 registerCandidate 的 id。 */
export async function makeUploads(electionId: string, identity: TestIdentity) {
  const sub = identity.sub ?? `sub-${identity.email}`;
  const mk = (kind: "photo" | "attachment") =>
    prisma.upload.create({
      data: {
        electionId,
        storageKey: `test/${kind}-${Math.random().toString(36).slice(2)}`,
        filename: `${kind}.png`,
        mime: "image/png",
        size: 1024,
        uploaderSub: sub,
        kind,
      },
      select: { id: true },
    });
  const [photo, attachment] = await Promise.all([mk("photo"), mk("attachment")]);
  return { photoId: photo.id, attachmentId: attachment.id };
}

export async function registerAs(
  slug: string,
  electionId: string,
  identity: TestIdentity,
  opts: { grade?: string; platform?: string } = {},
) {
  const { photoId, attachmentId } = await makeUploads(electionId, identity);
  return as(identity, () =>
    registerCandidate(slug, {
      members: [
        {
          name: identity.name ?? identity.email,
          email: identity.email,
          grade: opts.grade ?? "二年級",
          photo: photoId,
        },
      ],
      platform: opts.platform ?? "測試政見",
      attachmentIds: [attachmentId],
    }),
  );
}

/** 核准該場所有 pending 候選人，回傳依號次排序的候選人。 */
export async function approveAll(electionId: string) {
  const pending = await prisma.candidate.findMany({
    where: { electionId, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  for (const c of pending) {
    const r = await as(ADMIN, () => approveCandidate(electionId, c.id));
    if (!r.ok) throw new Error(`核准失敗：${r.error}`);
  }
  return prisma.candidate.findMany({
    where: { electionId, status: "approved" },
    orderBy: { number: "asc" },
  });
}

/**
 * 把狀態往前推到指定站；每一步都走 advanceStatus（＝真的過所有前置檢查）。
 *
 * voting→closed 現在有截止時間閘門（D2-3／D12-1）：流程測試建立的選舉窗口預設在未來
 * （§26-1 Ⅱ 48 小時下限），測試不可能真的等窗口過去，所以這裡固定以 ADMIN（本測試環境的
 * 超級管理員身分）附理由強制關票——真正驗證「時間未到擋一般管理員／超管無理由」這條規則
 * 本身的測試在 legal.test.ts 直接呼叫 advanceStatus，不經過這個 helper。
 */
export async function advanceTo(electionId: string, target: string) {
  for (let i = 0; i < 8; i++) {
    const election = await prisma.election.findUniqueOrThrow({
      where: { id: electionId },
      select: { status: true },
    });
    if (election.status === target) return;
    const reason = election.status === "voting" ? "測試流程 helper 強制關票" : undefined;
    const r = await as(ADMIN, () => advanceStatus(electionId, reason));
    if (!r.ok) throw new Error(`從 ${election.status} 推進失敗：${r.error}`);
  }
  throw new Error(`推不到 ${target}`);
}

export async function voteAs(
  slug: string,
  electionId: string,
  identity: TestIdentity,
  publicKeyJwk: JsonWebKey,
  choice: BallotChoice,
) {
  const { ciphertext, code } = await encryptBallot(publicKeyJwk, { electionId, choice });
  const result = await as(identity, () => castBallot(slug, ciphertext));
  // 代碼由瀏覽器產生、伺服器看不到，所以要在這一層交還給測試——
  // 就像真實流程裡投票人只有在送出那一刻能看到它。
  return { ...result, code };
}

/** 壓測只在乎密文；代碼是投票人自己保管的東西，那邊用不到。 */
export async function ciphertextFor(
  publicKeyJwk: JsonWebKey,
  electionId: string,
  choice: BallotChoice,
): Promise<string> {
  return (await encryptBallot(publicKeyJwk, { electionId, choice })).ciphertext;
}

/** 一般流程測試不在乎小票匭確認（D3-2），一律直接帶 confirmSmallBox 略過那道提示。 */
export async function seal(electionId: string) {
  const r = await as(ADMIN, () => sealElection(electionId, true));
  if (!r.ok) {
    const reason = "needsConfirm" in r ? `票數過少（${r.ballots} 張）` : r.error;
    throw new Error(`彌封失敗：${reason}`);
  }
}

/** 在「選委瀏覽器」解密計票，並把結果與明細提交回伺服器。 */
export async function tallyAndSubmit(electionId: string, slug: string, keyFiles: TallyKeyFile[]) {
  const election = await prisma.election.findUniqueOrThrow({ where: { id: electionId } });
  const candidates = await prisma.candidate.findMany({
    where: { electionId, status: "approved" },
    orderBy: { number: "asc" },
    select: { id: true },
  });
  const rosterCount = await prisma.voter.count({ where: { electionId } });

  const { results, disclosures } = await decryptAndTally(
    keyFiles,
    (election.sealedBox as string[]) ?? [],
    {
      electionId,
      slug,
      ballotMode: election.ballotMode as "choose" | "approval",
      seats: election.seats,
      maxChoices: election.maxChoices,
      candidateIds: candidates.map((c) => c.id),
      rosterCount,
    },
  );
  const submitted = await as(ADMIN, () => submitResults(electionId, results, disclosures));
  return { results, disclosures, submitted };
}

/** 發布結果公告（sealed → published）。 */
export async function publishResult(electionId: string) {
  const draft = await prisma.announcement.findFirstOrThrow({
    where: { electionId, legalTag: "result" },
  });
  const r = await as(ADMIN, () =>
    publishAnnouncement(electionId, draft.id, "result", draft.title, draft.body),
  );
  if (!r.ok) throw new Error(`發布結果公告失敗：${r.error}`);
  return draft;
}

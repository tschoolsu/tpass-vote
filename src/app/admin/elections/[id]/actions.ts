"use server";
// 單場選舉總覽用的 server actions：存開票公鑰、狀態機單向推進、建立重選場次、軟刪除／還原。
// 狀態機只能單向前進；closed→sealed 走既有 tally/actions.ts 的 sealElection，
// sealed→published 走 announcements 頁發布 result 公告時一併處理，都不在這裡的 NEXT_STATUS 表裡。
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { isSuperAdmin } from "@/config/admin";
import { nextStatus, type ElectionStatus } from "@/lib/election-status";
import type { TallyResult } from "@/lib/tally";
import { cloneElection, copyVotersInto } from "@/lib/clone-election";
import { MIN_VOTING_HOURS } from "@/app/admin/elections/election-schema";
import { formatDateTime } from "@/components/public/shared";

export type ActionResult = { ok: true } | { ok: false; error: string };

// 開票公鑰只准長成 generateTallyKeyPair（src/lib/ballot-crypto.ts）匯出的形狀：
// 白名單而非「列舉壞欄位」——多一個沒列在這裡的欄位（含任何私鑰欄位）一律直接拒絕，
// 不「先存起來以後再說」。use/key_ops 額外正面規定用途，否則像 use:"sig" 這種本身
// 貨真價實的 2048 bit 公鑰會被收下、寫進 DB 且不可覆寫，但投票端瀏覽器
// importKey(usages:["encrypt"]) 會直接 throw DataError，全場票都投不進去。
const ALLOWED_JWK_FIELDS = new Set(["kty", "n", "e", "alg", "use", "key_ops", "ext", "kid"]);

// n 必須先用嚴格 base64url 字元集擋過，才准解碼：驗證端與投票端（瀏覽器嚴格
// base64url）用同一套解讀，帶 padding（=）或標準 base64 字元（+ /）一律先擋在這裡，
// 不讓兩邊對同一個字串解出不同位元組。
const STRICT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// 收票端 isValidCiphertextShape（src/lib/ballot-crypto.ts）硬性要求 ek 剛好 256 bytes，
// 也就是只認 RSA-2048。這裡若放行別的模數長度，金鑰存進去之後每一張票都會被收票端
// 拒收，而金鑰又不可覆寫——只能整場重辦。
//
// 判斷「模數是不是真的 2048 位元」不能只看 base64url 解碼後的 byte 數：把一把 1024 bit
// 公鑰的 n（128 bytes）前面補 128 個 0 byte，一樣會湊出 256 bytes，但實際模數長度沒變。
// RFC 7518 §6.3.1.1 規定 n 不得帶前導 0 byte，所以正確判斷是「長度為 256 bytes，且第
// 一個 byte 不是 0」——WebCrypto 匯出的 2048 bit JWK 本來就滿足這兩條。
const RSA_2048_MODULUS_BYTES = 256;

function isRsa2048Modulus(n: string): boolean {
  const decoded = Buffer.from(n, "base64url");
  return decoded.length === RSA_2048_MODULUS_BYTES && decoded[0] !== 0;
}

function isPublicOnlyRsaJwk(jwk: unknown): jwk is JsonWebKey {
  if (!jwk || typeof jwk !== "object") return false;
  const o = jwk as Record<string, unknown>;
  if (!Object.keys(o).every((k) => ALLOWED_JWK_FIELDS.has(k))) return false;
  if (o.kty !== "RSA") return false;
  if (typeof o.e !== "string" || o.e !== "AQAB") return false;
  if (typeof o.n !== "string" || !STRICT_BASE64URL_RE.test(o.n) || !isRsa2048Modulus(o.n)) {
    return false;
  }
  if ("alg" in o && o.alg !== "RSA-OAEP-256") return false;
  if ("use" in o && o.use !== "enc") return false;
  if ("key_ops" in o) {
    if (!Array.isArray(o.key_ops) || o.key_ops.length === 0) return false;
    if (!o.key_ops.every((op) => op === "encrypt")) return false;
  }
  return true;
}

export async function savePublicKey(
  electionId: string,
  publicKeyJwk: unknown,
  shares: number,
): Promise<ActionResult> {
  const admin = await requireAdmin();

  if (shares !== 1 && shares !== 2) return { ok: false, error: "分持份數只能是 1 或 2" };
  if (!isPublicOnlyRsaJwk(publicKeyJwk)) {
    return {
      ok: false,
      error: "金鑰格式不正確、疑似包含私鑰內容，或開票金鑰必須是 RSA-2048，已拒絕儲存",
    };
  }

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.tallyPublicKeyJwk) {
    return { ok: false, error: "此選舉已有開票金鑰，不可重新產生（會讓既有金鑰檔失效）" };
  }

  const wrote = await prisma.$transaction(async (tx) => {
    // 「還沒有公鑰才寫」的條件放進 updateMany 的 where，由資料庫保證只有一次寫入會
    // 命中——兩位選委同時通過上面交易外的檢查時，只有先 commit 的那個 count 會是 1，
    // 後到的會是 0，不會互相覆蓋。
    const updated = await tx.election.updateMany({
      where: { id: electionId, tallyPublicKeyJwk: { equals: Prisma.DbNull } },
      data: { tallyPublicKeyJwk: publicKeyJwk as Prisma.InputJsonValue, keyShares: shares },
    });
    if (updated.count === 0) return false;
    await tx.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "save_public_key",
        summary: `設定開票金鑰（分持 ${shares} 份）`,
        diff: { keyShares: shares } as Prisma.InputJsonValue,
      },
    });
    return true;
  });
  if (!wrote) {
    return { ok: false, error: "此選舉已有開票金鑰，不可重新產生（會讓既有金鑰檔失效）" };
  }

  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

// reason：僅 voting→closed 提前關票（截止時間未到）時才有意義，且只有超級管理員能靠它
// 強制通過——一般管理員帶 reason 一樣被擋，見下方 D2-3／D12-1 的檢查。
export async function advanceStatus(electionId: string, reason?: string): Promise<ActionResult> {
  const admin = await requireAdmin();

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: {
      candidates: { where: { status: "approved" }, select: { id: true } },
      _count: { select: { voters: true } },
    },
  });
  if (!election) return { ok: false, error: "找不到選舉" };

  const current = election.status as ElectionStatus;
  const next = nextStatus(current, election.kind);
  if (!next) {
    return {
      ok: false,
      error: "此狀態無法用這顆按鈕推進（彌封請用彌封按鈕；發布結果請到公告頁）",
    };
  }

  let ballotMode: "choose" | "approval" | undefined;
  // 罷免案的選區名冊在 established→voting 才複製（§35 罷免投票限原選區；petition/連署階段開放全校，
  // 不需名冊）。來源＝罷免對象職務的原選舉。null 表非此情境。
  let copyRosterFromElectionId: string | null = null;
  if (next === "voting") {
    // §26-1 Ⅱ：投票期間不得少於 48 小時。表單只擋「填了但太短」，這裡才是真正的閘門——
    // 兩個時間都必須設定，否則等於沒有投票期間可言。一般鏈與罷免鏈都會經過這裡。
    const { votingStartsAt, votingEndsAt } = election;
    if (!votingStartsAt || !votingEndsAt) {
      return { ok: false, error: "尚未設定投票開始與截止時間，無法開放投票" };
    }
    if (votingEndsAt.getTime() - votingStartsAt.getTime() < MIN_VOTING_HOURS * 3_600_000) {
      return {
        ok: false,
        error: `投票期間不得少於 ${MIN_VOTING_HOURS} 小時（選罷法 §26-1 Ⅱ），請先修改時程`,
      };
    }
    // D12-1：時程排錯或選委拖到太晚才按，導致整段投票期間已經過去——這種情況不能開放投票
    // （開放了也沒人投得到票），不是只擋「太短」。
    if (new Date() >= votingEndsAt) {
      return {
        ok: false,
        error: `投票期間已於 ${formatDateTime(votingEndsAt)} 結束，整段投票期間已過去，無法開放投票`,
      };
    }
    if (!election.tallyPublicKeyJwk) return { ok: false, error: "尚未產生開票金鑰，無法開放投票" };
    if (election.kind === "recall") {
      // 罷免只有 1 位「候選人」（罷免對象本身），別讓 candidates.length>seats 的判定邏輯
      // 把它算成 choose 模式——罷免票種永遠是「同意／不同意」。
      if (!election.recallTargetCandidateId) {
        return { ok: false, error: "尚未設定罷免對象，無法開放投票" };
      }
      if (election.candidates.length === 0) {
        return { ok: false, error: "尚無罷免候選人資料（系統應已自動建立），無法開放投票" };
      }
      ballotMode = "approval";
      if (!election.recallTargetOfficeId) {
        return { ok: false, error: "罷免案未關聯職務，無法決定投票選區名冊" };
      }
      const office = await prisma.office.findUnique({
        where: { id: election.recallTargetOfficeId },
        select: { sourceElectionId: true },
      });
      if (!office?.sourceElectionId) {
        return {
          ok: false,
          error: "此職務無來源選舉，無法自動帶入投票選區名冊，請選委手動上傳名冊後再開放投票",
        };
      }
      copyRosterFromElectionId = office.sourceElectionId;
    } else {
      if (election._count.voters === 0) return { ok: false, error: "尚未上傳選舉人名冊，無法開放投票" };
      if (election.candidates.length === 0) return { ok: false, error: "尚無核准候選人，無法開放投票" };
      ballotMode = election.candidates.length > election.seats ? "choose" : "approval";
    }
  }

  // D2-3／D12-1：voting→closed 沒有時間閘門的話，投票開始沒多久就能關票，把還沒投的人
  // 永遠鎖在外——§26-1 Ⅱ 的 48 小時只擋「排程」的跨度，不擋「提早按下關票」。截止時間到才
  // 准關票；超級管理員可附理由強制提前關票（例如重大資安事故），理由寫進 audit log。
  let closeReason: string | undefined;
  if (next === "closed" && election.votingEndsAt && new Date() < election.votingEndsAt) {
    const trimmedReason = reason?.trim();
    if (!isSuperAdmin(admin) || !trimmedReason) {
      return {
        ok: false,
        error: `投票截止時間為 ${formatDateTime(election.votingEndsAt)}，尚不能關票`,
      };
    }
    // audit log 的 summary／diff 都會原文收下這段字，長度上限只是不讓稽核紀錄被灌爆，
    // 不是安全邊界——超過的部分直接截斷，不視為錯誤擋下操作。
    closeReason = trimmedReason.slice(0, 200);
  }

  const result = await prisma.$transaction(async (tx) => {
    if (copyRosterFromElectionId) {
      await copyVotersInto(tx, copyRosterFromElectionId, electionId);
      const count = await tx.voter.count({ where: { electionId } });
      if (count === 0) return { empty: true as const };
    }
    const updated = await tx.election.updateMany({
      where: { id: electionId, status: current }, // 樂觀鎖：防兩個選委同時推進
      data: { status: next, ...(ballotMode ? { ballotMode } : {}) },
    });
    if (updated.count > 0) {
      await tx.electionAuditLog.create({
        data: {
          electionId,
          actorEmail: admin.email,
          action: "advance_status",
          summary: closeReason
            ? `狀態推進：${current} → ${next}（截止前強制關票，理由：${closeReason}）`
            : `狀態推進：${current} → ${next}`,
          diff: {
            from: current,
            to: next,
            ...(ballotMode ? { ballotMode } : {}),
            ...(closeReason ? { reason: closeReason } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    }
    return { updatedCount: updated.count };
  }, { timeout: 10_000 });

  if ("empty" in result) {
    return { ok: false, error: "原選舉選區名冊為空，無法開放罷免投票，請選委手動上傳名冊" };
  }
  if (result.updatedCount === 0) {
    return { ok: false, error: "狀態已被其他選委變更，請重新整理頁面" };
  }

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

export type ElectionCloneResult =
  | { ok: true; electionId: string }
  | { ok: false; error: string };
// 保留舊名（TallyClient.tsx 等呼叫端沿用），形狀與 ElectionCloneResult 相同。
export type RunoffResult = ElectionCloneResult;

export async function createRunoff(
  electionId: string,
  tiedCandidateIds: string[],
): Promise<RunoffResult> {
  await requireAdmin();

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: {
      candidates: { where: { status: "approved" } },
    },
  });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.status !== "sealed" && election.status !== "published") {
    return { ok: false, error: "只有已彌封或已公告結果的選舉才能建立重選場次" };
  }

  const tiedIds = [...new Set(tiedCandidateIds)];
  if (tiedIds.length < 2) return { ok: false, error: "同票候選人至少需要 2 組" };

  const approvedById = new Map(election.candidates.map((c) => [c.id, c]));
  if (tiedIds.some((id) => !approvedById.has(id))) {
    return { ok: false, error: "同票候選人清單不在本場核准名單內" };
  }

  // 若已提交計票結果，同票名單必須與結果一致，避免建錯場次。
  if (election.resultsJson) {
    const results = election.resultsJson as unknown as TallyResult;
    const actualTied = new Set(
      (results.candidates ?? []).filter((c) => c.tied).map((c) => c.candidateId),
    );
    const same = actualTied.size === tiedIds.length && tiedIds.every((id) => actualTied.has(id));
    if (!same) return { ok: false, error: "同票名單與已提交的計票結果不符" };
  }

  const runoff = await prisma.$transaction((tx) =>
    cloneElection(tx, election, {
      lineage: "runoff",
      titleSuffix: "（重選）",
      copyCandidates: "tied",
      copyRoster: true,
      tiedCandidateIds: tiedIds,
    }),
    { timeout: 10_000 },
  );

  revalidatePath("/admin");
  return { ok: true, electionId: runoff.id };
}

// 補選：以出缺職位的原選舉為本，只複製名冊，候選人從零登記（走完整登記/審核流程）。
export async function createByElection(sourceId: string): Promise<ElectionCloneResult> {
  await requireAdmin();

  const source = await prisma.election.findUnique({ where: { id: sourceId } });
  if (!source) return { ok: false, error: "找不到原選舉" };

  const byElection = await prisma.$transaction((tx) =>
    cloneElection(tx, source, {
      lineage: "by_election",
      titleSuffix: "（補選）",
      copyCandidates: "none",
      copyRoster: true,
    }),
    { timeout: 10_000 },
  );

  revalidatePath("/admin");
  return { ok: true, electionId: byElection.id };
}

// D14-1：這三個狀態已經可能有人投過票——重辦會把來源場次整個隱藏（投票端 404），
// 已投的票就留在誰也看不到、開不了票的舊場次裡。一般管理員在這三個狀態一律不准按，
// 只有超級管理員可以，且必須附上非空理由（寫進 audit log，供事後究責）。
const REDO_REQUIRES_SUPERADMIN_REASON = new Set(["voting", "closed", "sealed"]);

// 彌封（sealElection）會把 EncryptedBallot 清空、票搬進洗牌後的 sealedBox（§26-1 Ⅳ，
// voterId↔ciphertext 不得存活），所以 sealed 狀態查 EncryptedBallot 恆為 0。castBallot
// 是唯一會設 Voter.votedAt 的地方，且與 EncryptedBallot 在同一交易寫入、彌封也不清它
// （見 sealElection 註解「名冊 Voter.votedAt 保留」），所以查 votedAt 才是 voting／
// closed／sealed 三態都準的「這場真的有幾張票」——也跟 SettingsPanel／ElectionWorkbench
// 顯示給選委看的「已投票數」用同一個定義，UI 與稽核紀錄的數字不會兜不起來。
async function countCastBallots(source: { id: string }): Promise<number> {
  return prisma.voter.count({ where: { electionId: source.id, votedAt: { not: null } } });
}

// 金鑰遺失重辦：複製名冊與已核准候選人，原場同一交易內作廢（軟刪除），新場從頭走金鑰產生。
export async function redoElection(electionId: string, reason?: string): Promise<ElectionCloneResult> {
  const admin = await requireAdmin();

  const source = await prisma.election.findUnique({ where: { id: electionId } });
  if (!source) return { ok: false, error: "找不到選舉" };
  if (source.status === "published") {
    return { ok: false, error: "已公告結果的選舉不能重辦，請聯絡技術負責人循其他程序處理" };
  }

  let trimmedReason: string | undefined;
  let ballotCount = 0;
  if (REDO_REQUIRES_SUPERADMIN_REASON.has(source.status)) {
    ballotCount = await countCastBallots(source);
    trimmedReason = reason?.trim();
    if (!isSuperAdmin(admin) || !trimmedReason) {
      return {
        ok: false,
        error: `已有 ${ballotCount} 張票，重辦會作廢，需超級管理員附理由`,
      };
    }
  }

  const redone = await prisma.$transaction(async (tx) => {
    const created = await cloneElection(tx, source, {
      lineage: "redo",
      titleSuffix: "（重辦）",
      copyCandidates: "approved",
      copyRoster: true,
    });
    await tx.election.update({ where: { id: source.id }, data: { hiddenAt: new Date() } });
    await tx.electionAuditLog.create({
      data: {
        electionId: source.id,
        actorEmail: admin.email,
        action: "redo_election",
        summary: `金鑰遺失重辦，原場次隱藏，新場次 id＝${created.id}`,
        diff: {
          newElectionId: created.id,
          ...(trimmedReason ? { reason: trimmedReason, voidedBallotCount: ballotCount } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    return created;
  }, { timeout: 10_000 });

  revalidatePath("/admin");
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true, electionId: redone.id };
}

// 軟刪除：只設 hiddenAt 旗標，資料（候選人／名冊／選票／公告）完全保留，不做 prisma.delete。
// 隱藏後從所有公開端與管理端預設列表消失，但可隨時還原。
export async function hideElection(electionId: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${electionId}`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.hiddenAt) return { ok: false, error: "此選舉已經是隱藏狀態" };

  await prisma.$transaction([
    prisma.election.update({
      where: { id: electionId },
      data: { hiddenAt: new Date() },
    }),
    prisma.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "hide_election",
        summary: "隱藏（軟刪除）此選舉",
        diff: {} as Prisma.InputJsonValue,
      },
    }),
  ]);

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/e/${election.slug}`);
  redirect("/admin");
}

export async function restoreElection(electionId: string): Promise<ActionResult> {
  const admin = await requireAdmin(`/admin/elections/${electionId}`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (!election.hiddenAt) return { ok: false, error: "此選舉未處於隱藏狀態" };

  await prisma.$transaction([
    prisma.election.update({
      where: { id: electionId },
      data: { hiddenAt: null },
    }),
    prisma.electionAuditLog.create({
      data: {
        electionId,
        actorEmail: admin.email,
        action: "restore_election",
        summary: "還原此選舉（取消隱藏）",
        diff: {} as Prisma.InputJsonValue,
      },
    }),
  ]);

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/e/${election.slug}`);
  return { ok: true };
}

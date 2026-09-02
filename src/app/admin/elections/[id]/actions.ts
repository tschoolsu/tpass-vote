"use server";
// 單場選舉總覽用的 server actions：存開票公鑰、狀態機單向推進、建立重選場次、軟刪除／還原。
// 狀態機只能單向前進；closed→sealed 走既有 tally/actions.ts 的 sealElection，
// sealed→published 走 announcements 頁發布 result 公告時一併處理，都不在這裡的 NEXT_STATUS 表裡。
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { nextStatus, type ElectionStatus } from "@/lib/election-status";
import type { TallyResult } from "@/lib/tally";
import { cloneElection, copyVotersInto } from "@/lib/clone-election";

export type ActionResult = { ok: true } | { ok: false; error: string };

// 開票私鑰永不上傳伺服器：這裡只收公鑰，看起來像私鑰的欄位一律直接拒絕，不「先存起來以後再說」。
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const;

function isPublicOnlyRsaJwk(jwk: unknown): jwk is JsonWebKey {
  if (!jwk || typeof jwk !== "object") return false;
  const o = jwk as Record<string, unknown>;
  if (o.kty !== "RSA") return false;
  if (typeof o.n !== "string" || typeof o.e !== "string") return false;
  if (PRIVATE_JWK_FIELDS.some((f) => f in o)) return false;
  return true;
}

export async function savePublicKey(
  electionId: string,
  publicKeyJwk: unknown,
  shares: number,
): Promise<ActionResult> {
  await requireAdmin();

  if (shares !== 1 && shares !== 2) return { ok: false, error: "分持份數只能是 1 或 2" };
  if (!isPublicOnlyRsaJwk(publicKeyJwk)) {
    return { ok: false, error: "金鑰格式不正確或疑似包含私鑰內容，已拒絕儲存" };
  }

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.tallyPublicKeyJwk) {
    return { ok: false, error: "此選舉已有開票金鑰，不可重新產生（會讓既有金鑰檔失效）" };
  }

  await prisma.election.update({
    where: { id: electionId },
    data: { tallyPublicKeyJwk: publicKeyJwk as Prisma.InputJsonValue, keyShares: shares },
  });

  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true };
}

export async function advanceStatus(electionId: string): Promise<ActionResult> {
  await requireAdmin();

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
    return { updatedCount: updated.count };
  });

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
  );

  revalidatePath("/admin");
  return { ok: true, electionId: byElection.id };
}

// 金鑰遺失重辦：複製名冊與已核准候選人，原場同一交易內作廢（軟刪除），新場從頭走金鑰產生。
export async function redoElection(electionId: string): Promise<ElectionCloneResult> {
  await requireAdmin();

  const source = await prisma.election.findUnique({ where: { id: electionId } });
  if (!source) return { ok: false, error: "找不到選舉" };

  const redone = await prisma.$transaction(async (tx) => {
    const created = await cloneElection(tx, source, {
      lineage: "redo",
      titleSuffix: "（重辦）",
      copyCandidates: "approved",
      copyRoster: true,
    });
    await tx.election.update({ where: { id: source.id }, data: { hiddenAt: new Date() } });
    return created;
  });

  revalidatePath("/admin");
  revalidatePath(`/admin/elections/${electionId}`);
  return { ok: true, electionId: redone.id };
}

// 軟刪除：只設 hiddenAt 旗標，資料（候選人／名冊／選票／公告）完全保留，不做 prisma.delete。
// 隱藏後從所有公開端與管理端預設列表消失，但可隨時還原。
export async function hideElection(electionId: string): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (election.hiddenAt) return { ok: false, error: "此選舉已經是隱藏狀態" };

  await prisma.election.update({
    where: { id: electionId },
    data: { hiddenAt: new Date() },
  });

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/e/${election.slug}`);
  redirect("/admin");
}

export async function restoreElection(electionId: string): Promise<ActionResult> {
  await requireAdmin(`/admin/elections/${electionId}`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  if (!election.hiddenAt) return { ok: false, error: "此選舉未處於隱藏狀態" };

  await prisma.election.update({
    where: { id: electionId },
    data: { hiddenAt: null },
  });

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  revalidatePath("/");
  revalidatePath(`/e/${election.slug}`);
  return { ok: true };
}

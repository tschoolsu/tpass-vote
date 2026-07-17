"use server";
// 單場選舉總覽用的 server actions：存開票公鑰、狀態機單向推進、建立重選場次。
// 狀態機只能單向前進；closed→sealed 走既有 tally/actions.ts 的 sealElection，
// sealed→published 走 announcements 頁發布 result 公告時一併處理，都不在這裡的 NEXT_STATUS 表裡。
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { NEXT_STATUS, type ElectionStatus } from "@/components/admin/status";
import type { TallyResult } from "@/lib/tally";

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
  const next = NEXT_STATUS[current];
  if (!next) {
    return {
      ok: false,
      error: "此狀態無法用這顆按鈕推進（彌封請用彌封按鈕；發布結果請到公告頁）",
    };
  }

  let ballotMode: "choose" | "approval" | undefined;
  if (next === "voting") {
    if (!election.tallyPublicKeyJwk) return { ok: false, error: "尚未產生開票金鑰，無法開放投票" };
    if (election.candidates.length === 0) return { ok: false, error: "尚無核准候選人，無法開放投票" };
    if (election._count.voters === 0) return { ok: false, error: "尚未上傳選舉人名冊，無法開放投票" };
    ballotMode = election.candidates.length > election.seats ? "choose" : "approval";
  }

  const updated = await prisma.election.updateMany({
    where: { id: electionId, status: current }, // 樂觀鎖：防兩個選委同時推進
    data: { status: next, ...(ballotMode ? { ballotMode } : {}) },
  });
  if (updated.count === 0) {
    return { ok: false, error: "狀態已被其他選委變更，請重新整理頁面" };
  }

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true };
}

export type RunoffResult = { ok: true; electionId: string } | { ok: false; error: string };

export async function createRunoff(
  electionId: string,
  tiedCandidateIds: string[],
): Promise<RunoffResult> {
  await requireAdmin();

  const election = await prisma.election.findUnique({
    where: { id: electionId },
    include: {
      candidates: { where: { status: "approved" } },
      voters: { select: { email: true, name: true } },
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

  let newSlug = `${election.slug}-runoff`;
  let suffix = 2;
  while (await prisma.election.findUnique({ where: { slug: newSlug }, select: { id: true } })) {
    newSlug = `${election.slug}-runoff-${suffix}`;
    suffix++;
  }

  const runoff = await prisma.$transaction(async (tx) => {
    const created = await tx.election.create({
      data: {
        slug: newSlug,
        title: `${election.title}（重選）`,
        kind: election.kind,
        parentId: election.id,
        seats: election.seats,
        maxChoices: election.maxChoices,
        status: "draft",
      },
    });

    if (election.voters.length > 0) {
      await tx.voter.createMany({
        data: election.voters.map((v) => ({ electionId: created.id, email: v.email, name: v.name })),
      });
    }

    const tiedCandidates = tiedIds.map((id) => approvedById.get(id)!);
    await tx.candidate.createMany({
      data: tiedCandidates.map((c) => ({
        electionId: created.id,
        members: c.members as Prisma.InputJsonValue,
        number: c.number,
        platform: c.platform,
        attachments: c.attachments === null ? Prisma.JsonNull : (c.attachments as Prisma.InputJsonValue),
        status: "approved",
        createdBy: c.createdBy,
      })),
    });

    return created;
  });

  revalidatePath("/admin");
  return { ok: true, electionId: runoff.id };
}

// 場次複製共用邏輯：同票重選（runoff）、罷免通過後補選（by_election）、金鑰遺失重辦（redo）
// 三種「從既有選舉複製出一場新草稿」的操作，形狀完全一樣，差別只在複製哪些子資料與
// slug/title 後綴。原本各自寫一份（createRunoff 最先長出來），這裡收斂成一個純函式。
//
// 安全不變量：
// 1. 新場一律 status="draft"、無開票金鑰——複製只搬名冊／候選人「資料」，不搬任何投票期狀態
//    （tallyPublicKeyJwk/sealedBox/resultsJson 等一律不複製，新場要重新走完整流程）。
// 2. 呼叫端必須在既有 $transaction 內傳入 tx；本函式不自己開交易，也不做任何 requireAdmin
//    守門判斷——那是呼叫端的責任（各 action 自己驗證來源場次狀態是否允許複製）。
import { Prisma, type Election } from "@/generated/prisma/client";

function isUniqueSlugConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export type CloneLineage = "runoff" | "by_election" | "redo";

const SLUG_SUFFIX: Record<CloneLineage, string> = {
  runoff: "runoff",
  by_election: "by-election",
  redo: "redo",
};

export interface CloneElectionOptions {
  titleSuffix: string; // 例：「（重選）」「（補選）」「（重辦）」
  lineage: CloneLineage;
  copyCandidates: "none" | "tied" | "approved";
  copyRoster: boolean;
  tiedCandidateIds?: string[]; // copyCandidates="tied" 時必填
}

export type CloneSourceElection = Pick<
  Election,
  "id" | "slug" | "title" | "kind" | "seats" | "maxChoices"
>;

// 把一場選舉的 Voter 名冊複製進另一場（skipDuplicates 保證可重入）。cloneElection 與罷免案
// established→voting 推進（§35 罷免投票限原選區）共用。只搬 email/name，不搬投票狀態。
export async function copyVotersInto(
  tx: Prisma.TransactionClient,
  fromElectionId: string,
  toElectionId: string,
): Promise<number> {
  const voters = await tx.voter.findMany({
    where: { electionId: fromElectionId },
    select: { email: true, name: true },
  });
  if (voters.length === 0) return 0;
  const res = await tx.voter.createMany({
    data: voters.map((v) => ({ electionId: toElectionId, email: v.email, name: v.name })),
    skipDuplicates: true,
  });
  return res.count;
}

export async function cloneElection(
  tx: Prisma.TransactionClient,
  source: CloneSourceElection,
  options: CloneElectionOptions,
): Promise<{ id: string; slug: string }> {
  const slugSuffix = SLUG_SUFFIX[options.lineage];
  let newSlug = `${source.slug}-${slugSuffix}`;
  let n = 2;
  while (await tx.election.findUnique({ where: { slug: newSlug }, select: { id: true } })) {
    newSlug = `${source.slug}-${slugSuffix}-${n}`;
    n++;
  }

  const data = {
    title: `${source.title}${options.titleSuffix}`,
    kind: source.kind,
    parentId: source.id,
    lineage: options.lineage,
    seats: source.seats,
    maxChoices: source.maxChoices,
    status: "draft",
  };

  // 上面的 while 迴圈是「先查後建」，兩個複製動作同時算出同一個 newSlug 時查詢都會落空——
  // 交易內真正 create 那一刻才會撞到 slug 的 @unique。撞到就加隨機尾碼重試一次，不讓這個
  // 窗口期的競態以未處理例外收場。Postgres 一旦某條指令出錯，整個交易會進入 aborted 狀態、
  // 後續指令一律被拒（25P02），所以重試前必須先 ROLLBACK TO SAVEPOINT 把交易救回來，
  // 不能在同一個 transaction 裡直接接著再下一次 create。
  let created: Election;
  await tx.$executeRawUnsafe("SAVEPOINT clone_election_slug_retry");
  try {
    created = await tx.election.create({ data: { ...data, slug: newSlug } });
  } catch (e) {
    if (!isUniqueSlugConflict(e)) throw e;
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT clone_election_slug_retry");
    const retrySlug = `${newSlug}-${Math.random().toString(36).slice(2, 6)}`;
    created = await tx.election.create({ data: { ...data, slug: retrySlug } });
  }

  if (options.copyRoster) {
    await copyVotersInto(tx, source.id, created.id);
  }

  if (options.copyCandidates !== "none") {
    const approved = await tx.candidate.findMany({
      where: { electionId: source.id, status: "approved" },
    });
    const toCopy =
      options.copyCandidates === "tied"
        ? approved.filter((c) => options.tiedCandidateIds?.includes(c.id))
        : approved;
    if (toCopy.length > 0) {
      await tx.candidate.createMany({
        data: toCopy.map((c) => ({
          electionId: created.id,
          members: c.members as Prisma.InputJsonValue,
          number: c.number,
          platform: c.platform,
          attachments:
            c.attachments === null ? Prisma.JsonNull : (c.attachments as Prisma.InputJsonValue),
          status: "approved",
          createdBy: c.createdBy,
        })),
      });
    }
  }

  return { id: created.id, slug: created.slug };
}

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import {
  parseElectionForm,
  extractFormValues,
  type ElectionFormResult,
} from "@/app/admin/elections/election-schema";
import { LOCKED_STATUSES } from "@/lib/election-status";

// 投票開始後（含之後的每個狀態）選舉基本資料一律鎖定，避免改動 seats/maxChoices
// 弄亂已經定案的 ballotMode 判定或已公告的期程。

export async function updateElection(
  electionId: string,
  _prev: ElectionFormResult | null,
  formData: FormData,
): Promise<ElectionFormResult> {
  await requireAdmin(`/admin/elections/${electionId}/edit`);

  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) return { ok: false, error: "找不到選舉" };
  // 這裡的檢查只是先擋掉「本來就已經鎖定」的請求，省得白跑後面的表單驗證；
  // 真正說了算的判斷在下面的交易裡用 FOR UPDATE 重讀一次（見該處註解）。
  if (LOCKED_STATUSES.has(election.status)) {
    return { ok: false, error: "投票已開始，選舉基本資料已鎖定，不可再修改" };
  }

  const parsed = parseElectionForm(formData);
  if (!parsed.ok) return parsed.result;
  const v = parsed.data;

  if (v.slug !== election.slug) {
    const existing = await prisma.election.findUnique({ where: { slug: v.slug }, select: { id: true } });
    if (existing) {
      return {
        ok: false,
        error: "這個 slug 已被使用",
        fieldErrors: { slug: "已被使用" },
        values: extractFormValues(formData),
      };
    }
  }

  if (v.officeId) {
    const office = await prisma.office.findUnique({ where: { id: v.officeId }, select: { id: true } });
    if (!office) {
      return {
        ok: false,
        error: "選定的對應職務不存在，請重新選擇",
        values: extractFormValues(formData),
      };
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // 交易外的檢查讀到的是舊狀態——advanceStatus 能在「檢查完、還沒寫」的窗口插隊 commit
    // 把投票開放（D7-3）。這裡在真正寫入前用 FOR UPDATE 重讀一次：因為這個交易接下來就是
    // 對 Election 這一列本身寫入，用 FOR UPDATE 而不是 castBallot 那種 FOR SHARE，
    // 避免「先 FOR SHARE、交易內再 UPDATE 同一列」在兩個選委同時送出編輯時互相等待造成死結。
    const [locked] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM "Election" WHERE id = ${electionId} FOR UPDATE
    `;
    if (!locked) return { ok: false as const, error: "找不到選舉" };
    if (LOCKED_STATUSES.has(locked.status)) {
      return { ok: false as const, error: "投票已開始，選舉基本資料已鎖定，不可再修改" };
    }

    await tx.election.update({
      where: { id: electionId },
      data: {
        title: v.title,
        slug: v.slug,
        kind: v.kind,
        seats: v.seats,
        maxChoices: v.maxChoices,
        registrationStartsAt: v.registrationStartsAt ?? null,
        registrationEndsAt: v.registrationEndsAt ?? null,
        votingStartsAt: v.votingStartsAt ?? null,
        votingEndsAt: v.votingEndsAt ?? null,
        officeId: v.officeId ?? null,
      },
    });
    return { ok: true as const };
  }, { timeout: 10_000 });

  if (!result.ok) return result;

  revalidatePath(`/admin/elections/${electionId}`);
  revalidatePath("/admin");
  return { ok: true, electionId, slug: v.slug };
}

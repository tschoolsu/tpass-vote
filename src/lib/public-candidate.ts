// 候選人個別頁（/e/[slug]/c/[number]）與兩張分享圖共用的查詢。
// 公開範圍跟選舉詳情頁一致：草稿、已隱藏的場次不存在；罷免案沒有「候選人」可分享
// （它的計票對象是罷免用候選人組，不是參選人）；只認已核准且已編號次的候選人。
import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import { authConfig } from "@/config/auth";
import type { MemberInfo } from "@/components/public/shared";

export interface PublicCandidateData {
  election: {
    id: string;
    slug: string;
    title: string;
    kind: string;
    status: string;
    votingStartsAt: Date | null;
    votingEndsAt: Date | null;
  };
  candidate: {
    id: string;
    number: number;
    members: MemberInfo[];
    platform: string;
    updatedAt: Date;
  };
}

export function candidatePageUrl(slug: string, number: number): string {
  return new URL(`/e/${slug}/c/${number}`, authConfig.selfUrl).toString();
}

export const findPublicCandidate = cache(
  async (slug: string, numberParam: string): Promise<PublicCandidateData | null> => {
    // 號次只收 1～3 位數字：擋掉 "01"、"1e2" 這類 Number() 會吃下去的寫法，一個號次只有一個網址。
    if (!/^[1-9]\d{0,2}$/.test(numberParam)) return null;
    const number = Number(numberParam);

    const election = await prisma.election.findFirst({
      where: { slug, hiddenAt: null },
      select: {
        id: true,
        slug: true,
        title: true,
        kind: true,
        status: true,
        votingStartsAt: true,
        votingEndsAt: true,
        candidates: {
          where: { status: "approved", number },
          select: { id: true, number: true, members: true, platform: true, updatedAt: true },
        },
      },
    });
    if (!election || election.status === "draft" || election.kind === "recall") return null;

    const c = election.candidates[0];
    if (!c || c.number === null) return null;

    return {
      election: {
        id: election.id,
        slug: election.slug,
        title: election.title,
        kind: election.kind,
        status: election.status,
        votingStartsAt: election.votingStartsAt,
        votingEndsAt: election.votingEndsAt,
      },
      candidate: {
        id: c.id,
        number: c.number,
        members: c.members as unknown as MemberInfo[],
        platform: c.platform,
        updatedAt: c.updatedAt,
      },
    };
  },
);

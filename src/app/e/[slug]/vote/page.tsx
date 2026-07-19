// 投票頁：需登入、需在選舉人名冊。撈選舉＋核准候選人＋本人 Voter 記錄，依狀態顯示對應內容。
// 核心安全不變量：這裡只把「公鑰」交給 client 元件加密；伺服器與這個 server component
// 都不會看到、也不會經手選擇內容——選擇只存在 client 記憶體，送出時已是密文。
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/public/Shell";
import { StatusBadge } from "@/components/public/Badges";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { VoteForm } from "@/components/public/VoteForm";
import { Card } from "@/components/ui/primitives";
import { requireSession } from "@/lib/guard";
import { isAdmin } from "@/config/admin";
import { authConfig } from "@/config/auth";
import { prisma } from "@/lib/db";
import { formatDateTime, type MemberInfo } from "@/components/public/shared";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const election = await prisma.election.findFirst({
    where: { slug, hiddenAt: null },
    select: { title: true },
  });
  if (!election) return { title: "找不到選舉" };
  return { title: `投票｜${election.title}`, description: "T-Vote 匿名投票" };
}

export default async function VotePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession(`/e/${slug}/vote`);
  const election = await prisma.election.findFirst({ where: { slug, hiddenAt: null } });
  if (!election || election.status === "draft") notFound();

  const admin = await isAdmin(session.email);
  const shareUrl = new URL(`/e/${slug}/vote`, authConfig.selfUrl).toString();

  const voter = await prisma.voter.findUnique({
    where: { electionId_email: { electionId: election.id, email: session.email } },
  });

  // 不在名冊：不管選舉狀態，先擋在這——這是身分/資格問題，不是時程問題。
  if (!voter) {
    return (
      <PublicShell isLoggedIn isAdmin={admin}>
        <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
          ← {election.title}
        </Link>
        <h1 className="mt-3 font-extrabold text-2xl">投票</h1>
        <Card className="mt-6 text-center">
          <p className="font-bold">你不在本場選舉的選舉人名冊中</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            如認為這是錯誤，請聯絡選委會確認名冊。
          </p>
        </Card>
      </PublicShell>
    );
  }

  if (election.status !== "voting") {
    return (
      <PublicShell isLoggedIn isAdmin={admin}>
        <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
          ← {election.title}
        </Link>
        <h1 className="mt-3 font-extrabold text-2xl">投票</h1>
        <div className="mt-3">
          <StatusBadge status={election.status} />
        </div>
        <Card className="mt-6 text-center">
          <p className="font-bold">本場選舉目前不在投票階段</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            投票開放時間：{formatDateTime(election.votingStartsAt)} ～{" "}
            {formatDateTime(election.votingEndsAt)}
          </p>
        </Card>
      </PublicShell>
    );
  }

  const candidates = await prisma.candidate.findMany({
    where: { electionId: election.id, status: "approved" },
    orderBy: { number: "asc" },
  });

  if (!election.tallyPublicKeyJwk || !election.ballotMode) {
    return (
      <PublicShell isLoggedIn isAdmin={admin}>
        <Card className="mt-6 text-center">
          <p className="font-bold">投票設定尚未完成，請稍後再試</p>
          <p className="mt-1 text-sm font-medium text-muted-foreground">
            （選舉已進入投票階段，但尚缺開票金鑰或投票模式，請聯絡選委會）
          </p>
        </Card>
      </PublicShell>
    );
  }

  return (
    <PublicShell isLoggedIn isAdmin={admin}>
      <Link href={`/e/${slug}`} className="text-sm font-bold text-accent hover:underline">
        ← {election.title}
      </Link>
      <h1 className="mt-3 font-extrabold text-2xl sm:text-3xl">投票</h1>
      <div className="mt-2 flex items-center gap-2">
        <StatusBadge status={election.status} />
        <CopyLinkButton url={shareUrl} label="複製本頁連結" size="sm" />
      </div>

      <p className="mt-4 text-sm font-medium text-muted-foreground">
        投票截止：{formatDateTime(election.votingEndsAt)}
      </p>

      {voter.votedAt && (
        <div className="mt-3 rounded-xl border-2 border-foreground bg-tone-blue-bg px-4 py-3">
          <p className="font-bold">你已於 {formatDateTime(voter.votedAt)} 投過票</p>
          <p className="mt-1 text-sm font-medium">
            截止前可在任何裝置重新投票，以最後一次為準——重投會直接覆蓋上一次的選擇，
            不會重複計票，也不會留下你改過票的紀錄。
          </p>
        </div>
      )}

      <div className="mt-6">
        <VoteForm
          slug={slug}
          electionId={election.id}
          ballotMode={election.ballotMode as "choose" | "approval"}
          maxChoices={election.maxChoices}
          seats={election.seats}
          publicKeyJwk={election.tallyPublicKeyJwk as unknown as JsonWebKey}
          kind={election.kind}
          recallReason={election.recallReason}
          candidates={candidates.map((c) => ({
            id: c.id,
            number: c.number,
            members: c.members as unknown as MemberInfo[],
            platform: c.platform,
          }))}
        />
      </div>
    </PublicShell>
  );
}

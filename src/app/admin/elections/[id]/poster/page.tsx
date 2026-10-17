// 宣傳海報：A4 直式、一張大 QR code，印出來貼教室。
// 兩種版本：登記期貼「想參選？掃碼登記」，投票期貼「掃碼投票」。QR 直接指到登記頁／投票頁
// 而不是選舉詳情頁——少一次點擊，兩頁在非對應階段都會自己說明現在不能登記／投票。
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import QRCode from "qrcode";
import { requireAdmin } from "@/lib/guard";
import { prisma } from "@/lib/db";
import { authConfig } from "@/config/auth";
import { PrintButton } from "@/components/admin/PrintButton";
import { KIND_LABEL, formatDateTime } from "@/components/public/shared";

type Mode = "register" | "vote";

const COPY: Record<Mode, { headline: string; sub: string; period: string; path: string }> = {
  register: {
    headline: "想參選？掃碼登記",
    sub: "用學校 Google 帳號登入，線上送出登記",
    period: "登記期間",
    path: "register",
  },
  vote: {
    headline: "掃碼投票",
    sub: "用學校 Google 帳號登入，手機就能投",
    period: "投票期間",
    path: "vote",
  },
};

// 罷免案沒有登記階段，只有投票版；沒指定就看現在在哪個階段。
function pickMode(param: string | undefined, status: string, canRegister: boolean): Mode {
  if (!canRegister) return "vote";
  if (param === "register" || param === "vote") return param;
  return status === "draft" || status === "registration" ? "register" : "vote";
}

// 只把海報本身印出來：後台的導覽、按鈕全藏掉，海報貼齊紙張。背景色要強制印，
// 瀏覽器預設列印會丟掉背景，Neobrutalism 的色塊就全沒了。
const PRINT_CSS = `
@page { size: A4 portrait; margin: 0; }
@media print {
  body * { visibility: hidden; }
  .poster, .poster * { visibility: visible; }
  .poster { position: fixed; inset: 0; margin: 0; box-shadow: none; }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
}
`;

export default async function PosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { id } = await params;
  await requireAdmin(`/admin/elections/${id}/poster`);

  const election = await prisma.election.findUnique({
    where: { id },
    select: {
      slug: true,
      title: true,
      kind: true,
      status: true,
      hiddenAt: true,
      registrationStartsAt: true,
      registrationEndsAt: true,
      votingStartsAt: true,
      votingEndsAt: true,
    },
  });
  if (!election) notFound();

  const canRegister = election.kind !== "recall";
  const mode = pickMode((await searchParams).mode, election.status, canRegister);

  const copy = COPY[mode];
  const target = new URL(`/e/${election.slug}/${copy.path}`, authConfig.selfUrl).toString();
  const qrSvg = await QRCode.toString(target, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  const qrSrc = `data:image/svg+xml;base64,${Buffer.from(qrSvg).toString("base64")}`;
  const [start, end] =
    mode === "register"
      ? [election.registrationStartsAt, election.registrationEndsAt]
      : [election.votingStartsAt, election.votingEndsAt];

  const notPublic = election.hiddenAt !== null || election.status === "draft";

  return (
    <div className="flex flex-col gap-4">
      <style>{PRINT_CSS}</style>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/admin/elections/${id}`}
          className="inline-flex items-center gap-1.5 text-sm font-bold text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> 回工作台
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {canRegister && (
            <div className="flex rounded-xl border-2 border-foreground bg-card p-0.5 text-sm font-bold">
              {(["register", "vote"] as const).map((m) => (
                <Link
                  key={m}
                  href={`/admin/elections/${id}/poster?mode=${m}`}
                  aria-current={m === mode ? "page" : undefined}
                  className={
                    m === mode
                      ? "rounded-lg bg-foreground px-3 py-1.5 text-background"
                      : "rounded-lg px-3 py-1.5 text-muted-foreground hover:text-foreground"
                  }
                >
                  {m === "register" ? "登記版" : "投票版"}
                </Link>
              ))}
            </div>
          )}
          <PrintButton label="列印 A4" />
        </div>
      </div>

      {notPublic && (
        <p className="rounded-xl border-2 border-foreground bg-tone-orange-bg px-4 py-3 text-sm font-bold text-tone-orange-text">
          這場選舉{election.hiddenAt ? "已被隱藏" : "還是草稿"}，現在掃碼只會看到「找不到頁面」。公開之後再貼。
        </p>
      )}

      <div className="overflow-x-auto">
        <div className="poster mx-auto flex h-[297mm] w-[210mm] flex-col border-[3mm] border-foreground bg-background p-[16mm] text-foreground shadow-[6px_6px_0_0_var(--color-foreground)]">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[9mm] font-extrabold tracking-tight">
              T<span className="text-primary">-</span>Vote
            </span>
            <span className="rounded-[2mm] border-[0.8mm] border-foreground bg-tone-blue-badge px-[4mm] py-[1.5mm] text-[5mm] font-bold">
              {KIND_LABEL[election.kind] ?? election.kind}
            </span>
          </div>

          <h1 className="mt-[14mm] text-[16mm] font-extrabold leading-[1.15] tracking-tight">
            {election.title}
          </h1>
          <p className="mt-[6mm] text-[12mm] font-extrabold text-primary">{copy.headline}</p>
          <p className="mt-[2mm] text-[6mm] font-bold text-muted-foreground">{copy.sub}</p>

          <div className="flex flex-1 items-center justify-center">
            <div className="rounded-[6mm] border-[1.2mm] border-foreground bg-card p-[6mm] shadow-[3mm_3mm_0_0_var(--color-foreground)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- 本地產生的 data URI，不經 next/image。 */}
              <img src={qrSrc} alt={`前往 ${target} 的 QR code`} className="h-[100mm] w-[100mm]" />
            </div>
          </div>

          <div className="rounded-[4mm] border-[0.8mm] border-foreground bg-tone-green-bg px-[6mm] py-[4mm]">
            <p className="text-[5mm] font-bold text-muted-foreground">{copy.period}</p>
            <p className="mt-[1mm] text-[7.5mm] font-extrabold">
              {formatDateTime(start)} – {formatDateTime(end)}
            </p>
          </div>
          <p className="mt-[5mm] break-all font-mono text-[4.5mm] font-bold text-muted-foreground">
            {target}
          </p>
        </div>
      </div>
    </div>
  );
}

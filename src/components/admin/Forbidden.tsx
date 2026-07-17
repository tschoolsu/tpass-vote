// 照抄 tpass-form/src/components/common/Forbidden.tsx。tpass-vote 的 admin 元件不得動 src/components/common/**，
// 所以就地放一份，只服務 /admin 這棵樹。
import Link from "next/link";
import { ShieldX } from "lucide-react";

export function Forbidden({
  title = "沒有權限",
  message = "這個頁面只開放給選舉委員會成員。",
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-24 flex flex-col items-center text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-foreground bg-tone-rose-bg text-tone-rose-text shadow-[4px_4px_0_0_var(--color-foreground)]">
        <ShieldX className="h-8 w-8" />
      </span>
      <h1 className="mt-6 font-extrabold text-2xl tracking-tight">{title}</h1>
      <p className="mt-2 font-medium text-muted-foreground">{message}</p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center gap-2 rounded-xl border-2 border-foreground bg-card px-4 py-2 font-bold text-foreground shadow-[3px_3px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)] active:translate-y-0 active:shadow-[2px_2px_0_0_var(--color-foreground)]"
      >
        回首頁
      </Link>
    </div>
  );
}

// primitives.tsx 的 Button 是原生 <button>，不支援 asChild／不能包 <Link>（會產生非法 <a> 巢狀 <button>）。
// 這裡照抄同一套 Neobrutalism 樣式，另外做一個「長得像按鈕的連結」給 CTA 用。
import Link from "next/link";
import { cn } from "tpass-ui";

type Variant = "primary" | "default" | "accent" | "destructive";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl border-2 border-foreground px-4 py-2 font-bold transition-all duration-200 shadow-[3px_3px_0_0_var(--color-foreground)] hover:-translate-y-0.5 hover:shadow-[5px_5px_0_0_var(--color-foreground)] active:translate-y-0 active:shadow-[2px_2px_0_0_var(--color-foreground)]";

const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground",
  accent: "bg-accent text-primary-foreground",
  default: "bg-card text-foreground",
  destructive: "bg-destructive text-primary-foreground",
};

export function LinkButton({
  href,
  variant = "default",
  className,
  download,
  children,
}: {
  href: string;
  variant?: Variant;
  className?: string;
  /** 指向檔案下載（route handler）時給檔名。走原生 <a>：next/link 會預取 href，等於白白多產一次檔。 */
  download?: string;
  children: React.ReactNode;
}) {
  if (download !== undefined) {
    return (
      <a href={href} download={download} className={cn(BASE, VARIANT[variant], className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cn(BASE, VARIANT[variant], className)}>
      {children}
    </Link>
  );
}

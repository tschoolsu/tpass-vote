// 「回門戶」按鈕。門戶在不同子網域（跨 origin），所以用 <a> 而非 next/link。
// 網址由呼叫端傳入（來自 authConfig.portalUrl，env 驅動，絕不寫死）。
import { LayoutGrid } from "lucide-react";

export function PortalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-md border-2 border-foreground bg-card px-2.5 py-1 font-mono text-[11px] font-bold text-foreground shadow-[2px_2px_0_0_var(--color-foreground)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--color-foreground)]"
    >
      <LayoutGrid className="h-3.5 w-3.5" />
      首頁
    </a>
  );
}

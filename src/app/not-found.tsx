// 打錯網址／場次已下架時的 404（D10-4）。在此之前沒有這個檔案，會落到 Next 預設
// 白畫面（未套用本站字體與樣式）。Server Component：不查 session、不碰資料庫，
// 就算 PG 掛掉也一定能渲染出來。
import type { Metadata } from "next";
import { Compass } from "lucide-react";
import { Card } from "tpass-ui";
import { LinkButton } from "@/components/public/LinkButton";

export const metadata: Metadata = { title: "找不到頁面 — T-Vote" };

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
      <div className="w-full max-w-md">
        <Card>
          <span className="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-foreground bg-muted text-foreground shadow-[3px_3px_0_0_var(--color-foreground)]">
            <Compass className="h-7 w-7" />
          </span>
          <p className="mt-5 font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
            T-VOTE // 404 NOT FOUND
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">找不到這個頁面</h1>
          <p className="mt-3 font-medium text-muted-foreground">
            網址可能打錯了，或者你要找的選舉場次已經不在了。回首頁看看目前進行中的選舉。
          </p>
          <div className="mt-6">
            <LinkButton href="/" variant="primary">
              回首頁
            </LinkButton>
          </div>
        </Card>
      </div>
    </main>
  );
}

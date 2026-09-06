"use client";
// 頁面渲染時拋例外的錯誤邊界（D10-4）——最主要的觸發源是 PG 不可用時 prisma 查詢
// 直接丟例外。沒有這個檔案，使用者看到的是 Next 預設的英文白畫面。
import { useEffect } from "react";
import { ShieldAlert } from "lucide-react";
import { Card, Button } from "tpass-ui";
import { LinkButton } from "@/components/public/LinkButton";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 例外原文只進 console（＝主機 pm2 log），不進畫面：裡面可能有連線字串等內部細節。
    console.error("[error boundary]", error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16 sm:px-6">
      <div className="w-full max-w-md">
        <Card>
          <span className="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-foreground bg-tone-orange-bg text-tone-orange-text shadow-[3px_3px_0_0_var(--color-foreground)]">
            <ShieldAlert className="h-7 w-7" />
          </span>
          <p className="mt-5 font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">
            T-VOTE // 500 ERROR
          </p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">系統暫時出了點問題</h1>
          <p className="mt-3 font-medium text-muted-foreground">
            這不是你的操作造成的。可以先按「再試一次」；如果一直失敗，稍後再回來看看。
          </p>
          {error.digest && (
            <p className="mt-4 rounded-md border-2 border-foreground bg-muted px-3 py-2 font-mono text-xs font-bold text-foreground">
              錯誤代碼：{error.digest}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button type="button" variant="primary" onClick={reset}>
              再試一次
            </Button>
            <LinkButton href="/">回首頁</LinkButton>
          </div>
        </Card>
      </div>
    </main>
  );
}

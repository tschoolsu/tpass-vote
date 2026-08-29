"use client";
// 收據入匭查詢。只比對「密文雜湊前 12 碼」的清單（由 server 端算好傳下來），
// 從不接觸原始密文，也不打任何 API——純前端字串比對。
import * as React from "react";
import { CheckCircle2, Search, XCircle } from "lucide-react";
import { Button, Input, cn } from "tpass-ui";

export function ReceiptLookup({ receipts }: { receipts: string[] }) {
  const [query, setQuery] = React.useState("");
  const [checked, setChecked] = React.useState<string | null>(null);

  const receiptSet = React.useMemo(() => new Set(receipts), [receipts]);
  const found = checked !== null ? receiptSet.has(checked) : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChecked(query.trim().toLowerCase());
  }

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <h2 className="font-extrabold text-base">收據入匭查詢</h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        輸入投票成功後拿到的 12 碼收據，確認你的選票是否已入匭。
      </p>
      <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setChecked(null);
          }}
          placeholder="輸入 12 碼收據"
          maxLength={12}
          className="font-mono"
        />
        <Button type="submit" disabled={query.trim().length === 0}>
          <Search className="h-4 w-4" />
          查詢
        </Button>
      </form>
      {checked !== null && (
        <p
          className={cn(
            "mt-3 flex items-center gap-1.5 font-bold",
            found ? "text-tone-green-text" : "text-destructive",
          )}
        >
          {found ? (
            <>
              <CheckCircle2 className="h-4 w-4" /> 已入匭 ✓
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4" /> 查無此收據
            </>
          )}
        </p>
      )}
    </div>
  );
}

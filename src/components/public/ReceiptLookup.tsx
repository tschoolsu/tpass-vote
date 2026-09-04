"use client";
// 收據查詢。選罷法 §26-1 Ⅳ 要求「去識別化之會員個別意思應於選舉人投票時提供予各該選舉人」——
// 投票時發的 12 碼代碼，開票後要能在這裡查回「那張票的內容」，而不只是「有沒有入匭」。
// 明細由 server 端傳下來（已是去識別化資料），這個元件不打任何 API、不接觸原始密文。
import * as React from "react";
import { CheckCircle2, Search, XCircle } from "lucide-react";
import { Button, Input, cn } from "tpass-ui";
import { describeDisclosure } from "@/components/public/shared";
import type { DisclosureEntry } from "@/lib/disclosure";

export function ReceiptLookup({
  entries,
  candidateLabels,
}: {
  entries: DisclosureEntry[];
  candidateLabels: Record<string, string>;
}) {
  const [query, setQuery] = React.useState("");
  const [checked, setChecked] = React.useState<string | null>(null);

  const byCode = React.useMemo(
    () => new Map(entries.map((e) => [e.code, e])),
    [entries],
  );
  const found = checked !== null ? (byCode.get(checked) ?? null) : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setChecked(query.trim().toLowerCase());
  }

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <h2 className="font-extrabold text-base">收據查詢</h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        輸入投票成功後拿到的 12 碼收據，確認你的選票已入匭，並核對它被記為什麼內容。
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
      {checked !== null &&
        (found ? (
          <div className="mt-3">
            <p className="flex items-center gap-1.5 font-bold text-tone-green-text">
              <CheckCircle2 className="h-4 w-4" /> 已入匭 ✓
            </p>
            <p className="mt-1.5 text-sm font-medium">
              這張票被記為：
              <span className="font-bold">{describeDisclosure(found, candidateLabels)}</span>
            </p>
          </div>
        ) : (
          <p className={cn("mt-3 flex items-center gap-1.5 font-bold", "text-destructive")}>
            <XCircle className="h-4 w-4" /> 查無此收據
          </p>
        ))}
    </div>
  );
}

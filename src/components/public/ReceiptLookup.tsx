"use client";
// 收據查詢。選罷法 §26-1 Ⅳ 要求「去識別化之會員個別意思應於選舉人投票時提供予各該選舉人」——
// 投票時發的 12 碼代碼，開票後要能查回「那張票的內容」，而不只是「有沒有入匭」。
//
// 查詢打 API 而不是把整份明細載進頁面：明細動輒上千筆，每個看結果的人都下載一份會把
// 服務的記憶體推到重啟門檻（壓力測試量過）。伺服器本來就持有完整明細，而代碼與選舉人的
// 連結已在彌封時銷毀，所以「伺服器看得到你查了哪個代碼」不會多洩漏誰投了什麼。
import * as React from "react";
import { CheckCircle2, Loader2, Search, XCircle } from "lucide-react";
import { Button, Input } from "tpass-ui";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "found"; summary: string }
  | { kind: "missing" }
  | { kind: "error" };

export function ReceiptLookup({ slug }: { slug: string }) {
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<State>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = query.trim().toLowerCase();
    if (code === "") return;
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/elections/${encodeURIComponent(slug)}/disclosures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.status === 404) {
        setState({ kind: "missing" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error" });
        return;
      }
      const data = (await res.json()) as { summary: string };
      setState({ kind: "found", summary: data.summary });
    } catch {
      setState({ kind: "error" });
    }
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
            setState({ kind: "idle" });
          }}
          placeholder="輸入 12 碼收據"
          maxLength={12}
          className="font-mono"
        />
        <Button
          type="submit"
          disabled={query.trim().length === 0 || state.kind === "loading"}
          className="shrink-0 whitespace-nowrap"
        >
          {state.kind === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          查詢
        </Button>
      </form>
      {state.kind === "found" && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 font-bold text-tone-green-text">
            <CheckCircle2 className="h-4 w-4" /> 已入匭 ✓
          </p>
          <p className="mt-1.5 text-sm font-medium">
            這張票被記為：<span className="font-bold">{state.summary}</span>
          </p>
        </div>
      )}
      {state.kind === "missing" && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 font-bold text-destructive">
          <XCircle className="h-4 w-4" /> 查無此收據，請確認代碼有沒有抄錯；在確認頁看過但沒有按下送出的代碼不會生效
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="mt-3 font-bold text-destructive">查詢失敗，請稍後再試。</p>
      )}
    </div>
  );
}

// §26-1 Ⅴ：第三份公告應附加刊載「投票暨未投票選舉人名冊」。
// 純展示元件（無 state、無 client 互動），資料由 results 頁在 server 端取得後傳進來。
// 只顯示「這個人投了沒」，永遠不顯示他投了什麼——那是明細表的事，兩者之間沒有連結。
import { Users } from "lucide-react";
import { cn } from "tpass-ui";

export interface RosterRow {
  label: string; // 姓名，沒有姓名時退回 email 的帳號部分
  voted: boolean;
}

export function RosterDisclosure({ rows }: { rows: RosterRow[] }) {
  const votedCount = rows.filter((r) => r.voted).length;

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <h2 className="flex items-center gap-2 font-extrabold text-base">
        <Users className="h-4 w-4" /> 投票暨未投票選舉人名冊
      </h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        共 {rows.length} 人，已投票 {votedCount} 人、未投票 {rows.length - votedCount} 人。
      </p>
      <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border-2 border-foreground/20">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted">
            <tr className="border-b-2 border-foreground text-left font-bold">
              <th className="px-3 py-1.5">選舉人</th>
              <th className="px-3 py-1.5">投票狀態</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.label}-${i}`} className="border-b border-foreground/10">
                <td className="px-3 py-1.5 font-medium">{r.label}</td>
                <td
                  className={cn(
                    "px-3 py-1.5 font-bold",
                    r.voted ? "text-tone-green-text" : "text-muted-foreground",
                  )}
                >
                  {r.voted ? "已投票" : "未投票"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";
// §26-1 Ⅴ：第三份公告應附加刊載「去識別化之會員個別意思」。這張表就是那份附刊本體——
// 每一列是一張票的可回溯代碼與內容，不含任何身分資訊（連結已在彌封時銷毀）。
// 清單可能上百列，用固定高度捲動容器包住，不讓它撐爆頁面。
import * as React from "react";
import { ListChecks } from "lucide-react";
import { describeDisclosure } from "@/components/public/shared";
import type { DisclosureEntry } from "@/lib/disclosure";

export function DisclosureTable({
  entries,
  candidateLabels,
}: {
  entries: DisclosureEntry[];
  candidateLabels: Record<string, string>;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? entries : entries.slice(0, 20);

  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <h2 className="flex items-center gap-2 font-extrabold text-base">
        <ListChecks className="h-4 w-4" /> 去識別化選票明細
      </h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        共 {entries.length} 張。代碼即投票時發給選舉人的收據；系統不保存代碼與選舉人的對應關係。
      </p>
      <div className="mt-3 max-h-96 overflow-y-auto rounded-xl border-2 border-foreground/20">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted">
            <tr className="border-b-2 border-foreground text-left font-bold">
              <th className="px-3 py-1.5">代碼</th>
              <th className="px-3 py-1.5">內容</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.code} className="border-b border-foreground/10">
                <td className="px-3 py-1.5 font-mono text-xs">{e.code}</td>
                <td className="px-3 py-1.5 font-medium">{describeDisclosure(e, candidateLabels)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries.length > shown.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 font-bold text-sm text-accent hover:underline"
        >
          顯示全部 {entries.length} 張
        </button>
      )}
    </div>
  );
}

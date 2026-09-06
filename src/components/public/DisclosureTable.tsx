// §26-1 Ⅴ：第三份公告應附加刊載「去識別化之會員個別意思」。這張表是那份附刊的門面——
// 頁面只渲染前幾十筆讓人看得到形狀，完整資料走 CSV 下載，不把上千筆塞進每一次頁面請求
// （那會在結果公告後的併發尖峰把記憶體推到重啟門檻）。
//
// 純展示，沒有 client 互動，所以不是 client component——資料不會再被序列化一次進 RSC payload。
import { Download, ListChecks } from "lucide-react";
import { describeDisclosure } from "@/components/public/shared";
import type { DisclosureEntry } from "@/lib/disclosure";

export function DisclosureTable({
  slug,
  preview,
  total,
  candidateLabels,
}: {
  slug: string;
  /** 前幾筆，供人一眼看出資料長什麼樣。 */
  preview: DisclosureEntry[];
  total: number;
  candidateLabels: Record<string, string>;
}) {
  return (
    <div className="rounded-2xl border-2 border-foreground bg-card p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <h2 className="flex items-center gap-2 font-extrabold text-base">
        <ListChecks className="h-4 w-4" /> 去識別化選票明細
      </h2>
      <p className="mt-1 text-sm font-medium text-muted-foreground">
        共 {total} 張，以下列出前 {preview.length} 張。代碼即投票時發給選舉人的收據；
        系統不保存代碼與選舉人的對應關係。
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
            {preview.map((e, i) => (
              // D12-3 之後重複代碼是合法狀態（撞號票都標 invalid），code 不再保證唯一。
              <tr key={`${e.code}-${i}`} className="border-b border-foreground/10">
                <td className="px-3 py-1.5 font-mono text-xs">{e.code}</td>
                <td className="px-3 py-1.5 font-medium">{describeDisclosure(e, candidateLabels)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <a
        href={`/api/elections/${slug}/disclosures`}
        className="mt-3 inline-flex items-center gap-1.5 rounded-xl border-2 border-foreground bg-card px-3 py-1.5 font-bold text-sm shadow-[3px_3px_0_0_var(--color-foreground)]"
      >
        <Download className="h-4 w-4" /> 下載完整明細（CSV）
      </a>
    </div>
  );
}

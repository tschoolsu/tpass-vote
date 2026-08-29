// 階段進度列（純顯示，無互動）：已完成 ✓、現在 ●、未到 ○（灰）。
// 截止(closed)＋開票(sealed) 在畫面上合併成一格，用 currentStage（UiStage）算進度；
// status（真實狀態）只用來在目前這格附註「待彌封」或「已彌封‧待開票」，別讓選委以為
// 這是兩個不相干的階段。stages 的順序即步驟順序（一般鏈 6 步／罷免鏈 5 步，見
// components/admin/status.ts 的 UI_STAGES／RECALL_UI_STAGES），呼叫端依 kind 決定傳哪一份。
import { CheckCircle2 } from "lucide-react";
import type { UiStage } from "@/components/admin/status";
import type { ElectionStatus } from "@/lib/election-status";
import { cn } from "tpass-ui";

export function StageProgress({
  currentStage,
  status,
  stages,
  labels,
}: {
  currentStage: UiStage;
  status: ElectionStatus;
  stages: readonly UiStage[];
  labels: Record<UiStage, string>;
}) {
  const currentIndex = stages.indexOf(currentStage);
  const closingNote = status === "closed" ? "待彌封" : status === "sealed" ? "已彌封‧待開票" : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border-2 border-foreground bg-card p-3 font-mono text-xs font-bold">
      {stages.map((s, i) => {
        const done = i < currentIndex;
        const current = i === currentIndex;
        return (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border-2 border-foreground px-2 py-0.5",
                current && "bg-primary text-primary-foreground",
                done && "bg-tone-green-badge text-tone-green-text",
                !current && !done && "bg-card text-muted-foreground/50 border-foreground/30",
              )}
            >
              {done && <CheckCircle2 className="h-3 w-3" />}
              {labels[s]}
              {current && s === "closing" && closingNote && <span className="opacity-80">（{closingNote}）</span>}
            </span>
            {i < stages.length - 1 && <span className="text-muted-foreground/40">─</span>}
          </span>
        );
      })}
    </div>
  );
}

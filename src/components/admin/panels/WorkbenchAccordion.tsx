"use client";
// 多階段面板的收合手風琴：已完成收合成摘要（可點開回顧）、現在展開、未到鎖定灰底不可點。
// 用 UiStage（見 status.ts）而非原始 election status 排序——截止(closed)＋開票(sealed) 合併
// 成同一個 "closing" 階段；currentStatus 變化時（狀態推進，或提交計票結果後純呈現層提前推進
// 到 published）自動展開新的當前階段，讓結果公告草稿提交後立即可見不必手動點開。stages 由
// 呼叫端依 kind 傳入（一般鏈 6 步／罷免鏈 5 步），決定順序與鎖定判斷的基準。
import { useState } from "react";
import { ChevronDown, ChevronRight, Lock, type LucideIcon } from "lucide-react";
import type { UiStage } from "@/components/admin/status";
import { cn } from "tpass-ui";

export interface StepPanelDef {
  status: UiStage;
  icon: LucideIcon;
  title: string;
  summary: React.ReactNode;
  content: React.ReactNode;
}

export function WorkbenchAccordion({
  steps,
  currentStatus,
  stages,
}: {
  steps: StepPanelDef[];
  currentStatus: UiStage;
  stages: readonly UiStage[];
}) {
  const currentIndex = stages.indexOf(currentStatus);
  const [open, setOpen] = useState<Set<UiStage>>(() => new Set([currentStatus]));
  // currentStatus 往前推進時（真的狀態推進，或 resultsExist 讓結果公告提前解鎖），
  // 把新的當前階段補進已展開集合——渲染期間直接調整 state（react.dev 建議的
  // 「用上一輪的值比對」寫法），不用 effect 因為這不是在同步外部系統。
  const [prevStatus, setPrevStatus] = useState(currentStatus);
  if (currentStatus !== prevStatus) {
    setPrevStatus(currentStatus);
    setOpen((prev) => (prev.has(currentStatus) ? prev : new Set(prev).add(currentStatus)));
  }

  function toggle(status: UiStage) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {steps.map((step) => {
        const index = stages.indexOf(step.status);
        const locked = index > currentIndex;
        const current = index === currentIndex;
        const done = index < currentIndex;
        const isOpen = !locked && open.has(step.status);
        const Icon = step.icon;

        return (
          <div
            key={step.status}
            className={cn(
              "rounded-2xl border-2 border-foreground overflow-hidden",
              locked ? "bg-muted/40 border-foreground/30" : "bg-card shadow-[3px_3px_0_0_var(--color-foreground)]",
            )}
          >
            <button
              type="button"
              disabled={locked}
              onClick={() => toggle(step.status)}
              className={cn(
                "flex w-full items-center justify-between gap-3 p-4 text-left",
                locked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
              )}
            >
              <span className="flex items-center gap-3 min-w-0">
                {locked ? (
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : isOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className={cn("font-extrabold", current && "text-primary")}>{step.title}</span>
                  {!isOpen && <span className="ml-2 text-sm font-medium text-muted-foreground">{step.summary}</span>}
                </span>
              </span>
              {done && <span className="shrink-0 font-mono text-[11px] font-bold text-tone-green-text">已完成</span>}
            </button>
            {isOpen && <div className="border-t-2 border-foreground p-4">{step.content}</div>}
          </div>
        );
      })}
    </div>
  );
}

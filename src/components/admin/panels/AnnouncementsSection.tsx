"use client";
// 公告區塊：貫穿全程的持久區塊（不屬於某一個工作台步驟）。三部分：
// 1. 公告建議：純文字提示，列出建議發哪些公告＆建議時機（沿用投票日算相對天數），
//    不綁定任何 slot、不追蹤已發/未發、無按鈕無狀態徽章。
// 2. 全部公告：一般公告（legalTag=null）清單，草稿與已發布都在，可個別收合/展開編輯。
//    「＋ 發新公告」新建的一律 legalTag=null，不提供類型選擇。
//    （legalTag='result' 的結果公告不在此介面出現，專屬步驟⑦「結果公告」面板編輯發布。）
// 3. 已發布歷史時間軸：所有已發布公告（含結果公告）依發布時間排序，附複製連結。
import { useRef, useState } from "react";
import Link from "next/link";
import { Megaphone, Plus, ChevronDown, ChevronRight, Info } from "lucide-react";
import { Badge, Button } from "tpass-ui";
import { CopyLinkButton } from "@/components/public/CopyLinkButton";
import { AnnouncementEditor } from "@/components/admin/AnnouncementEditor";

export interface AnnouncementRow {
  id: string;
  legalTag: string | null;
  title: string;
  body: string;
  publishedAt: Date | null;
  createdAt: Date;
}

const HISTORY_TAG_LABEL: Record<string, string> = {
  result: "結果公告",
};

function shiftDays(d: Date | null, days: number): Date | null {
  return d ? new Date(d.getTime() + days * 86400000) : null;
}

function fmt(d: Date | null): string {
  return d ? d.toLocaleString("zh-TW") : "未設定投票期程";
}

export function AnnouncementsSection({
  electionId,
  slug,
  selfUrl,
  announcements,
  votingStartsAt,
}: {
  electionId: string;
  slug: string;
  selfUrl: string;
  announcements: AnnouncementRow[];
  votingStartsAt: Date | null;
}) {
  const generalAnnouncements = [...announcements.filter((a) => !a.legalTag)].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const publishedHistory = [...announcements.filter((a) => a.publishedAt)].sort(
    (a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime(),
  );

  const suggestions = [
    { label: "登記／投票公告", hint: `建議投票日前 30 日發布・${fmt(shiftDays(votingStartsAt, -30))}` },
    { label: "候選人名單公告", hint: `建議投票日前 14 日發布・${fmt(shiftDays(votingStartsAt, -14))}` },
    { label: "開票結果公告", hint: "開票後自動生成草稿，於步驟⑦「結果公告」編輯發布" },
  ];

  const [openGeneral, setOpenGeneral] = useState<Set<string>>(new Set());
  const [newDraftKeys, setNewDraftKeys] = useState<string[]>([]);
  const keyCounter = useRef(0);

  function toggleGeneral(id: string) {
    setOpenGeneral((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addNewDraft() {
    keyCounter.current += 1;
    setNewDraftKeys((prev) => [...prev, `new-${keyCounter.current}-${Date.now()}`]);
  }

  function discardNewDraft(key: string) {
    setNewDraftKeys((prev) => prev.filter((k) => k !== key));
  }

  function shareUrl(id: string): string {
    return new URL(`/e/${slug}/a/${id}`, selfUrl).toString();
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border-2 border-foreground bg-secondary p-5 shadow-[4px_4px_0_0_var(--color-foreground)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-extrabold text-lg">
          <Megaphone className="h-5 w-5" /> 公告
        </h2>
        <Button type="button" size="sm" variant="primary" onClick={addNewDraft}>
          <Plus className="h-4 w-4" /> 發新公告
        </Button>
      </div>

      {newDraftKeys.map((key) => (
        <AnnouncementEditor
          key={key}
          electionId={electionId}
          id={null}
          onDiscard={() => discardNewDraft(key)}
          onSaved={() => discardNewDraft(key)}
        />
      ))}

      <div className="rounded-xl border-2 border-foreground bg-card p-3">
        <h3 className="mb-2 flex items-center gap-1 font-bold text-sm text-muted-foreground">
          <Info className="h-3.5 w-3.5" /> 公告建議（僅供參考，不綁定發布）
        </h3>
        <ul className="flex flex-col gap-1.5">
          {suggestions.map((s) => (
            <li key={s.label} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-bold text-sm">{s.label}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{s.hint}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 font-bold text-sm text-muted-foreground">全部公告</h3>
        {generalAnnouncements.length === 0 ? (
          <p className="text-sm font-medium text-muted-foreground">尚無公告，點上方「發新公告」開始撰寫。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {generalAnnouncements.map((a) => {
              const isOpen = openGeneral.has(a.id);
              return (
                <div key={a.id} className="rounded-xl border-2 border-foreground bg-card p-3">
                  <button
                    type="button"
                    onClick={() => toggleGeneral(a.id)}
                    className="flex w-full items-center justify-between gap-2 text-left"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {isOpen ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="font-bold text-sm truncate">{a.title}</span>
                    </span>
                    {a.publishedAt ? (
                      <Badge className="bg-tone-green-badge text-tone-green-text shrink-0">已發布</Badge>
                    ) : (
                      <Badge className="bg-card shrink-0">草稿</Badge>
                    )}
                  </button>
                  {isOpen && (
                    <div className="mt-3">
                      <AnnouncementEditor
                        electionId={electionId}
                        id={a.id}
                        initialTitle={a.title}
                        initialBody={a.body}
                        publishedAt={a.publishedAt}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 font-bold text-sm text-muted-foreground">已發布歷史</h3>
        {publishedHistory.length === 0 ? (
          <p className="text-sm font-medium text-muted-foreground">尚無已發布公告。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {publishedHistory.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border-2 border-foreground bg-card px-3 py-2"
              >
                <div className="min-w-0">
                  <Link href={`/e/${slug}/a/${a.id}`} className="font-bold text-sm text-accent hover:underline">
                    {a.title}
                  </Link>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {a.legalTag && <>{HISTORY_TAG_LABEL[a.legalTag] ?? a.legalTag}・</>}
                    {a.publishedAt!.toLocaleString("zh-TW")}
                  </p>
                </div>
                <CopyLinkButton url={shareUrl(a.id)} size="sm" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

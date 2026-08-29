"use client";
// ②成立與答辯面板（罷免鏈專屬）：被罷免人答辯書（選填、可留白）＋推進投票的 precheck／按鈕。
// precheck 與按鈕重用 ElectionWorkbench 已算好的 votingPrecheck／advanceStatus，這裡只是把
// 同一份判斷用跟 CurrentStageCard 一致的呈現風格再放進本階段面板內，不重新定義規則。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button, Textarea } from "tpass-ui";
import { ConfirmActionButton } from "@/components/admin/ConfirmActionButton";
import { saveRecallDefense } from "@/app/admin/elections/[id]/recall/actions";

type Result = { ok: true } | { ok: false; error: string };

export function RecallEstablishedPanel({
  electionId,
  defense,
  precheck,
  blocked,
  onAdvance,
}: {
  electionId: string;
  defense: string;
  precheck: { label: string; ok: boolean; detail?: string }[];
  blocked: boolean;
  onAdvance: () => Promise<Result>;
}) {
  const router = useRouter();
  const [text, setText] = useState(defense);
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function handleSave() {
    setMsg(null);
    startTransition(async () => {
      const result = await saveRecallDefense(electionId, text);
      if (!result.ok) {
        setMsg(result.error);
        return;
      }
      setMsg("答辯書已儲存。");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-extrabold mb-2">被罷免人答辯書（選填）</h3>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="被罷免人可就罷免事由提出答辯，將隨結果公告一併呈現。留白亦可推進投票。"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" variant="primary" size="sm" disabled={pending} onClick={handleSave}>
            {pending ? "儲存中…" : "儲存答辯書"}
          </Button>
          {msg && <p className="font-mono text-xs font-bold">{msg}</p>}
        </div>
      </div>

      <div className="border-t-2 border-dashed border-foreground/30 pt-4">
        <h3 className="font-extrabold mb-2">推進投票</h3>
        <ul className="mb-3 flex flex-col gap-1">
          {precheck.map((c) => (
            <li key={c.label} className="flex items-center gap-1.5 text-sm font-medium">
              {c.ok ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-tone-green-text" />
              ) : (
                <XCircle className="h-4 w-4 shrink-0 text-destructive" />
              )}
              {c.label}
              {c.detail && <span className="text-muted-foreground">（{c.detail}）</span>}
            </li>
          ))}
        </ul>
        <ConfirmActionButton
          action={onAdvance}
          label="推進到「投票中」"
          variant="primary"
          disabled={blocked}
          confirmMessage="確定要把罷免案推進到「投票中」嗎？狀態機只能單向前進，無法回頭。"
        />
      </div>
    </div>
  );
}

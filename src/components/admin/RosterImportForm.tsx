"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Textarea, Button } from "tpass-ui";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";

// 截斷顯示的筆數上限：名冊動輒幾百人，全列出來會把畫面撐爆，只給前 N 筆＋總數。
const MAX_SHOWN_SKIPPED = 20;

export function RosterImportForm({ electionId }: { electionId: string }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [skippedLines, setSkippedLines] = useState<{ line: number; raw: string }[]>([]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await importRoster(electionId, raw);
      if (!result.ok) {
        setSkippedLines([]);
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({
        ok: true,
        text: `已匯入 ${result.imported} 筆${result.skipped ? `（略過 ${result.skipped} 筆格式錯誤）` : ""}`,
      });
      setSkippedLines(result.skippedLines);
      // 有略過的行就留著輸入內容，讓使用者能對照原文找出問題；全部成功才清空。
      if (result.skippedLines.length === 0) setRaw("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={6}
        placeholder={"一行一個，可加姓名：\nalice@tschool.tp.edu.tw,王小明\nbob@tschool.tp.edu.tw"}
        className="font-mono text-sm"
      />
      <Button type="submit" variant="primary" size="sm" disabled={pending || raw.trim() === ""}>
        <Upload className="h-4 w-4" /> {pending ? "匯入中…" : "匯入名冊"}
      </Button>
      {message && (
        <p className={`font-mono text-xs font-bold ${message.ok ? "text-primary" : "text-destructive"}`}>
          {message.text}
        </p>
      )}
      {skippedLines.length > 0 && (
        <div className="rounded-xl border-2 border-foreground bg-tone-orange-bg p-2 text-xs font-medium text-tone-orange-text">
          <p className="font-bold">被略過的行（格式不是「email」或「email,姓名」）：</p>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {skippedLines.slice(0, MAX_SHOWN_SKIPPED).map((s) => (
              <li key={s.line}>
                第 {s.line} 行：{s.raw || "（空白）"}
              </li>
            ))}
          </ul>
          {skippedLines.length > MAX_SHOWN_SKIPPED && (
            <p className="mt-1">…以及其他共 {skippedLines.length} 筆，其餘未列出。</p>
          )}
        </div>
      )}
    </form>
  );
}

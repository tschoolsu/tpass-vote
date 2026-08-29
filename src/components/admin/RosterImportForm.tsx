"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Textarea, Button } from "tpass-ui";
import { importRoster } from "@/app/admin/elections/[id]/roster/actions";

export function RosterImportForm({ electionId }: { electionId: string }) {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await importRoster(electionId, raw);
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({
        ok: true,
        text: `已匯入 ${result.imported} 筆${result.skipped ? `（略過 ${result.skipped} 筆格式錯誤）` : ""}`,
      });
      setRaw("");
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
    </form>
  );
}

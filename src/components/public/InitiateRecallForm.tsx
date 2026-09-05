"use client";
// 發起罷免表單（公開端，領銜人）。填罷免事由＋領銜確認，送出後導向連署頁。
// 硬條件（就職滿 2 個月等）已在 server action 二次驗證，這裡只是 UX。
import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button, Textarea, Label } from "tpass-ui";
import { initiateRecall } from "@/app/offices/[id]/recall/actions";

export function InitiateRecallForm({ officeId }: { officeId: string }) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [confirmed, setConfirmed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await initiateRecall(officeId, reason);
      if (!res.ok) {
        setError(res.error);
        if (res.existingSlug) router.push(`/e/${res.existingSlug}`);
        return;
      }
      router.push(`/e/${res.slug}`);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="reason">罷免事由</Label>
        <Textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          rows={5}
          maxLength={4000}
          className="mt-1 min-h-32"
          placeholder="請說明罷免事由（支援 markdown，將公開顯示於連署頁）"
        />
      </div>

      <label className="flex items-start gap-2 rounded-xl border-2 border-foreground bg-secondary p-3 text-sm font-bold">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
        我以自己的身分作為本罷免案的領銜人發起，並自動列為第一位連署人。
      </label>

      {error && (
        <p role="alert" className="flex items-start gap-1.5 rounded-xl border-2 border-destructive bg-card p-3 text-sm font-bold text-destructive">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      <Button type="submit" variant="destructive" disabled={submitting || !confirmed || reason.trim() === ""}>
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        發起罷免、開始連署
      </Button>
    </form>
  );
}

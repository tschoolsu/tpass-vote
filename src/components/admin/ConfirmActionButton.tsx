"use client";
// 通用「按下去會改狀態」按鈕：可選 confirm() 二次確認、pending 態、錯誤訊息、成功後 router.refresh()。
// 給狀態機推進 / 彌封 / 移除名冊 這類單一 server action 呼叫共用，避免每頁各寫一份。
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, ConfirmDialog, type ButtonProps } from "tpass-ui";

type Result = { ok: true } | { ok: false; error: string };

export function ConfirmActionButton({
  action,
  label,
  pendingLabel,
  confirmMessage,
  variant = "default",
  size = "md",
  className,
  disabled,
}: {
  action: () => Promise<Result>;
  label: React.ReactNode;
  pendingLabel?: React.ReactNode;
  confirmMessage?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function runAction() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      setConfirmOpen(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleClick() {
    if (confirmMessage) {
      setConfirmOpen(true);
      return;
    }
    runAction();
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={disabled || pending}
        onClick={handleClick}
      >
        {pending ? (pendingLabel ?? "處理中…") : label}
      </Button>
      {error && <p role="alert" className="font-mono text-xs font-bold text-destructive">{error}</p>}
      {confirmMessage && (
        <ConfirmDialog
          open={confirmOpen}
          title="請確認"
          description={<div className="whitespace-pre-wrap">{confirmMessage}</div>}
          pending={pending}
          onConfirm={runAction}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// 複製連結按鈕。照抄 tpass-form/src/components/common/CopyLinkButton.tsx 的模式。
"use client";

import * as React from "react";
import { Check, Link2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/primitives";

interface Props extends Omit<ButtonProps, "onClick" | "children"> {
  url: string;
  label?: string;
  iconOnly?: boolean;
}

export function CopyLinkButton({
  url,
  label = "複製連結",
  iconOnly = false,
  size = "sm",
  variant = "default",
  ...rest
}: Props) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 非安全情境（例如非 https）clipboard API 會被拒；退回選取文字讓使用者自行複製。
      const selection = window.getSelection();
      const el = document.createElement("textarea");
      el.value = url;
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } finally {
        el.remove();
        selection?.removeAllRanges();
      }
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={copy}
      aria-label={iconOnly ? (copied ? "已複製" : label) : undefined}
      title={iconOnly ? label : undefined}
      {...rest}
    >
      {copied ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
      {!iconOnly && (copied ? "已複製" : label)}
    </Button>
  );
}

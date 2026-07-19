// 極簡、安全的 markdown 渲染：純文字切段直接組 React element，從不經過 HTML 字串，
// 天生免疫 XSS——不需要、也不用 dangerouslySetInnerHTML。
// 支援：#/##/### 標題、空行分段落、- / * 條列、**粗體**、[文字](url) 連結
// （連結 scheme 只允許 http/https/mailto，其他一律降級為純文字）。
// 夠公告與候選人政見用，不追求完整 CommonMark。
import * as React from "react";

export function Markdown({ text }: { text: string }) {
  return <div className="space-y-3 leading-relaxed">{parseBlocks(text)}</div>;
}

function isListLine(line: string): boolean {
  return line.startsWith("- ") || line.startsWith("* ");
}

function isHeadingLine(line: string): boolean {
  return line.startsWith("### ") || line.startsWith("## ") || line.startsWith("# ");
}

function parseBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push(
        <h4 key={key++} className="font-extrabold text-base">
          {inline(line.slice(4))}
        </h4>,
      );
      i++;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push(
        <h3 key={key++} className="font-extrabold text-lg">
          {inline(line.slice(3))}
        </h3>,
      );
      i++;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push(
        <h2 key={key++} className="font-extrabold text-xl">
          {inline(line.slice(2))}
        </h2>,
      );
      i++;
      continue;
    }

    if (isListLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isListLine(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-1 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 一般段落：吃到下一個空行或特殊行為止，段內用 <br/> 保留換行。
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isHeadingLine(lines[i]) &&
      !isListLine(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((l, idx) => (
          <React.Fragment key={idx}>
            {inline(l)}
            {idx < para.length - 1 && <br />}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "mailto"]);

/** 只允許 http/https/mailto scheme；沒有 scheme 或其他 scheme（javascript:、data: 等）一律拒絕。 */
function isAllowedHref(href: string): boolean {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href.trim());
  if (!match) return false;
  return ALLOWED_LINK_SCHEMES.has(match[1].toLowerCase());
}

/** 行內 **bold** 與 [文字](url)：切字串組節點，不解析成 HTML、不進 innerHTML。 */
function inline(line: string): React.ReactNode[] {
  const parts = line
    .split(/(\*\*[^*]+\*\*|\[[^\]]*\]\([^)]*\))/g)
    .filter((s) => s !== "");

  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }

    const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(part);
    if (linkMatch) {
      const [, label, href] = linkMatch;
      if (isAllowedHref(href)) {
        return (
          <a
            key={idx}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-bold text-accent underline decoration-2 hover:no-underline"
          >
            {label || href}
          </a>
        );
      }
      // scheme 不在白名單：降級為純文字（保留使用者打的文字，不留 href）。
      return <React.Fragment key={idx}>{label || part}</React.Fragment>;
    }

    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

import { Fragment, type ReactNode } from "react";

// Minimal, safe markdown for chat answers: paragraphs, bullet/numbered lists,
// **bold**, `code`, and simple pipe tables. No HTML is ever injected.

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p.startsWith("`") && p.endsWith("`") ? <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{p.slice(1, -1)}</code>
      : <Fragment key={i}>{p}</Fragment>,
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line.split("|").slice(1, -1).map((c) => c.trim());
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim())); i++; }
      out.push(
        <div key={out.length} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">{header.map((h, j) => <th key={j} className="px-2 py-1.5 font-medium">{inline(h)}</th>)}</tr></thead>
            <tbody className="divide-y">{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} className="px-2 py-1.5">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")); i++; }
      const L = ordered ? "ol" : "ul";
      out.push(<L key={out.length} className={ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</L>);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { out.push(<p key={out.length} className="font-semibold">{inline(line.replace(/^#+\s/, ""))}</p>); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push(<p key={out.length}>{inline(para.join(" "))}</p>);
  }
  return <div className="space-y-3 text-sm leading-relaxed">{out}</div>;
}

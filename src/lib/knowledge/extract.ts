import Papa from "papaparse";

// Turns an uploaded file into plain text (+ table shape for CSVs).

export interface Extracted {
  text: string;
  columns?: number;
  rows?: number;
}

export async function extractText(buf: Buffer, mime: string | null, name: string): Promise<Extracted> {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime === "application/pdf" || ext === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      return { text: result.text };
    } finally {
      await parser.destroy().catch(() => {});
    }
  }
  if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value };
  }
  if (ext === "csv" || ext === "tsv" || mime === "text/csv") {
    const parsed = Papa.parse<string[]>(buf.toString("utf8"), { skipEmptyLines: true });
    const rows = parsed.data;
    const header = rows[0] ?? [];
    // Render as "Header: value" lines so each row stays meaningful when chunked.
    const text = rows
      .slice(1)
      .map((r) => header.map((h, i) => (r[i] ? `${h}: ${r[i]}` : "")).filter(Boolean).join(" · "))
      .join("\n");
    return { text: `Columns: ${header.join(", ")}\n${text}`, columns: header.length, rows: Math.max(0, rows.length - 1) };
  }
  if (ext === "html" || ext === "htm" || mime === "text/html") return { text: htmlToText(buf.toString("utf8")) };
  if (["txt", "md", "markdown", "json"].includes(ext) || mime?.startsWith("text/")) return { text: buf.toString("utf8") };
  throw new Error(`Unsupported file type: ${name}. Upload PDF, DOCX, CSV, TXT, MD or HTML.`);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** ~1,200-char chunks on paragraph boundaries with a little overlap. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\s*\n|\n(?=[A-Z0-9•\-*])/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n" + p).length > size && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(-overlap) + "\n" + p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
    while (cur.length > size * 1.5) {
      chunks.push(cur.slice(0, size).trim());
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

"use client";

import { useState } from "react";

// Ranked horizontal bars, one hue (validated --chart-bar), 4px rounded data
// end on a shared baseline, hover tooltip per bar, and the numbers in a
// right-hand column so identity/value never depends on color.
export function BarList({ rows, label, unit, sort = false }: { rows: { key: string; label: string; value: number }[]; label: string; unit: string; sort?: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const data = sort ? [...rows].sort((a, b) => b.value - a.value) : rows;
  const max = Math.max(1, ...data.map((r) => r.value));
  const total = data.reduce((s, r) => s + r.value, 0);
  return (
    <figure className="rounded-xl border bg-card p-4" aria-label={label}>
      <ul className="space-y-3">
        {data.map((r) => {
          const pct = total ? Math.round((r.value / total) * 100) : 0;
          return (
            <li
              key={r.key}
              className="group relative grid grid-cols-[8rem_1fr_3.5rem] items-center gap-3 text-sm"
              onMouseEnter={() => setHover(r.key)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(r.key)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${r.label}: ${r.value} ${unit} (${pct}%)`}
            >
              <span className="truncate text-muted-foreground">{r.label}</span>
              <div className="relative h-5">
                <div className="absolute inset-y-1.5 left-0 right-0 rounded-sm bg-muted/60" />
                <div
                  className="absolute inset-y-1 left-0 rounded-r-[4px] bg-chart-bar transition-opacity group-hover:opacity-90"
                  style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 3 : 0 }}
                />
                {hover === r.key ? (
                  <div role="tooltip" className="pointer-events-none absolute -top-9 left-0 z-10 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">
                    <span className="font-medium">{r.label}</span> · {r.value.toLocaleString()} {unit} · {pct}%
                  </div>
                ) : null}
              </div>
              <span className="text-right tabular-nums">{r.value.toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-3 text-xs text-muted-foreground">{total.toLocaleString()} {unit} total</figcaption>
    </figure>
  );
}

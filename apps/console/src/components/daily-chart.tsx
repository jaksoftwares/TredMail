"use client";

import { useLayoutEffect, useRef, useState } from "react";

export interface DayPoint {
  date: string; // YYYY-MM-DD (UTC)
  sent: number;
  delivered: number;
  deferred: number;
  bounced: number;
  complained: number;
  failed: number;
  opened: number;
  clicked: number;
}

const HEIGHT = 180;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PAD_LEFT = 36;

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

/** A step that keeps the axis to round numbers, at most three gridlines. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * magnitude).find((s) => s * 2 >= value / 2) ?? magnitude * 10;
  return Math.ceil(value / step) * step;
}

const ROWS: Array<[keyof DayPoint, string]> = [
  ["delivered", "Delivered"],
  ["sent", "Sent"],
  ["deferred", "Delayed"],
  ["bounced", "Bounced"],
  ["complained", "Spam complaints"],
  ["failed", "Failed"],
  ["opened", "Opened"],
  ["clicked", "Clicked"],
];

/**
 * Delivered emails per day: one series, bars anchored to the baseline. Hover or focus a bar
 * for every outcome that day; the table view lists all values without hovering.
 */
/** The element's width in CSS pixels, so the SVG draws 1:1 and its text stays 11px. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(720);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function DailyChart({ data }: { data: DayPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const max = niceMax(Math.max(...data.map((d) => d.delivered), 1));
  const plotWidth = width - PAD_LEFT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = plotWidth / data.length;
  const barWidth = Math.max(2, slot - 2); // 2px surface gap between bars
  const y = (v: number) => PAD_TOP + plotHeight - (v / max) * plotHeight;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / Math.max(3, Math.floor(width / 110)));
  const point = active !== null ? data[active] : null;

  return (
    <div ref={containerRef}>
      <div className="mb-2 flex justify-end">
        <button type="button" onClick={() => setShowTable(!showTable)} className="text-xs font-semibold text-navy underline">
          {showTable ? "Chart" : "Table"}
        </button>
      </div>
      {showTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface text-subtle">
              <tr>
                <th className="py-1 pr-3 font-semibold">Day</th>
                {ROWS.map(([key, label]) => (
                  <th key={key} className="py-1 pr-3 text-right font-semibold">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...data].reverse().map((d) => (
                <tr key={d.date}>
                  <td className="py-1 pr-3">{dayLabel(d.date)}</td>
                  {ROWS.map(([key]) => (
                    <td key={key} className="py-1 pr-3 text-right tabular-nums">{d[key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" onPointerLeave={() => setActive(null)}>
          <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} className="block max-w-full" role="img" aria-label="Delivered emails per day">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD_LEFT} x2={width} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
                <text x={PAD_LEFT - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-subtle)">
                  {Number.isInteger(t) ? t.toLocaleString() : t.toFixed(1)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD_LEFT + i * slot + 1;
              const h = Math.max(0, y(0) - y(d.delivered));
              const r = Math.min(4, barWidth / 2, h);
              const top = y(0) - h;
              // Rounded data end at the top, square at the baseline
              const path =
                h === 0
                  ? ""
                  : `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + barWidth - r} Q${x + barWidth},${top} ${x + barWidth},${top + r} V${y(0)} Z`;
              return (
                <g key={d.date}>
                  {path && <path d={path} fill="var(--color-orange)" opacity={active === null || active === i ? 1 : 0.55} />}
                  {/* Hit target: the whole column, so empty days can be inspected too */}
                  <rect
                    x={PAD_LEFT + i * slot}
                    y={PAD_TOP}
                    width={slot}
                    height={plotHeight}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${dayLabel(d.date)}: ${d.delivered} delivered`}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className="cursor-default outline-none"
                  />
                  {i % labelEvery === 0 && (
                    <text x={x + barWidth / 2} y={HEIGHT - 6} textAnchor="middle" fontSize={11} fill="var(--color-subtle)">
                      {dayLabel(d.date)}
                    </text>
                  )}
                </g>
              );
            })}
            <line x1={PAD_LEFT} x2={width} y1={y(0)} y2={y(0)} stroke="var(--color-navy-200)" strokeWidth={1} />
          </svg>
          {point && active !== null && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-48 rounded-md border border-line bg-surface p-3 text-xs shadow-md"
              style={{
                left: `${Math.min(Math.max(((PAD_LEFT + (active + 0.5) * slot) / width) * 100, 12), 76)}%`,
                transform: "translateX(-50%)",
              }}
            >
              <p className="mb-1.5 font-semibold text-subtle">{dayLabel(point.date)}</p>
              <dl className="space-y-0.5">
                {ROWS.map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <dt className="flex items-center gap-1.5 text-muted">
                      {key === "delivered" && <span className="inline-block h-0.5 w-3 bg-orange" aria-hidden />}
                      {label}
                    </dt>
                    <dd className="font-bold tabular-nums text-navy">{point[key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

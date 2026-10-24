import React, { useRef, useState } from 'react';
import { cn } from '../../../lib/utils.js';

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

const WIDTH = 600;

/**
 * One series over time: a 2px line over a light area, a recessive grid and a crosshair with a
 * tooltip on hover. Several measures are several charts (small multiples), never extra axes.
 */
export function AreaChart({
  title,
  points,
  formatX,
  formatY,
  height = 120,
  step = false,
  className,
  'data-testid': testId,
}: {
  readonly title: string;
  readonly points: readonly ChartPoint[];
  readonly formatX: (x: number) => string;
  readonly formatY: (y: number) => string;
  readonly height?: number;
  /** Straight segments between the points (a plan) instead of a measured line. */
  readonly step?: boolean;
  readonly className?: string;
  readonly 'data-testid'?: string;
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const maxX = Math.max(1, ...points.map((point) => point.x));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const px = (x: number) => (x / maxX) * WIDTH;
  const py = (y: number) => height - (y / maxY) * (height - 10) - 1;
  const line = points.map((point) => `${px(point.x)},${py(point.y)}`).join(' ');
  const area = points.length
    ? `M${px(points[0]!.x)},${height} L${line.replace(/ /g, ' L')} L${px(points.at(-1)!.x)},${height} Z`
    : '';
  const current = hover !== null ? points[hover] : undefined;

  const onMove = (event: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const x = ((event.clientX - rect.left) / rect.width) * maxX;
    let nearest = 0;
    points.forEach((point, index) => {
      if (Math.abs(point.x - x) < Math.abs(points[nearest]!.x - x)) nearest = index;
    });
    setHover(nearest);
  };

  return (
    <figure className={cn('flex min-w-0 flex-col gap-2', className)} data-testid={testId}>
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--text-secondary)]">{title}</span>
        <span className="font-mono text-[var(--text-muted)]">{formatY(maxY)}</span>
      </figcaption>
      <div
        ref={box}
        className="relative"
        style={{ height }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          role="img"
          aria-label={title}
        >
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={0}
              x2={WIDTH}
              y1={height * fraction}
              y2={height * fraction}
              stroke="var(--border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={WIDTH}
            y1={height}
            y2={height}
            stroke="var(--border-strong)"
            vectorEffect="non-scaling-stroke"
          />
          <path d={area} fill="var(--fill-accent)" opacity={0.12} />
          <polyline
            points={line}
            fill="none"
            stroke="var(--fill-accent)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {step &&
            points.map((point, index) => (
              <line
                key={index}
                x1={px(point.x)}
                x2={px(point.x)}
                y1={py(point.y)}
                y2={height}
                stroke="var(--border)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
        {current && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-[var(--border-strong)]"
              style={{ left: `${(current.x / maxX) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface-0)] bg-[var(--fill-accent)]"
              style={{ left: `${(current.x / maxX) * 100}%`, top: py(current.y) }}
            />
            <div
              role="tooltip"
              className="pointer-events-none absolute -top-1 z-10 -translate-y-full whitespace-nowrap rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] shadow-lg"
              style={{
                left: `${(current.x / maxX) * 100}%`,
                transform: `translate(${current.x / maxX > 0.7 ? '-100%' : '0'}, -100%)`,
              }}
            >
              <span className="text-[var(--text-muted)]">{formatX(current.x)}</span>
              <span className="ml-2 font-mono font-semibold text-[var(--text-primary)]">
                {formatY(current.y)}
              </span>
            </div>
          </>
        )}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
        <span>{formatX(0)}</span>
        <span>{formatX(maxX)}</span>
      </div>
    </figure>
  );
}

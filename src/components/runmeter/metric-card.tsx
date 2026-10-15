import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
  delta?: number;
  icon: LucideIcon;
  points: number[];
  tone?: "default" | "success" | "danger" | "warning";
  deltaDirection?: "higher-is-better" | "lower-is-better";
};

const toneStyles = {
  default: "text-primary",
  success: "text-emerald-300",
  danger: "text-rose-300",
  warning: "text-amber-300",
};

function Sparkline({ points, tone }: Pick<MetricCardProps, "points" | "tone">) {
  const width = 104;
  const height = 31;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(max - min, 1);
  const coords = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - ((point - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Recent trend"
      className={cn("h-8 w-[104px] overflow-visible", toneStyles[tone ?? "default"])}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={coords}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={width}
        cy={coords.split(" ").at(-1)?.split(",")[1] ?? height / 2}
        r="2.5"
        fill="currentColor"
      />
    </svg>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  delta,
  icon: Icon,
  points,
  tone = "default",
  deltaDirection = "higher-is-better",
}: MetricCardProps) {
  const DeltaIcon = (delta ?? 0) >= 0 ? ArrowUpRight : ArrowDownRight;
  const favorable =
    deltaDirection === "lower-is-better"
      ? (delta ?? 0) <= 0
      : (delta ?? 0) >= 0;

  return (
    <Card className="relative overflow-hidden border-border/80 bg-card py-0 shadow-none transition-colors hover:border-border">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            {label}
          </div>
          <span className="font-mono text-[9px] uppercase tracking-[0.13em] text-muted-foreground">
            Live
          </span>
        </div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="metric-number text-[26px] font-medium leading-none text-foreground">
              {value}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {delta !== undefined && (
                <span
                  className={cn(
                    "inline-flex items-center font-mono font-medium",
                    favorable ? "text-emerald-300" : "text-rose-300",
                  )}
                >
                  <DeltaIcon className="me-0.5 size-3" aria-hidden="true" />
                  {Math.abs(delta).toFixed(1)}%
                </span>
              )}
              <span className="truncate">{detail}</span>
            </div>
          </div>
          <Sparkline points={points} tone={tone} />
        </div>
      </CardContent>
    </Card>
  );
}

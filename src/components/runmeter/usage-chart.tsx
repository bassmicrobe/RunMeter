"use client";

import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { UsageChartPoint } from "@/lib/runmeter-types";
import { useLocalTimeZone } from "@/hooks/use-local-time-zone";

const chartConfig = {
  uncachedInput: {
    label: "入力",
    color: "var(--chart-2)",
  },
  cachedTokens: {
    label: "キャッシュ",
    color: "var(--chart-3)",
  },
  outputTokens: {
    label: "出力",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const compactNumber = new Intl.NumberFormat("ja-JP", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function UsageChart({ data }: { data: UsageChartPoint[] }) {
  const timeZone = useLocalTimeZone();
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone,
      }),
    [timeZone],
  );
  const tooltipTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone,
      }),
    [timeZone],
  );
  const normalized = data.map((point) => ({
    ...point,
    uncachedInput: Math.max(point.inputTokens - point.cachedTokens, 0),
  }));

  return (
    <ChartContainer
      config={chartConfig}
      className="h-[252px] w-full aspect-auto"
      initialDimension={{ width: 760, height: 252 }}
      role="group"
      aria-label="入力、キャッシュ、出力トークンの推移グラフ"
    >
      <AreaChart
        accessibilityLayer
        data={normalized}
        margin={{ top: 8, right: 4, bottom: 0, left: -8 }}
      >
        <defs>
          <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-outputTokens)" stopOpacity={0.34} />
            <stop offset="95%" stopColor="var(--color-outputTokens)" stopOpacity={0.03} />
          </linearGradient>
          <linearGradient id="fillCached" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-cachedTokens)" stopOpacity={0.2} />
            <stop offset="95%" stopColor="var(--color-cachedTokens)" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-uncachedInput)" stopOpacity={0.16} />
            <stop offset="95%" stopColor="var(--color-uncachedInput)" stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="2 5" />
        <XAxis
          dataKey="timestamp"
          axisLine={false}
          tickLine={false}
          minTickGap={36}
          tickMargin={10}
          tickFormatter={(value: string) => timeFormatter.format(new Date(value))}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={44}
          tickFormatter={(value: number) => compactNumber.format(value)}
        />
        <ChartTooltip
          cursor={{ stroke: "var(--border)", strokeDasharray: "3 3" }}
          content={
            <ChartTooltipContent
              className="min-w-44 border-border bg-popover"
              labelFormatter={(_, payload) => {
                const timestamp = payload?.[0]?.payload?.timestamp;
                return timestamp
                  ? tooltipTimeFormatter.format(new Date(timestamp))
                  : "";
              }}
            />
          }
        />
        <Area
          dataKey="uncachedInput"
          type="monotone"
          stackId="tokens"
          stroke="var(--color-uncachedInput)"
          fill="url(#fillInput)"
          strokeWidth={1.25}
          isAnimationActive={false}
        />
        <Area
          dataKey="cachedTokens"
          type="monotone"
          stackId="tokens"
          stroke="var(--color-cachedTokens)"
          fill="url(#fillCached)"
          strokeWidth={1.25}
          isAnimationActive={false}
        />
        <Area
          dataKey="outputTokens"
          type="monotone"
          stackId="tokens"
          stroke="var(--color-outputTokens)"
          fill="url(#fillOutput)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

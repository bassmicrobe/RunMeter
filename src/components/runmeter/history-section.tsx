"use client";

import { useSyncExternalStore } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  AgentHistoryMatrixCell,
  AgentTelemetry,
  DailyHistoryPoint,
  ProviderConnection,
  ProviderHistoryMatrixCell,
} from "@/lib/runmeter-types";
import {
  formatCompactNumber,
  formatCurrency,
  formatInteger,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { SectionHeading } from "./section-heading";

const DESKTOP_MATRIX_MEDIA_QUERY = "(min-width: 40rem)";

function subscribeToDesktopMatrix(
  onStoreChange: () => void,
): () => void {
  const mediaQuery = window.matchMedia(DESKTOP_MATRIX_MEDIA_QUERY);
  mediaQuery.addEventListener("change", onStoreChange);

  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function getDesktopMatrixSnapshot(): boolean {
  return window.matchMedia(DESKTOP_MATRIX_MEDIA_QUERY).matches;
}

function getServerDesktopMatrixSnapshot(): boolean {
  return false;
}

function useDesktopMatrix(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopMatrix,
    getDesktopMatrixSnapshot,
    getServerDesktopMatrixSnapshot,
  );
}

const chartConfig = {
  totalTokens: {
    label: "トークン",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function DailyHistoryChart({
  data,
  showCost,
  showRuns,
}: {
  data: DailyHistoryPoint[];
  showCost: boolean;
  showRuns: boolean;
}) {
  return (
    <ChartContainer
      config={chartConfig}
      className="h-[210px] w-full aspect-auto"
      initialDimension={{ width: 650, height: 210 }}
      role="group"
      aria-label="日ごとのトークン使用量の棒グラフ"
    >
      <BarChart
        accessibilityLayer
        data={data}
        margin={{ top: 8, right: 4, bottom: 0, left: -10 }}
      >
        <CartesianGrid vertical={false} strokeDasharray="2 5" />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tickMargin={10}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={46}
          tickFormatter={(value: number) => formatCompactNumber(value)}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.35 }}
          content={
            <ChartTooltipContent
              className="min-w-40 border-border bg-popover"
              formatter={(value, _name, item) => (
                <div className="grid w-full gap-1.5">
                  <div className="flex items-center justify-between gap-6">
                    <span className="text-muted-foreground">トークン</span>
                    <span className="metric-number">{formatCompactNumber(Number(value))}</span>
                  </div>
                  {showCost && item.payload.costUsd > 0 ? (
                    <div className="flex items-center justify-between gap-6">
                      <span className="text-muted-foreground">料金</span>
                      <span className="metric-number">{formatCurrency(item.payload.costUsd)}</span>
                    </div>
                  ) : null}
                  {showRuns && item.payload.runs > 0 ? (
                    <div className="flex items-center justify-between gap-6">
                      <span className="text-muted-foreground">実行回数</span>
                      <span className="metric-number">{item.payload.runs}</span>
                    </div>
                  ) : null}
                </div>
              )}
            />
          }
        />
        <Bar
          dataKey="totalTokens"
          fill="var(--color-totalTokens)"
          radius={[4, 4, 1, 1]}
          maxBarSize={44}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}

function UsageMatrix({
  agents,
  cells,
}: {
  agents: AgentTelemetry[];
  cells: AgentHistoryMatrixCell[];
}) {
  const dayLabels = [...new Map(cells.map((cell) => [cell.date, cell.label])).entries()]
    .sort(([left], [right]) => right.localeCompare(left));
  const cellByKey = new Map(cells.map((cell) => [`${cell.agentId}:${cell.date}`, cell]));

  return (
    <div className="hidden min-w-0 sm:block">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-foreground">エージェント別</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">日ごとのトークン数</p>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-hidden="true">
          <span>少</span>
          {[0.14, 0.3, 0.5, 0.72, 0.96].map((opacity) => (
            <span
              key={opacity}
              className="size-3 rounded-[3px] border border-primary/10"
              style={{ backgroundColor: `rgb(130 170 162 / ${opacity})` }}
            />
          ))}
          <span>多</span>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-muted-foreground">新しい日付から表示・左右にスクロールできます</p>
      <div
        className="overflow-x-auto rounded-sm pb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        role="region"
        aria-label="エージェント別の日別トークン数"
        tabIndex={0}
      >
        <div
          className="grid min-w-[570px] items-center gap-1.5"
          style={{ gridTemplateColumns: `minmax(116px, 1.25fr) repeat(${dayLabels.length}, minmax(52px, 1fr))` }}
        >
          <div />
          {dayLabels.map(([date, label]) => (
            <div
              key={date}
              className="pb-1 text-center text-[11px] text-muted-foreground"
            >
              {label}
            </div>
          ))}
          {agents.map((agent) => (
            <div key={agent.id} className="contents">
              <div className="sticky start-0 z-10 truncate bg-card pe-2 text-xs font-medium text-muted-foreground">
                {agent.name}
              </div>
              {dayLabels.map(([date]) => {
                const cell = cellByKey.get(`${agent.id}:${date}`);
                if (!cell) return <div key={date} className="flex h-11 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground" aria-label={`${agent.name}、${date}：記録なし`}>—</div>;
                const opacity = 0.08 + cell.intensity * 0.86;
                return (
                  <Tooltip key={date}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("h-11 min-w-0 rounded-md border border-primary/10 p-0 text-[11px] tabular-nums hover:border-primary/45 hover:ring-2 hover:ring-primary/10", opacity >= 0.68 ? "text-black" : "text-white")}
                        style={{ backgroundColor: `rgb(130 170 162 / ${opacity})` }}
                        aria-label={`${agent.name}、${cell.date}：${formatInteger(cell.tokens)}トークン`}
                      >
                        {formatCompactNumber(cell.tokens)}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="border-border bg-popover text-[10px]">
                      <div className="font-medium">{agent.name} ・ {cell.label}</div>
                      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[9px] text-muted-foreground">
                        <span>トークン</span><span className="text-right text-foreground">{formatCompactNumber(cell.tokens)}</span>
                        <span>実行回数</span><span className="text-right text-foreground">{cell.runs}</span>
                        <span>料金</span><span className="text-right text-foreground">{formatCurrency(cell.costUsd)}</span>
                        <span>エラー率</span><span className="text-right text-foreground">{cell.errorRate.toFixed(1)}%</span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProviderUsageMatrix({
  providers,
  cells,
}: {
  providers: ProviderConnection[];
  cells: ProviderHistoryMatrixCell[];
}) {
  const dayLabels = [...new Map(cells.map((cell) => [cell.date, cell.label])).entries()]
    .sort(([left], [right]) => right.localeCompare(left));
  const cellByKey = new Map(
    cells.map((cell) => [`${cell.providerId}:${cell.date}`, cell]),
  );
  const rows = providers.filter((provider) =>
    cells.some((cell) => cell.providerId === provider.id),
  );

  return (
    <div className="hidden min-w-0 sm:block">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-foreground">サービス別</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">日ごとのトークン数</p>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground" aria-hidden="true">
          <span>少</span>
          {[0.14, 0.3, 0.5, 0.72, 0.96].map((opacity) => (
            <span
              key={opacity}
              className="size-3 rounded-[3px] border border-primary/10"
              style={{ backgroundColor: `rgb(130 170 162 / ${opacity})` }}
            />
          ))}
          <span>多</span>
        </div>
      </div>

      <p className="mb-2 text-[11px] text-muted-foreground">新しい日付から表示・左右にスクロールできます</p>
      <div
        className="overflow-x-auto rounded-sm pb-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        role="region"
        aria-label="サービス別の日別トークン数"
        tabIndex={0}
      >
        <div
          className="grid min-w-[500px] items-center gap-1.5"
          style={{
            gridTemplateColumns: `minmax(96px, 1.2fr) repeat(${dayLabels.length}, minmax(52px, 1fr))`,
          }}
        >
          <div />
          {dayLabels.map(([date, label]) => (
            <div
              key={date}
              className="pb-1 text-center text-[11px] text-muted-foreground"
            >
              {label}
            </div>
          ))}
          {rows.map((provider) => (
            <div key={provider.id} className="contents">
              <div className="sticky start-0 z-10 truncate bg-card pe-2 text-xs font-medium text-muted-foreground">
                {provider.name}
              </div>
              {dayLabels.map(([date]) => {
                const cell = cellByKey.get(`${provider.id}:${date}`);
                if (!cell) return <div key={date} className="flex h-11 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground" aria-label={`${provider.name}、${date}：記録なし`}>—</div>;
                const opacity = 0.08 + cell.intensity * 0.86;
                return (
                  <Tooltip key={date}>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("h-11 min-w-0 rounded-md border border-primary/10 p-0 text-[11px] tabular-nums hover:border-primary/45 hover:ring-2 hover:ring-primary/10", opacity >= 0.68 ? "text-black" : "text-white")}
                        style={{ backgroundColor: `rgb(130 170 162 / ${opacity})` }}
                        aria-label={`${provider.name}、${cell.date}：${formatInteger(cell.tokens)}トークン`}
                      >
                        {formatCompactNumber(cell.tokens)}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="border-border bg-popover text-[10px]">
                      <div className="font-medium">{provider.name} ・ {cell.label}</div>
                      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[9px] text-muted-foreground">
                        <span>トークン</span>
                        <span className="text-right text-foreground">
                          {formatCompactNumber(cell.tokens)}
                        </span>
                        {cell.costUsd > 0 ? (
                          <>
                            <span>料金</span>
                            <span className="text-right text-foreground">
                              {formatCurrency(cell.costUsd)}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HistorySection({
  dailyHistory,
  matrix,
  agents,
  providerMatrix,
  providers,
}: {
  dailyHistory: DailyHistoryPoint[];
  matrix: AgentHistoryMatrixCell[];
  agents: AgentTelemetry[];
  providerMatrix: ProviderHistoryMatrixCell[];
  providers: ProviderConnection[];
}) {
  const totalTokens = dailyHistory.reduce((sum, day) => sum + day.totalTokens, 0);
  const totalCost = dailyHistory.reduce((sum, day) => sum + day.costUsd, 0);
  const hasCostData = dailyHistory.some((day) => day.costUsd > 0);
  const hasRunData = dailyHistory.some((day) => day.runs > 0);
  const hasAgentMatrix = matrix.length > 0 && agents.length > 0;
  const hasProviderMatrix = providerMatrix.length > 0;
  const hasMatrix = hasAgentMatrix || hasProviderMatrix;
  const showDesktopMatrix = useDesktopMatrix();

  return (
    <Card id="history" className="scroll-mt-20 gap-0 py-0 shadow-none">
      <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading
          title="利用履歴"
          description={`${formatCompactNumber(totalTokens)}トークン${
            hasCostData ? ` ・ ${formatCurrency(totalCost)}` : ""
          }`}
        />
      </CardHeader>
      <CardContent
        className={cn(
          "grid gap-5 p-4 sm:p-5",
          hasMatrix && "lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]",
        )}
      >
        <div className="min-w-0">
          <div className="mb-3">
            <h3 className="text-xs font-medium text-foreground">日ごとの使用量</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">この端末に記録した{dailyHistory.length}日分・直近90記録日まで</p>
          </div>
          <DailyHistoryChart
            data={dailyHistory}
            showCost={hasCostData}
            showRuns={hasRunData}
          />
        </div>
        {showDesktopMatrix && hasAgentMatrix ? (
          <UsageMatrix agents={agents} cells={matrix} />
        ) : null}
        {showDesktopMatrix && !hasAgentMatrix && hasProviderMatrix ? (
          <ProviderUsageMatrix providers={providers} cells={providerMatrix} />
        ) : null}
        <details className="min-w-0 rounded-md border border-border px-3 lg:col-span-full">
          <summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-foreground">
            日別の数値を見る（{dailyHistory.length}日分）
          </summary>
          <div
            className="max-h-80 overflow-auto pb-3 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
            role="region"
            aria-label="日別の使用量（スクロールできます）"
            tabIndex={0}
          >
            <table className="w-full border-collapse text-xs tabular-nums">
              <caption className="sr-only">この端末に記録した日別の使用量。新しい日付から表示します。</caption>
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">日付</th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">トークン</th>
                  {hasRunData ? <th scope="col" className="px-2 py-2 text-end font-medium">実行回数</th> : null}
                  {hasCostData ? <th scope="col" className="ps-2 py-2 text-end font-medium">料金</th> : null}
                </tr>
              </thead>
              <tbody>
                {[...dailyHistory].sort((left, right) => right.date.localeCompare(left.date)).map((day) => (
                  <tr key={day.date} className="border-b border-border last:border-b-0">
                    <th scope="row" className="whitespace-nowrap py-2.5 pe-3 text-start font-normal text-muted-foreground">
                      <time dateTime={day.date}>{day.date.replaceAll("-", "/")}</time>
                    </th>
                    <td className="px-2 py-2.5 text-end">{formatInteger(day.totalTokens)}</td>
                    {hasRunData ? <td className="px-2 py-2.5 text-end">{formatInteger(day.runs)}回</td> : null}
                    {hasCostData ? <td className="ps-2 py-2.5 text-end">{formatCurrency(day.costUsd)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

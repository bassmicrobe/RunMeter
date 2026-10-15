import { Bot } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import type {
  AgentTelemetry,
  DashboardSnapshot,
} from "@/lib/runmeter-types";
import {
  formatCurrency,
  formatDuration,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import { SectionHeading } from "./section-heading";
import { ProviderPill, StatusPill } from "./status-pill";

export function AgentHealth({ agents }: { agents: AgentTelemetry[] }) {
  return (
    <Card id="agents" className="scroll-mt-20 gap-0 py-0 shadow-none">
      <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading title="エージェント" description="現在の稼働状況" />
      </CardHeader>
      <CardContent className="px-4 py-2 sm:px-5">
        {agents.map((agent, index) => (
          <div key={agent.id}>
            {index > 0 && <Separator />}
            <div className="flex items-center gap-3 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-secondary text-muted-foreground">
                <Bot className="size-4" strokeWidth={1.7} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {agent.name}
                  </span>
                  <StatusPill
                    status={agent.status === "tool" ? "running" : agent.status}
                  />
                  <ProviderPill provider={agent.provider} />
                </div>
                <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {agent.model} ・ 成功率 {agent.successRate.toFixed(1)}%
                </div>
              </div>
              <div className="text-right">
                <div className="metric-number text-[11px] text-foreground">
                  {formatCurrency(agent.costTodayUsd)}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">今日</div>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function BudgetCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <Card id="cost" className="scroll-mt-20 gap-0 py-0 shadow-none">
      <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading title="料金と月間予算" description="設定した予算の消化状況" />
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-5">
        <div>
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="metric-number text-2xl font-medium text-foreground">
                {formatCurrency(snapshot.summary.monthlySpend)}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                月間予算 {formatCurrency(snapshot.summary.monthlyBudget)} のうち
              </div>
            </div>
            <Badge
              variant="outline"
              className="border-amber-400/20 bg-amber-400/10 font-mono text-[10px] text-amber-300"
            >
              {snapshot.summary.budgetUsedPercent.toFixed(1)}%
            </Badge>
          </div>
          <Progress
            value={snapshot.summary.budgetUsedPercent}
            aria-label={`月間予算を${snapshot.summary.budgetUsedPercent.toFixed(1)}%使用`}
            className="mt-4 h-1.5 bg-secondary [&>div]:bg-amber-300"
          />
        </div>
        <Separator />
        <div className="space-y-4">
          {snapshot.costByModel.map((model, index) => (
            <div key={model.model}>
              <div className="mb-2 flex items-center justify-between gap-3 text-[10px]">
                <span className="font-mono text-muted-foreground">{model.model}</span>
                <span className="metric-number text-foreground">
                  {formatCurrency(model.costUsd)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full",
                    index === 0 ? "bg-primary" : "bg-primary/55",
                  )}
                  style={{ width: `${model.sharePercent}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-secondary/35 p-3">
          <div>
            <div className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
              応答時間（P95）
            </div>
            <div className="metric-number mt-1.5 text-xs text-foreground">
              {formatDuration(snapshot.summary.p95LatencyMs)}
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
              失敗した実行
            </div>
            <div className="metric-number mt-1.5 text-xs text-foreground">
              {snapshot.summary.failedRuns}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

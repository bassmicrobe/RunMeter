"use client";

import {
  Bot,
  Braces,
  CheckCircle2,
  CircleDot,
  Clock3,
  Coins,
  Cpu,
  Hourglass,
  Play,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { AgentTelemetry, RunTelemetry } from "@/lib/runmeter-types";
import {
  formatClock,
  formatCompactNumber,
  formatCurrency,
  formatDuration,
} from "@/lib/format";
import { useLocalTimeZone } from "@/hooks/use-local-time-zone";

import { ProviderPill, StatusPill } from "./status-pill";

type TimelineItem = {
  icon: LucideIcon;
  label: string;
  detail: string;
  time: string;
  tone: "complete" | "active" | "failed" | "pending";
};

const timelineTone = {
  complete: "text-emerald-300",
  active: "text-primary",
  failed: "text-rose-300",
  pending: "text-muted-foreground",
} as const;

export function RunDetailSheet({
  run,
  agent,
  open,
  onOpenChange,
}: {
  run: RunTelemetry | null;
  agent: AgentTelemetry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const timeZone = useLocalTimeZone();

  if (!run) return null;

  const terminal = run.status === "completed" || run.status === "failed";
  const timeline: TimelineItem[] = [
    {
      icon: CircleDot,
      label: "受付",
      detail: "実行待ちの一覧に追加されました",
      time: run.queuedAt,
      tone: "complete",
    },
  ];

  if (run.status === "queued") {
    timeline.push({
      icon: Hourglass,
      label: "空きを待っています",
      detail: run.currentStep ?? "エージェントはまだ開始していません",
      time: run.lastActivityAt,
      tone: "active",
    });
  } else {
    timeline.push({
      icon: Play,
      label: "開始",
      detail: `${agent?.name ?? run.agentId} が ${run.model} で開始しました`,
      time: run.startedAt ?? run.queuedAt,
      tone: "complete",
    });

    if (run.toolCalls > 0) {
      timeline.push({
      icon: Wrench,
      label: `ツール呼び出し ${run.toolCalls}回`,
      detail: `${run.toolCalls}回のツール呼び出しを記録しました`,
      time: run.lastActivityAt,
        tone: "complete",
      });
    }

    if (run.status === "completed") {
      timeline.push({
        icon: CheckCircle2,
        label: "完了",
        detail: `${formatCompactNumber(run.totalTokens)}トークンで確定しました`,
        time: run.completedAt ?? run.lastActivityAt,
        tone: "complete",
      });
    } else if (run.status === "failed") {
      timeline.push({
        icon: XCircle,
        label: "失敗",
        detail: `失敗までに${formatCompactNumber(run.totalTokens)}トークンを記録しました`,
        time: run.completedAt ?? run.lastActivityAt,
        tone: "failed",
      });
    } else {
      timeline.push({
        icon: Cpu,
        label: "生成中",
        detail: run.currentStep ?? "次の利用状況を待っています",
        time: run.lastActivityAt,
        tone: "active",
      });
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="border-border bg-background p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-[520px]">
        <SheetHeader className="border-b border-border px-5 py-5 text-start">
          <div className="mb-2 flex items-center gap-2">
            <StatusPill status={run.status} />
            <ProviderPill provider={run.provider} />
            <Badge
              variant="outline"
              className="h-5 rounded-md border-border bg-secondary px-2 text-[10px] font-normal text-muted-foreground"
            >
              {terminal ? "確定" : "概算"}
            </Badge>
          </div>
          <SheetTitle className="pe-8 text-base leading-6 tracking-[-0.02em]">
            {run.task}
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px] text-muted-foreground">
            {run.id} ・ {agent?.name ?? run.agentId}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="h-[calc(100svh-132px)]">
          <div className="space-y-6 p-5">
            <div className="grid grid-cols-3 gap-2">
              {[
                {
                  icon: Clock3,
                  label: "経過時間",
                  value: formatDuration(run.durationMs),
                },
                {
                  icon: Braces,
                  label: "トークン",
                  value: formatCompactNumber(run.totalTokens),
                },
                {
                  icon: Coins,
                  label: "料金",
                  value: formatCurrency(run.estimatedCostUsd),
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <item.icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <div className="mt-3 metric-number text-sm text-foreground">
                    {item.value}
                  </div>
                  <div className="mt-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                    {item.label}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                トークン内訳
              </div>
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                {[
                  ["入力", run.inputTokens],
                  ["キャッシュ済み入力", run.cachedTokens],
                  ["出力", run.outputTokens],
                  ["推論", run.reasoningTokens],
                ].map(([label, value], index) => (
                  <div key={String(label)}>
                    {index > 0 && <Separator />}
                    <div className="flex items-center justify-between px-3 py-2.5 text-[11px]">
                      <span className="text-muted-foreground">{label}</span>
                      <span className="metric-number text-foreground">
                        {formatCompactNumber(value as number)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-4 flex items-center justify-between">
                <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  処理の流れ
                </div>
                <span className="font-mono text-[9px] text-muted-foreground">
                  {timeline.length}項目
                </span>
              </div>
              <div className="relative space-y-0 ps-2">
                <span className="absolute bottom-4 start-[18px] top-4 w-px bg-border" />
                {timeline.map((item) => (
                  <div key={item.label} className="relative flex gap-3 pb-5 last:pb-0">
                    <span className="relative z-10 grid size-[21px] shrink-0 place-items-center rounded-full border border-border bg-background">
                      <item.icon
                        className={`size-3 ${timelineTone[item.tone]}`}
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] font-medium text-foreground">
                          {item.label}
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground">
                          {formatClock(item.time, timeZone)}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                        {item.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 text-[10px] font-medium text-foreground">
                <Bot className="size-3.5 text-primary" aria-hidden="true" />
                実行情報
              </div>
              <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-2 font-mono text-[9px]">
                <dt className="text-muted-foreground">エージェント</dt>
                <dd className="truncate text-foreground">{agent?.slug ?? run.agentId}</dd>
                <dt className="text-muted-foreground">モデル</dt>
                <dd className="truncate text-foreground">{run.model}</dd>
                <dt className="text-muted-foreground">最終更新</dt>
                <dd className="truncate text-foreground">{formatClock(run.lastActivityAt, timeZone)}</dd>
              </dl>
            </div>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

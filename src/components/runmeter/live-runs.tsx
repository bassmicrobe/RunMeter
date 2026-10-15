"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AgentTelemetry,
  RunTelemetry,
} from "@/lib/runmeter-types";
import {
  formatCompactNumber,
  formatCurrency,
  formatDuration,
} from "@/lib/format";

import { SectionHeading } from "./section-heading";
import { ProviderPill, StatusPill } from "./status-pill";

function formatRunDuration(run: RunTelemetry) {
  return run.status === "queued" ? "未開始" : formatDuration(run.durationMs);
}

function MobileRun({
  run,
  agent,
  onSelect,
}: {
  run: RunTelemetry;
  agent: AgentTelemetry | undefined;
  onSelect: () => void;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      className="h-auto w-full justify-start rounded-none border-b border-border px-4 py-3 text-start last:border-b-0 hover:bg-accent/35"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <StatusPill status={run.status} />
            <ProviderPill provider={run.provider} />
          </div>
          <span className="metric-number text-xs text-muted-foreground">
            {formatCurrency(run.estimatedCostUsd)}
          </span>
        </div>
        <div className="mt-2 truncate text-sm font-medium text-foreground">
          {run.task}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="truncate">{agent?.name ?? run.agentId}</span>
          <span className="shrink-0">
            {formatRunDuration(run)} ・ {formatCompactNumber(run.totalTokens)}トークン
          </span>
        </div>
      </div>
    </Button>
  );
}

export function LiveRuns({
  runs,
  agents,
  runningRuns,
  queuedRuns,
  onSelect,
}: {
  runs: RunTelemetry[];
  agents: AgentTelemetry[];
  runningRuns: number;
  queuedRuns: number;
  onSelect: (run: RunTelemetry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const mobileRuns = expanded ? runs : runs.slice(0, 6);
  const desktopRuns = expanded ? runs : runs.slice(0, 8);

  return (
    <Card id="live-runs" className="scroll-mt-20 gap-0 overflow-hidden py-0 shadow-none">
      <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading
          title="実行状況"
          description={`実行中 ${runningRuns}件 ・ 待機 ${queuedRuns}件`}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="h-11 gap-1 px-2 text-xs text-muted-foreground sm:h-9"
            >
              {expanded ? "閉じる" : "すべて表示"}{" "}
              <ArrowRight
                className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                aria-hidden="true"
              />
            </Button>
          }
        />
      </CardHeader>

      <div className="md:hidden">
        {mobileRuns.map((run) => (
          <MobileRun
            key={run.id}
            run={run}
            agent={agentById.get(run.agentId)}
            onSelect={() => onSelect(run)}
          />
        ))}
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[110px] ps-5 text-[11px]">
                状態
              </TableHead>
              <TableHead className="text-[11px]">処理内容</TableHead>
              <TableHead className="text-[11px]">モデル</TableHead>
              <TableHead className="text-right text-[11px]">経過時間</TableHead>
              <TableHead className="text-right text-[11px]">トークン</TableHead>
              <TableHead className="pe-5 text-right text-[11px]">料金</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {desktopRuns.map((run) => {
              const agent = agentById.get(run.agentId);
              return (
                <TableRow
                  key={run.id}
                  onClick={() => onSelect(run)}
                  className="cursor-pointer"
                >
                  <TableCell className="ps-5">
                    <StatusPill status={run.status} />
                  </TableCell>
                  <TableCell className="max-w-[330px]">
                    <Button
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(run);
                      }}
                      aria-label={`${run.task}の詳細を表示`}
                      className="h-auto w-full min-w-0 justify-start p-0 text-start hover:bg-transparent"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {run.task}
                        </span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">
                          {agent?.name ?? run.agentId} ・ {run.provider} ・ {run.id}
                        </span>
                      </span>
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">{run.model}</TableCell>
                  <TableCell className="metric-number text-right text-[10px]">{formatRunDuration(run)}</TableCell>
                  <TableCell className="metric-number text-right text-[10px]">{formatCompactNumber(run.totalTokens)}</TableCell>
                  <TableCell className="metric-number pe-5 text-right text-[10px]">{formatCurrency(run.estimatedCostUsd)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

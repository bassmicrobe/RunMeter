"use client";

import { useMemo } from "react";
import { Activity, Bot } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { DashboardSnapshot, RunTelemetry } from "@/lib/runmeter-types";

import { StatusPill } from "./status-pill";

export function DashboardSearchDialog({
  snapshot,
  open,
  onOpenChange,
  onSelectRun,
}: {
  snapshot: DashboardSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectRun: (run: RunTelemetry) => void;
}) {
  const agentById = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.id, agent])),
    [snapshot.agents],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="実行またはエージェントを検索"
      description="取得済みの利用データから検索します"
      showCloseButton
      className="border-border bg-popover"
    >
      <CommandInput
        className="pe-12"
        aria-label="実行またはエージェントを検索"
        placeholder="処理内容、エージェント、モデルで検索…"
      />
      <CommandList>
        <CommandEmpty>該当するデータはありません。</CommandEmpty>
        <CommandGroup heading="実行">
          {snapshot.runs.map((run) => (
            <CommandItem
              key={run.id}
              value={`${run.id} ${run.task} ${run.model} ${
                agentById.get(run.agentId)?.name ?? ""
              }`}
              onSelect={() => {
                onSelectRun(run);
                onOpenChange(false);
              }}
              className="py-2.5"
            >
              <Activity className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{run.task}</span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {run.id} ・ {run.model}
                </span>
              </span>
              <StatusPill status={run.status} />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="エージェント">
          {snapshot.agents.map((agent) => (
            <CommandItem
              key={agent.id}
              value={`${agent.name} ${agent.slug} ${agent.model}`}
              onSelect={() => {
                onOpenChange(false);
                document.querySelector("#agents")?.scrollIntoView();
              }}
            >
              <Bot className="size-4 text-muted-foreground" />
              <span className="text-xs">{agent.name}</span>
              <span className="ms-auto font-mono text-[10px] text-muted-foreground">
                {agent.model}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Play,
  TimerReset,
  Wrench,
  XCircle,
} from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  AgentTelemetry,
  DashboardEvent,
} from "@/lib/runmeter-types";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { SectionHeading } from "./section-heading";

const eventIcon = {
  "run.queued": TimerReset,
  "run.started": Play,
  "run.completed": CheckCircle2,
  "run.failed": XCircle,
  "model.completed": Cpu,
  "tool.started": Wrench,
  "tool.completed": Wrench,
  "budget.warning": AlertTriangle,
} as const;

const eventTone = {
  info: "border-primary/15 bg-primary/8 text-primary",
  warning: "border-amber-400/15 bg-amber-400/8 text-amber-300",
  error: "border-rose-400/15 bg-rose-400/8 text-rose-300",
} as const;

function EventRow({
  event,
  generatedAt,
  agent,
}: {
  event: DashboardEvent;
  generatedAt: string;
  agent: AgentTelemetry | undefined;
}) {
  const Icon = eventIcon[event.type];

  return (
    <div className="flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-accent/45">
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border",
          eventTone[event.severity],
        )}
      >
        <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-xs font-medium text-foreground">
            {event.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatRelativeTime(event.occurredAt, generatedAt)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
          {event.detail}
        </p>
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          {agent?.name ?? "RunMeter"}
        </div>
      </div>
    </div>
  );
}

export function LiveActivity({
  events,
  agents,
  generatedAt,
}: {
  events: DashboardEvent[];
  agents: AgentTelemetry[];
  generatedAt: string;
}) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  return (
    <Card id="alerts" className="scroll-mt-20 gap-0 py-0 shadow-none">
      <CardHeader className="border-b border-border px-4 py-4 sm:px-5">
        <SectionHeading
          title="最新の動き"
          description="新しい順に表示"
          action={
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-emerald-300" /> 自動更新
            </span>
          }
        />
      </CardHeader>
      <ScrollArea className="h-[293px]">
        <CardContent className="p-2">
          {events.slice(0, 7).map((event) => (
            <EventRow
              key={event.id}
              event={event}
              generatedAt={generatedAt}
              agent={agentById.get(event.agentId)}
            />
          ))}
        </CardContent>
      </ScrollArea>
    </Card>
  );
}

import { Badge } from "@/components/ui/badge";
import type { ProviderId } from "@/lib/runmeter-types";
import { cn } from "@/lib/utils";

const styles = {
  running:
    "border-primary/20 bg-primary/10 text-primary [&_[data-dot]]:bg-primary",
  succeeded:
    "border-emerald-400/20 bg-emerald-400/10 text-emerald-300 [&_[data-dot]]:bg-emerald-400",
  completed:
    "border-emerald-400/20 bg-emerald-400/10 text-emerald-300 [&_[data-dot]]:bg-emerald-400",
  failed:
    "border-rose-400/20 bg-rose-400/10 text-rose-300 [&_[data-dot]]:bg-rose-400",
  queued:
    "border-amber-400/20 bg-amber-400/10 text-amber-300 [&_[data-dot]]:bg-amber-400",
  idle: "border-border bg-secondary text-muted-foreground [&_[data-dot]]:bg-muted-foreground",
  paused:
    "border-violet-400/20 bg-violet-400/10 text-violet-300 [&_[data-dot]]:bg-violet-400",
  tool: "border-violet-400/20 bg-violet-400/10 text-violet-300 [&_[data-dot]]:bg-violet-400",
  degraded:
    "border-amber-400/20 bg-amber-400/10 text-amber-300 [&_[data-dot]]:bg-amber-400",
} as const;

type Status = keyof typeof styles;

const statusLabels: Record<Status, string> = {
  running: "実行中",
  succeeded: "成功",
  completed: "完了",
  failed: "失敗",
  queued: "待機中",
  idle: "待機",
  paused: "停止中",
  tool: "ツール実行中",
  degraded: "取得遅延",
};

export function StatusPill({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1.5 rounded-full px-2 text-[10px] font-medium",
        styles[status],
        className,
      )}
    >
      <span data-dot className="size-1.5 rounded-full" aria-hidden="true" />
      {statusLabels[status]}
    </Badge>
  );
}

const providerLabels: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
};

export function ProviderPill({ provider }: { provider: ProviderId }) {
  return (
    <Badge
      variant="outline"
      className="h-5 rounded-full border-border bg-secondary/70 px-2 font-mono text-[9px] font-normal text-muted-foreground"
    >
      {providerLabels[provider]}
    </Badge>
  );
}

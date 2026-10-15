import { Activity } from "lucide-react";

import { cn } from "@/lib/utils";

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
};

export function BrandMark({ compact = false, className }: BrandMarkProps) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary text-primary">
        <Activity className="size-[18px]" strokeWidth={2} aria-hidden="true" />
      </div>
      {!compact && (
        <div className="leading-none">
          <div className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
            RunMeter
          </div>
          <div className="mt-1 text-[10px] tracking-[0.04em] text-muted-foreground">
            AI利用状況
          </div>
        </div>
      )}
    </div>
  );
}

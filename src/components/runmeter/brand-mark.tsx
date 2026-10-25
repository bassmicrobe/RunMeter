import Image from "next/image";

import { cn } from "@/lib/utils";

type BrandMarkProps = {
  compact?: boolean;
  className?: string;
};

export function BrandMark({ compact = false, className }: BrandMarkProps) {
  return (
    <div className={cn("flex min-w-0 items-center", className)}>
      <Image
        src="/brand/runmeter-mark-dark.svg"
        width={36}
        height={36}
        alt="RunMeter"
        unoptimized
        className={cn("size-9 shrink-0", !compact && "hidden group-data-[collapsible=icon]:block")}
      />
      {!compact && (
        <div className="min-w-0 leading-none group-data-[collapsible=icon]:hidden">
          <Image
            src="/brand/runmeter-logo-dark.svg"
            width={174}
            height={40}
            alt="RunMeter"
            unoptimized
            className="h-10 w-[174px] max-w-full"
          />
          <div className="ps-[50px] text-[10px] tracking-[0.04em] text-muted-foreground">
            AI利用状況
          </div>
        </div>
      )}
    </div>
  );
}

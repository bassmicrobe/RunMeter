"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { PlugZap } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ProviderConnection } from "@/lib/runmeter-types";

const ProviderConnectionDialog = dynamic(
  () =>
    import("./provider-connection-control").then(
      (module) => module.ProviderConnectionDialog,
    ),
  { ssr: false },
);

export function ProviderConnectionControl({
  provider,
}: {
  provider: ProviderConnection;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isConnected =
    provider.status === "connected" || provider.status === "degraded";

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={isConnected ? "outline" : "default"}
        size="sm"
        className="h-11 shrink-0 px-3 text-xs shadow-none sm:h-9"
        aria-label={`${provider.name}の接続設定を開く`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {isConnected ? "管理" : "接続"}
        <PlugZap className="size-3.5" aria-hidden="true" />
      </Button>

      {open ? (
        <ProviderConnectionDialog
          provider={provider}
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen) window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}

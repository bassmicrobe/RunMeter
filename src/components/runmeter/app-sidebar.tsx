"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  Gauge,
  HardDrive,
  Info,
  LockKeyhole,
  Settings2,
  ShieldCheck,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";

import { BrandMark } from "./brand-mark";

const navigation = [
  { label: "利用率とリセット", href: "#usage", icon: Gauge },
  { label: "接続について", href: "#connection-status", icon: Info },
  { label: "設定", href: "#settings", icon: Settings2 },
  { label: "使い方マニュアル", href: "/guide", icon: BookOpen },
] as const;

export function AppSidebar({
  hasTelemetry,
  connection,
}: {
  hasTelemetry: boolean;
  connection: "live" | "reconnecting";
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [activeHref, setActiveHref] = useState("#usage");

  useEffect(() => {
    const syncHash = () => {
      const nextHref = navigation.some((item) => item.href === window.location.hash)
        ? window.location.hash
        : "#usage";
      setActiveHref(nextHref);
    };

    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  const deviceStatus = hasTelemetry
    ? connection === "live"
      ? "接続中"
      : "再接続中"
    : "未接続";

  return (
    <Sidebar
      collapsible="icon"
      className="border-sidebar-border"
      role="complementary"
      aria-label="RunMeterサイドバー"
    >
      <SidebarHeader className="h-[69px] justify-center px-4 group-data-[collapsible=icon]:px-1.5">
        <BrandMark />
      </SidebarHeader>
      <SidebarSeparator className="mx-3 w-auto bg-sidebar-border/80" />
      <SidebarContent className="px-2 py-3">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="px-2 font-mono text-[9px] uppercase tracking-[0.14em] text-sidebar-foreground/70">
            メニュー
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label="メインメニュー">
              <SidebarMenu className="gap-1">
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={activeHref === item.href}
                      tooltip={item.label}
                      className="h-11 rounded-lg text-xs data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground data-active:shadow-[inset_3px_0_0_var(--sidebar-primary)] md:h-9"
                    >
                      <a
                        href={item.href}
                        aria-current={activeHref === item.href ? "location" : undefined}
                        onClick={() => {
                          setActiveHref(item.href);
                          if (isMobile) setOpenMobile(false);
                        }}
                      >
                        <item.icon strokeWidth={1.8} aria-hidden="true" />
                        <span>{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3 p-3 group-data-[collapsible=icon]:p-1.5">
        <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/35 p-3 group-data-[collapsible=icon]:hidden">
          <div className="flex items-center gap-2 text-[11px] font-medium text-sidebar-foreground">
            <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
            ローカル優先
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[9px] text-sidebar-foreground/70">
            <span>{deviceStatus}</span>
            <span className="inline-flex items-center gap-1 text-sidebar-foreground/60">
              <span
                className={`size-1 rounded-full ${
                  hasTelemetry
                    ? connection === "live"
                      ? "bg-emerald-400"
                      : "bg-amber-300"
                    : "bg-muted-foreground"
                }`}
              />
              クラウド保存なし
            </span>
          </div>
        </div>
        <div
          className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sidebar-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          role="status"
          aria-label={`この端末：${deviceStatus}`}
        >
          <Avatar className="size-7 rounded-md">
            <AvatarFallback className="rounded-md bg-primary/10 text-[10px] font-semibold text-primary">
              <HardDrive className="size-3.5" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 text-start leading-tight group-data-[collapsible=icon]:hidden">
            <div className="truncate text-xs font-medium">この端末</div>
            <div className="truncate text-[10px] text-sidebar-foreground/70">
              AI利用データは端末内で処理
            </div>
          </div>
          <LockKeyhole className="size-3 text-sidebar-foreground/35 group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

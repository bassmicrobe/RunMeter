import type { ReactNode } from "react";
import { CircleAlert, Info } from "lucide-react";

import { cn } from "@/lib/utils";

export type GuideSectionMeta = {
  id: string;
  number: string;
  title: string;
};

export function GuideToc({ sections }: { sections: readonly GuideSectionMeta[] }) {
  return (
    <nav aria-label="目次" className="lg:sticky lg:top-8">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        目次
      </p>
      <ol className="mt-3 grid grid-cols-1 gap-0.5 border-s border-border sm:grid-cols-2 lg:grid-cols-1">
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="-ms-px flex min-h-11 items-center gap-3 border-s border-transparent ps-3 text-[13px] text-foreground/75 transition-colors hover:border-primary hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-9"
            >
              <span className="font-mono text-[11px] text-muted-foreground">{section.number}</span>
              {section.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function GuideSection({
  section,
  lead,
  children,
}: {
  section: GuideSectionMeta;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={section.id}
      aria-labelledby={`${section.id}-heading`}
      className="scroll-mt-6 border-t border-border pt-8 first:border-t-0 first:pt-0"
    >
      <p aria-hidden="true" className="font-mono text-[11px] tracking-[0.14em] text-primary">
        {section.number}
      </p>
      <h2 id={`${section.id}-heading`} className="mt-1 text-xl font-semibold tracking-[-0.01em]">
        {section.title}
      </h2>
      {lead ? <p className="mt-2 max-w-prose text-muted-foreground">{lead}</p> : null}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

export function GuideSteps({ children }: { children: ReactNode }) {
  return (
    <ol className="space-y-3 [counter-reset:step]">
      {children}
    </ol>
  );
}

export function GuideStep({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <li className="relative ps-11 [counter-increment:step] before:absolute before:start-0 before:top-0 before:flex before:size-7 before:items-center before:justify-center before:rounded-md before:border before:border-primary/40 before:bg-primary/10 before:font-mono before:text-xs before:text-primary before:content-[counter(step)]">
      <p className="font-medium text-foreground">{title}</p>
      {children ? <div className="mt-1 text-muted-foreground">{children}</div> : null}
    </li>
  );
}

export function PlatformPanel({
  platform,
  requirement,
  children,
}: {
  platform: "Windows" | "Mac";
  requirement: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">{platform}</h3>
        <p className="font-mono text-[11px] text-muted-foreground">{requirement}</p>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function GuideNote({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "caution";
  title: string;
  children: ReactNode;
}) {
  const Icon = tone === "caution" ? CircleAlert : Info;
  return (
    <aside
      className={cn(
        "flex gap-3 rounded-lg border p-4",
        tone === "caution"
          ? "border-amber-300/30 bg-amber-300/[0.06]"
          : "border-primary/25 bg-primary/[0.05]",
      )}
    >
      <Icon
        className={cn("mt-1 size-4 shrink-0", tone === "caution" ? "text-amber-300" : "text-primary")}
        aria-hidden="true"
      />
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <div className="mt-1 text-muted-foreground">{children}</div>
      </div>
    </aside>
  );
}

export function GuideQuestion({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-border bg-card open:bg-card/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium text-foreground focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {question}
        <span aria-hidden="true" className="font-mono text-muted-foreground transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="space-y-2 border-t border-border px-4 py-3 text-muted-foreground">{children}</div>
    </details>
  );
}

export function UiLabel({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded border border-border bg-muted px-1.5 py-0.5 text-[0.92em] text-foreground">
      {children}
    </span>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

export function Tooltip({
  content,
  children,
  className,
}: {
  content?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  if (!content) {
    return <>{children}</>;
  }

  return (
    <span className={cn("group relative inline-flex", className)}>
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-60 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 shadow-sm group-hover:block group-focus-within:block">
        {content}
      </span>
    </span>
  );
}

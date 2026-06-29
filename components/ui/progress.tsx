import * as React from "react";
import { cn } from "@/lib/utils";

export function Progress({
  className,
  value = 0,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value?: number;
}) {
  return (
    <div
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-zinc-100", className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-zinc-950 transition-all"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

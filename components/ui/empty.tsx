import * as React from "react";
import { cn } from "@/lib/utils";

export function Empty({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-40 items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-white text-sm text-zinc-500",
        className,
      )}
      {...props}
    />
  );
}

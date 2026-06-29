import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-4", className)} {...props} />;
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "inline-flex h-10 items-center rounded-lg bg-zinc-100 p-1 text-zinc-500",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  active,
  className,
  href,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  active?: boolean;
  href: string;
}) {
  return (
    <Link
      className={cn(
        "inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors",
        active ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-500 hover:text-zinc-900",
        className,
      )}
      href={href}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("outline-none", className)} {...props} />;
}

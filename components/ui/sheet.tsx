import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  children,
}: {
  open: boolean;
  children: React.ReactNode;
}) {
  if (!open) {
    return null;
  }

  return <div className="fixed inset-0 z-40">{children}</div>;
}

export function SheetOverlay({ href }: { href: string }) {
  return (
    <Link
      aria-label="关闭"
      className="absolute inset-0 bg-zinc-950/20"
      href={href}
      scroll={false}
    />
  );
}

export function SheetContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <aside
      className={cn(
        "absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-zinc-200 bg-white shadow-xl",
        className,
      )}
      {...props}
    />
  );
}

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-zinc-100 p-5", className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-lg font-semibold text-zinc-950", className)} {...props} />;
}

export function SheetBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("space-y-5 p-5", className)} {...props} />;
}

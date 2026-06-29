import type { ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type AdminShellProps = {
  active: "stats" | "window" | "logs";
  children: ReactNode;
  userName: string;
};

const adminTabs = [
  { href: "/admin/stats", label: "课程统计", value: "stats" },
  { href: "/admin/window", label: "开放期", value: "window" },
  { href: "/admin/logs", label: "操作日志", value: "logs" },
] as const;

export function AdminShell({ active, children, userName }: AdminShellProps) {
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <p className="text-sm text-zinc-500">当前登录：{userName}</p>
            <h1 className="mt-2 text-2xl font-semibold text-zinc-950">选课管理控制台</h1>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <TabsList>
              {adminTabs.map((tab) => (
                <TabsTrigger
                  active={active === tab.value}
                  href={tab.href}
                  key={tab.value}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <LogoutButton />
          </div>
        </header>
        <Tabs>{children}</Tabs>
      </div>
    </main>
  );
}

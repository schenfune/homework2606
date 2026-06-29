import { AdminShell } from "@/app/admin/_components/admin-shell";
import { LogTable } from "@/app/admin/_components/log-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/server";
import { getAdminDashboard } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

export default async function AdminLogsPage() {
  const { user } = await requireRole("ADMIN");
  const dashboard = await getAdminDashboard();

  return (
    <AdminShell active="logs" userName={user.name}>
      <Card>
        <CardHeader>
          <CardTitle>操作日志</CardTitle>
        </CardHeader>
        <CardContent>
          <LogTable logs={dashboard.logs} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}

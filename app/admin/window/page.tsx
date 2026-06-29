import { AdminShell } from "@/app/admin/_components/admin-shell";
import { updateTermWindowAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireRole } from "@/lib/auth/server";
import { datetimeLocalValue } from "@/lib/format";
import { getAdminDashboard } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

export default async function AdminWindowPage() {
  const { user } = await requireRole("ADMIN");
  const dashboard = await getAdminDashboard();

  return (
    <AdminShell active="window" userName={user.name}>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>选课开放期</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={updateTermWindowAction} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="selectionStartsAt">开始时间</Label>
              <Input
                defaultValue={datetimeLocalValue(dashboard.term.selectionStartsAt)}
                id="selectionStartsAt"
                name="selectionStartsAt"
                type="datetime-local"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="selectionEndsAt">结束时间</Label>
              <Input
                defaultValue={datetimeLocalValue(dashboard.term.selectionEndsAt)}
                id="selectionEndsAt"
                name="selectionEndsAt"
                type="datetime-local"
              />
            </div>
            <Button>保存开放期</Button>
          </form>
        </CardContent>
      </Card>
    </AdminShell>
  );
}

import Link from "next/link";
import { AdminShell } from "@/app/admin/_components/admin-shell";
import {
  clearFailedReservationsAction,
  processOpsWritebackAction,
} from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth/server";
import {
  getEnrollmentOpsDashboard,
  type EnrollmentOpsStatus,
} from "@/lib/services/enrollment-ops";

export const dynamic = "force-dynamic";

export default async function AdminOpsPage() {
  const { user } = await requireRole("ADMIN");
  const dashboard = await getEnrollmentOpsDashboard();

  return (
    <AdminShell active="ops" userName={user.name}>
      <div className="grid gap-4 lg:grid-cols-6">
        <MetricBox label="正常" value={`${dashboard.summary.NORMAL}`} />
        <MetricBox label="待写回" value={`${dashboard.summary.PENDING}`} />
        <MetricBox label="需处理" value={`${dashboard.summary.ACTION_REQUIRED}`} />
        <MetricBox label="异常" value={`${dashboard.summary.ERROR}`} />
        <MetricBox
          label="正式待写"
          value={`${dashboard.summary.pendingActive}`}
        />
        <MetricBox
          label="候补待写"
          value={`${dashboard.summary.pendingWaitlist}`}
        />
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
            <CardTitle>一致性运维</CardTitle>
            <div className="flex flex-wrap gap-2">
              <form action={processOpsWritebackAction}>
                <Button size="sm">处理写回</Button>
              </form>
              <form action={clearFailedReservationsAction}>
                <Button size="sm" variant="outline">
                  清理失败预占
                </Button>
              </form>
              <Link
                className="inline-flex h-8 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                href="/admin/ops"
              >
                刷新状态
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {dashboard.offerings.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead>课程</TableHead>
                  <TableHead>容量</TableHead>
                  <TableHead>DB有效</TableHead>
                  <TableHead>DB候补</TableHead>
                  <TableHead>已选计数</TableHead>
                  <TableHead>Redis正式</TableHead>
                  <TableHead>正式待写</TableHead>
                  <TableHead>候补待写</TableHead>
                  <TableHead>失败</TableHead>
                  <TableHead>校验</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.offerings.map((offering) => (
                  <TableRow key={offering.id}>
                    <TableCell>
                      <Badge variant={statusVariant(offering.status)}>
                        {statusLabel(offering.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-zinc-950">
                        {offering.courseNo} {offering.name}
                      </div>
                      <div className="text-xs text-zinc-500">{offering.classNo}班</div>
                    </TableCell>
                    <TableCell>{offering.capacity}</TableCell>
                    <TableCell>{offering.dbActive}</TableCell>
                    <TableCell>{offering.dbWaitlisted}</TableCell>
                    <TableCell>{offering.enrolledCount}</TableCell>
                    <TableCell>{offering.redisActiveReserved}</TableCell>
                    <TableCell>{offering.pendingActive}</TableCell>
                    <TableCell>{offering.pendingWaitlist}</TableCell>
                    <TableCell>{offering.failed + offering.orphan}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        <CheckBadge ok={offering.checks.enrolledCounterMatchesActive}>
                          计数
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.activeNotGreaterThanCapacity}>
                          容量
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.redisActiveNotGreaterThanCapacity}>
                          闸门
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.noPendingWriteback}>
                          写回
                        </CheckBadge>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>暂无开课班</Empty>
          )}
        </CardContent>
      </Card>
    </AdminShell>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function CheckBadge({
  children,
  ok,
}: {
  children: string;
  ok: boolean;
}) {
  return <Badge variant={ok ? "success" : "danger"}>{children}</Badge>;
}

function statusLabel(status: EnrollmentOpsStatus) {
  if (status === "NORMAL") return "正常";
  if (status === "PENDING") return "待写回";
  if (status === "ACTION_REQUIRED") return "需处理";
  return "异常";
}

function statusVariant(status: EnrollmentOpsStatus) {
  if (status === "NORMAL") return "success";
  if (status === "PENDING") return "warning";
  if (status === "ACTION_REQUIRED") return "warning";
  return "danger";
}

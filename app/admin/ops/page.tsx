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
        <MetricBox label="待入库" value={`${dashboard.summary.PENDING}`} />
        <MetricBox label="需清理" value={`${dashboard.summary.ACTION_REQUIRED}`} />
        <MetricBox label="异常" value={`${dashboard.summary.ERROR}`} />
        <MetricBox
          label="已选待入库"
          value={`${dashboard.summary.pendingActive}`}
        />
        <MetricBox
          label="候补待入库"
          value={`${dashboard.summary.pendingWaitlist}`}
        />
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-center">
            <CardTitle>选课数据校验</CardTitle>
            <div className="flex flex-wrap gap-2">
              <form action={processOpsWritebackAction}>
                <Button size="sm">同步名单</Button>
              </form>
              <form action={clearFailedReservationsAction}>
                <Button size="sm" variant="outline">
                  清理失败记录
                </Button>
              </form>
              <Link
                className="inline-flex h-8 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                href="/admin/ops"
              >
                刷新
              </Link>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {dashboard.offerings.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>检查结果</TableHead>
                  <TableHead>课程</TableHead>
                  <TableHead>名额</TableHead>
                  <TableHead>最终已选</TableHead>
                  <TableHead>最终候补</TableHead>
                  <TableHead>课程已选数</TableHead>
                  <TableHead>抢课入口已选</TableHead>
                  <TableHead>已选待入库</TableHead>
                  <TableHead>候补待入库</TableHead>
                  <TableHead>失败记录</TableHead>
                  <TableHead>检查项</TableHead>
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
                          已选数
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.activeNotGreaterThanCapacity}>
                          不超额
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.redisActiveNotGreaterThanCapacity}>
                          抢课入口
                        </CheckBadge>
                        <CheckBadge ok={offering.checks.noPendingWriteback}>
                          已入库
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
  if (status === "PENDING") return "待入库";
  if (status === "ACTION_REQUIRED") return "需清理";
  return "异常";
}

function statusVariant(status: EnrollmentOpsStatus) {
  if (status === "NORMAL") return "success";
  if (status === "PENDING") return "warning";
  if (status === "ACTION_REQUIRED") return "warning";
  return "danger";
}

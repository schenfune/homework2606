import Link from "next/link";
import { AdminShell } from "@/app/admin/_components/admin-shell";
import { LogTable } from "@/app/admin/_components/log-table";
import {
  cancelOfferingAction,
  closeOfferingAction,
} from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MeetingTimeList } from "@/components/student/course-display";
import { requireRole } from "@/lib/auth/server";
import {
  categoryLabel,
  dateTimeLabel,
  offeringStatusLabel,
  registrationStatusLabel,
} from "@/lib/format";
import { getAdminDashboard } from "@/lib/services/admin";

export const dynamic = "force-dynamic";

type AdminStatsPageProps = {
  searchParams?: Promise<{
    detail?: string;
  }>;
};

export default async function AdminStatsPage({ searchParams }: AdminStatsPageProps) {
  const params = await searchParams;
  const { user } = await requireRole("ADMIN");
  const dashboard = await getAdminDashboard();
  const selectedOffering = dashboard.offeringDetails.find(
    (offering) => offering.id === params?.detail,
  );

  return (
    <AdminShell active="stats" userName={user.name}>
      <Card>
        <CardHeader>
          <CardTitle>课程名单统计</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>课程</TableHead>
                <TableHead>类别</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>名额</TableHead>
                <TableHead>已选</TableHead>
                <TableHead>候补</TableHead>
                <TableHead>退课</TableHead>
                <TableHead>停开移除</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dashboard.stats.map((stat) => (
                <TableRow key={stat.id}>
                  <TableCell>
                    <div className="font-medium text-zinc-950">
                      {stat.courseNo} {stat.name}
                    </div>
                    <div className="text-xs text-zinc-500">{stat.classNo}班</div>
                  </TableCell>
                  <TableCell>{categoryLabel(stat.category)}</TableCell>
                  <TableCell>
                    <Badge>{offeringStatusLabel(stat.status)}</Badge>
                  </TableCell>
                  <TableCell>{stat.capacity}</TableCell>
                  <TableCell>{stat.active}</TableCell>
                  <TableCell>{stat.waitlisted}</TableCell>
                  <TableCell>{stat.dropped}</TableCell>
                  <TableCell>{stat.removed}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        className="inline-flex h-8 items-center rounded-md border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                        href={`/admin/stats?detail=${stat.id}`}
                        scroll={false}
                      >
                        详情
                      </Link>
                      <form action={closeOfferingAction}>
                        <input name="offeringId" type="hidden" value={stat.id} />
                        <Button
                          disabled={stat.status !== "PUBLISHED"}
                          size="sm"
                          variant="outline"
                        >
                          冻结名单
                        </Button>
                      </form>
                      <form action={cancelOfferingAction}>
                        <input name="offeringId" type="hidden" value={stat.id} />
                        <input name="reason" type="hidden" value="管理员停开课程" />
                        <Button
                          disabled={stat.status === "CANCELED"}
                          size="sm"
                          variant="danger"
                        >
                          停开课程
                        </Button>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex gap-3">
            <a
              className="inline-flex h-10 items-center rounded-md bg-zinc-950 px-4 text-sm font-medium text-white hover:bg-zinc-800"
              href="/api/admin/export"
            >
              导出CSV
            </a>
          </div>
        </CardContent>
      </Card>
      <AdminOfferingSheet offering={selectedOffering} />
    </AdminShell>
  );
}

function AdminOfferingSheet({
  offering,
}: {
  offering?: Awaited<ReturnType<typeof getAdminDashboard>>["offeringDetails"][number];
}) {
  return (
    <Sheet open={Boolean(offering)}>
      <SheetOverlay href="/admin/stats" />
      {offering ? (
        <SheetContent className="max-w-3xl">
          <SheetHeader>
            <div className="flex flex-wrap gap-2">
              <Badge>{categoryLabel(offering.category)}</Badge>
              <Badge variant={offering.status === "PUBLISHED" ? "success" : "warning"}>
                {offeringStatusLabel(offering.status)}
              </Badge>
            </div>
            <SheetTitle>
              {offering.courseNo} {offering.name}
            </SheetTitle>
          </SheetHeader>
          <SheetBody>
            <div className="grid gap-3 sm:grid-cols-5">
              <MetricBox
                label="已选/名额"
                value={`${offering.enrolledCount}/${offering.capacity}`}
              />
              <MetricBox label="已选" value={`${offering.active}`} />
              <MetricBox label="候补" value={`${offering.waitlisted}`} />
              <MetricBox label="退课" value={`${offering.dropped}`} />
              <MetricBox label="停开移除" value={`${offering.removed}`} />
            </div>
            <Progress value={offering.rate} />
            <DetailGrid
              items={[
                ["班号", `${offering.classNo}班`],
                ["教师", offering.teacherName],
                ["选课率", `${offering.rate}%`],
              ]}
            />
            <div>
              <div className="mb-2 text-sm font-medium text-zinc-950">时间</div>
              {offering.meetingTimes.length ? (
                <MeetingTimeList meetingTimes={offering.meetingTimes} />
              ) : (
                <Empty>未排课</Empty>
              )}
            </div>
            <RegistrationTable registrations={offering.registrations} />
            <div>
              <div className="mb-2 text-sm font-medium text-zinc-950">日志</div>
              <LogTable logs={offering.logs} />
            </div>
          </SheetBody>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

function RegistrationTable({
  registrations,
}: {
  registrations: NonNullable<
    Awaited<ReturnType<typeof getAdminDashboard>>["offeringDetails"][number]
  >["registrations"];
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-zinc-950">学生名单</div>
      {registrations.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>学号</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>专业</TableHead>
              <TableHead>年级</TableHead>
              <TableHead>名单状态</TableHead>
              <TableHead>候补排队</TableHead>
              <TableHead>加入时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {registrations.map((registration) => (
              <TableRow key={registration.id}>
                <TableCell>{registration.student.studentNo}</TableCell>
                <TableCell>{registration.student.name}</TableCell>
                <TableCell>{registration.student.major.name}</TableCell>
                <TableCell>{registration.student.grade}</TableCell>
                <TableCell>
                  <Badge variant={registrationStatusVariant(registration.status)}>
                    {registrationStatusLabel(registration.status)}
                  </Badge>
                </TableCell>
                <TableCell>{registration.waitlistPosition ?? "-"}</TableCell>
                <TableCell>{dateTimeLabel(registration.registeredAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Empty>暂无名单</Empty>
      )}
    </div>
  );
}

function registrationStatusVariant(
  status: Awaited<
    ReturnType<typeof getAdminDashboard>
  >["offeringDetails"][number]["registrations"][number]["status"],
): "secondary" | "success" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "WAITLISTED") return "warning";
  return "secondary";
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-zinc-950">{value}</div>
    </div>
  );
}

function DetailGrid({ items }: { items: [string, string][] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {items.map(([label, value]) => (
        <div className="rounded-lg border border-zinc-200 p-3" key={label}>
          <div className="text-xs text-zinc-500">{label}</div>
          {value ? <div className="mt-1 text-sm font-medium text-zinc-950">{value}</div> : null}
        </div>
      ))}
    </div>
  );
}

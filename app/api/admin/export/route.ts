import { OperationType, Role } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/api";
import { prisma } from "@/lib/db/prisma";
import { categoryLabel, dateTimeLabel, registrationStatusLabel } from "@/lib/format";
import { getEnrollmentResultSnapshot } from "@/lib/services/admin";

// 管理员导出当前学期选课结果CSV。
export async function GET() {
  // 导出接口使用API鉴权，失败时直接返回403 JSON。
  const { session, response } = await requireAdminApi();

  if (response) {
    return response;
  }

  // 结果快照与外部结果API复用同一服务，避免两套导出口径。
  const rows = await getEnrollmentResultSnapshot();
  const csv = [
    ["课程号", "课程名", "班号", "课程类别", "学号", "姓名", "专业", "年级", "名单状态", "加入时间"],
    ...rows.map((row) => [
      row.offering.course.courseNo,
      row.offering.course.name,
      row.offering.classNo,
      categoryLabel(row.offering.course.category),
      row.student.studentNo,
      row.student.name,
      row.student.major.name,
      `${row.student.grade}`,
      registrationStatusLabel(row.status),
      dateTimeLabel(row.registeredAt),
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

  // 导出动作写入操作日志，便于管理员追踪结果流转。
  await prisma.operationLog.create({
    data: {
      type: OperationType.RESULT_EXPORTED,
      actorRole: Role.ADMIN,
      actorId: session?.user.id,
      message: "管理员导出当前学期选课结果",
    },
  });

  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="enrollment-results.csv"',
    },
  });
}

// 转义CSV单元格中的双引号，并统一包裹为字符串单元格。
function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

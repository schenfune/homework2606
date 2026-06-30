import { OperationType, Role } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/api";
import { prisma } from "@/lib/db/prisma";
import { categoryLabel, registrationStatusLabel } from "@/lib/format";
import { getEnrollmentResultSnapshot } from "@/lib/services/admin";

export async function GET() {
  const { session, response } = await requireAdminApi();

  if (response) {
    return response;
  }

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
      row.registeredAt.toISOString(),
    ]),
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\n");

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

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

import { OperationType, Role } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { registrationStatusLabel } from "@/lib/format";
import { getEnrollmentResultSnapshot } from "@/lib/services/admin";
import { assertRateLimit } from "@/lib/services/rate-limit";

export async function GET(request: NextRequest) {
  const apiKey = request.headers.get("x-api-key");
  const expectedApiKey =
    process.env.ENROLLMENT_RESULT_API_KEY ?? "course-result-demo-key";

  if (!apiKey || apiKey !== expectedApiKey) {
    return NextResponse.json({ ok: false, message: "API Key无效" }, { status: 401 });
  }

  try {
    await assertRateLimit({
      key: `rate-limit:result-api:${apiKey}`,
      limit: 60,
      windowSeconds: 60,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "请求过于频繁" },
      { status: 429 },
    );
  }

  const rows = await getEnrollmentResultSnapshot();

  await prisma.operationLog.create({
    data: {
      type: OperationType.RESULT_API_ACCESSED,
      actorRole: Role.ADMIN,
      message: "外部教务系统读取选课结果快照",
    },
  });

  return NextResponse.json({
    ok: true,
    data: rows.map((row) => ({
      courseNo: row.offering.course.courseNo,
      courseName: row.offering.course.name,
      classNo: row.offering.classNo,
      studentNo: row.student.studentNo,
      studentName: row.student.name,
      major: row.student.major.name,
      grade: row.student.grade,
      status: row.status,
      statusText: registrationStatusLabel(row.status),
      registeredAt: row.registeredAt,
    })),
  });
}

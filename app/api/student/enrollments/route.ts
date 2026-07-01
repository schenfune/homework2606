import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth/server";
import { dropCourse, EnrollmentError, selectCourse } from "@/lib/services/enrollment";
import { assertRateLimit } from "@/lib/services/rate-limit";

// 学生正式选课HTTP入口，供k6压测和前端API调用使用。
export async function POST(request: NextRequest) {
  // 从服务端会话识别学生身份，前端不能伪造profileId。
  const session = await getCurrentSession();
  const user = session?.user as
    | {
        id: string;
        role?: string;
        profileId?: string | null;
      }
    | undefined;

  if (!user || user.role !== "STUDENT" || !user.profileId) {
    return NextResponse.json({ ok: false, message: "无权访问" }, { status: 403 });
  }

  try {
    // 限制单个学生在短时间内重复提交选课请求。
    await assertRateLimit({
      key: `rate-limit:select:${user.profileId}`,
      limit: 20,
      windowSeconds: 60,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "请求过于频繁" },
      { status: 429 },
    );
  }

  // 选课接口只接受开课班ID。
  const body = (await request.json()) as { offeringId?: string };

  if (!body.offeringId) {
    return NextResponse.json({ ok: false, message: "缺少开课班ID" }, { status: 400 });
  }

  try {
    // 业务规则、Redis预占和缓存失效都在服务层完成。
    const registration = await selectCourse(user.profileId, body.offeringId);
    return NextResponse.json({
      ok: true,
      message: "选课成功",
      status: registration.status,
      waitlistPosition: registration.waitlistPosition,
    });
  } catch (error) {
    // EnrollmentError携带稳定code，方便压测脚本区分容量满等业务结果。
    return NextResponse.json(
      {
        ok: false,
        code: error instanceof EnrollmentError ? error.code : "ENROLLMENT_FAILED",
        message: error instanceof Error ? error.message : "选课失败",
      },
      { status: 400 },
    );
  }
}

// 学生退课HTTP入口，支持正式登记和Redis临时预占。
export async function DELETE(request: NextRequest) {
  // 退课同样从服务端会话确认本人身份。
  const session = await getCurrentSession();
  const user = session?.user as
    | {
        id: string;
        role?: string;
        profileId?: string | null;
      }
    | undefined;

  if (!user || user.role !== "STUDENT" || !user.profileId) {
    return NextResponse.json({ ok: false, message: "无权访问" }, { status: 403 });
  }

  const body = (await request.json()) as { registrationId?: string };

  if (!body.registrationId) {
    return NextResponse.json({ ok: false, message: "缺少登记记录ID" }, { status: 400 });
  }

  try {
    // 服务层会判断必修、冻结、候补退出和正式退课递补。
    await dropCourse(user.profileId, body.registrationId);
    return NextResponse.json({ ok: true, message: "退课成功" });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "退课失败" },
      { status: 400 },
    );
  }
}

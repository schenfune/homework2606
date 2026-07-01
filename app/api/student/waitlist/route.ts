import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth/server";
import { EnrollmentError, joinWaitlist } from "@/lib/services/enrollment";
import { assertRateLimit } from "@/lib/services/rate-limit";

// 学生加入候补HTTP入口，满员后由学生显式触发。
export async function POST(request: NextRequest) {
  // 通过会话获取学生档案，避免前端提交学生ID。
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
    // 候补入口也需要限流，避免单账号异常高频提交。
    await assertRateLimit({
      key: `rate-limit:waitlist:${user.profileId}`,
      limit: 20,
      windowSeconds: 60,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "请求过于频繁" },
      { status: 429 },
    );
  }

  // 候补只需要开课班ID，其他规则由服务层读取数据库判断。
  const body = (await request.json()) as { offeringId?: string };

  if (!body.offeringId) {
    return NextResponse.json({ ok: false, message: "缺少开课班ID" }, { status: 400 });
  }

  try {
    // 服务层会检查是否仍有名额、是否冲突、是否重复候补。
    const registration = await joinWaitlist(user.profileId, body.offeringId);
    return NextResponse.json({
      ok: true,
      message: "候补成功",
      status: registration.status,
      waitlistPosition: registration.waitlistPosition,
    });
  } catch (error) {
    // 返回稳定错误码，方便前端和压测脚本区分业务拒绝。
    return NextResponse.json(
      {
        ok: false,
        code: error instanceof EnrollmentError ? error.code : "WAITLIST_FAILED",
        message: error instanceof Error ? error.message : "候补失败",
      },
      { status: 400 },
    );
  }
}

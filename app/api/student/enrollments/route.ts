import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth/server";
import { dropCourse, selectCourse } from "@/lib/services/enrollment";
import { assertRateLimit } from "@/lib/services/rate-limit";

export async function POST(request: NextRequest) {
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

  const body = (await request.json()) as { offeringId?: string };

  if (!body.offeringId) {
    return NextResponse.json({ ok: false, message: "缺少开课班ID" }, { status: 400 });
  }

  try {
    const registration = await selectCourse(user.profileId, body.offeringId);
    return NextResponse.json({
      ok: true,
      message: registration.status === "WAITLISTED" ? "候补成功" : "选课成功",
      status: registration.status,
      waitlistPosition: registration.waitlistPosition,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "选课失败" },
      { status: 400 },
    );
  }
}

export async function DELETE(request: NextRequest) {
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
    await dropCourse(user.profileId, body.registrationId);
    return NextResponse.json({ ok: true, message: "退课成功" });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "退课失败" },
      { status: 400 },
    );
  }
}

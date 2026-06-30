import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth/server";
import { EnrollmentError, joinWaitlist } from "@/lib/services/enrollment";
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

  const body = (await request.json()) as { offeringId?: string };

  if (!body.offeringId) {
    return NextResponse.json({ ok: false, message: "缺少开课班ID" }, { status: 400 });
  }

  try {
    const registration = await joinWaitlist(user.profileId, body.offeringId);
    return NextResponse.json({
      ok: true,
      message: "候补成功",
      status: registration.status,
      waitlistPosition: registration.waitlistPosition,
    });
  } catch (error) {
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

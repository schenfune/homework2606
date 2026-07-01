import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";

// API入口专用的管理员鉴权，失败时返回JSON响应。
export async function requireAdminApi() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const role = (session?.user as { role?: string } | undefined)?.role;

  if (!session?.user || role !== "ADMIN") {
    // API不能使用页面redirect，因此直接返回403。
    return {
      session: null,
      response: NextResponse.json({ ok: false, message: "无权访问" }, { status: 403 }),
    };
  }

  return {
    session,
    response: null,
  };
}

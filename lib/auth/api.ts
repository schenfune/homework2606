import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth/auth";

export async function requireAdminApi() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const role = (session?.user as { role?: string } | undefined)?.role;

  if (!session?.user || role !== "ADMIN") {
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

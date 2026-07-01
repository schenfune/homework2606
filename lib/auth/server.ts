import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";

export type AppRole = "STUDENT" | "ADMIN";

// 从Better Auth读取当前服务端会话。
export async function getCurrentSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

// 要求当前用户具备指定角色，否则按角色跳转到对应入口。
export async function requireRole(role: AppRole) {
  const session = await getCurrentSession();

  if (!session?.user) {
    // 未登录用户统一回到登录页。
    redirect("/login");
  }

  const user = session.user as typeof session.user & {
    role?: AppRole;
    profileId?: string | null;
  };

  if (user.role !== role) {
    // 已登录但角色不匹配时，送回自己可访问的工作区。
    redirect(user.role === "ADMIN" ? "/admin" : "/student");
  }

  return {
    session,
    user,
  };
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";

export type AppRole = "STUDENT" | "ADMIN";

export async function getCurrentSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

export async function requireRole(role: AppRole) {
  const session = await getCurrentSession();

  if (!session?.user) {
    redirect("/login");
  }

  const user = session.user as typeof session.user & {
    role?: AppRole;
    profileId?: string | null;
  };

  if (user.role !== role) {
    redirect(user.role === "ADMIN" ? "/admin" : "/student");
  }

  return {
    session,
    user,
  };
}

import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getCurrentSession();
  const role = (session?.user as { role?: string } | undefined)?.role;

  if (role === "ADMIN") {
    redirect("/admin");
  }

  if (role === "STUDENT") {
    redirect("/student");
  }

  redirect("/login");
}

import { LoginForm } from "@/app/login/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <LoginForm />
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";

export function LoginForm() {
  const router = useRouter();
  const [campusId, setCampusId] = useState("20240001");
  const [password, setPassword] = useState("12345678");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");

    const result = await authClient.signIn.email({
      email: `${campusId.trim()}@campus.local`,
      password,
    });

    setPending(false);

    if (result.error) {
      setError("账号或密码错误");
      return;
    }

    router.push(campusId.startsWith("admin") ? "/admin" : "/student");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>校园统一身份认证</CardTitle>
        <CardDescription>使用学号或工号登录选课子系统</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="campusId">学号或工号</Label>
            <Input
              id="campusId"
              value={campusId}
              onChange={(event) => setCampusId(event.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <Button className="w-full" disabled={pending}>
            {pending ? "登录中" : "登录"}
          </Button>
        </form>
        <div className="mt-4 rounded-md bg-zinc-50 p-3 text-xs leading-6 text-zinc-500">
          <div>学生演示账号：20240001 / 12345678</div>
          <div>管理员演示账号：admin001 / 12345678</div>
        </div>
      </CardContent>
    </Card>
  );
}

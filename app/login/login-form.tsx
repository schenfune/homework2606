"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        <div className="mt-4 grid grid-cols-2 gap-2">
          <AccountButton
            label="学生"
            onClick={() => {
              setCampusId("20240001");
              setPassword("12345678");
            }}
          />
          <AccountButton
            label="管理员"
            onClick={() => {
              setCampusId("admin001");
              setPassword("12345678");
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function AccountButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

# 实现上下文摘要

## 当前业务边界

系统定位为校园教务体系中的选课子系统。外部教务主系统通过Seed数据提供学生档案、课程、开课班和必修课表。本系统只处理学生选退课、课表查看、选课开放期、课程关闭取消、统计、日志、CSV导出和结果API。

## 已确认领域规则

课程类别包括必修课、专业选修课、公选课。必修课通过课程类别识别，不增加来源字段。课程登记记录统一承载必修课登记和学生选课记录。必修课不可退，专业选修课校验学院、专业、年级，公选课默认全校可选。时间冲突检测覆盖必修课和已选课程。

## 当前技术方向

Next.js 16使用App Router。认证使用Better Auth模拟统一身份认证。PostgreSQL保存权威业务数据。Redis负责缓存和限流。Prisma schema承载领域模型。UI尽量采用shadcn风格组件，优先使用Card和Table组织学生端与后台页面。

## 实现注意

不要在本系统中扩展完整教务后台，不做教师端，不做课程库维护，不做账号生命周期管理。Better Auth只负责登录、退出、会话保护。学号和工号通过username插件表达，实际账号仍映射到本地认证表。

## 待手动安装依赖

代码将使用Prisma、Better Auth、Redis客户端、shadcn风格工具函数、Vitest等依赖。按照项目约定，Codex不直接安装依赖。需要用户手动执行安装命令后，才能运行类型检查、Prisma生成和构建。

建议命令：

```bash
pnpm add @prisma/client @prisma/adapter-pg better-auth clsx redis tailwind-merge
pnpm add -D prisma tsx vitest
```

当前实际安装的是Prisma 7。Prisma 7不再允许在`schema.prisma`中写`datasource.url`，项目已改为在`prisma.config.ts`中配置CLI连接串，并在运行时通过`@prisma/adapter-pg`创建PrismaClient。

Better Auth在本地开发中使用显式默认`baseURL`和开发密钥，避免构建阶段使用库内置默认值。正式部署时必须配置`BETTER_AUTH_URL`和足够长的`BETTER_AUTH_SECRET`。

由于用户要求不直接编辑依赖安装结果，当前没有在`package.json`中添加脚本。依赖安装后，可通过`pnpm exec prisma validate`、`pnpm exec prisma generate`、`pnpm exec tsx prisma/seed.ts`、`pnpm exec vitest run`等命令运行。

## 当前测试设计

单元测试先覆盖课表时间冲突判断。学生选课HTTP接口位于`/api/student/enrollments`，供API测试和k6压测使用。k6脚本位于`tests/load/enrollment.js`，需要手动传入`BASE_URL`、`OFFERING_ID`和登录后的`SESSION_COOKIE`。

## 已实现代码概览

已添加Prisma领域模型、Better Auth认证配置、scrypt密码哈希、Seed演示数据、学生选课服务、管理员管理服务、Redis缓存限流、学生端页面、管理员端页面、CSV导出、结果API、课表冲突单元测试和k6压测脚本。当前`package.json`未记录新增依赖，需用户手动安装依赖后再运行校验。

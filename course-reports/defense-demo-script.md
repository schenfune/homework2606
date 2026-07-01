# 答辩全过程操作手册

本文档按“答辩前准备、现场启动、页面演示、工程证据展示、异常回退”组织。目标是让现场操作有固定顺序，避免临时想命令、找页面或重复重置数据。

## 1. 答辩前一天准备

答辩前一天先把代码、数据库、测试报告和压测报告全部准备好。现场尽量展示已经生成的稳定结果，只在必要时运行少量命令。

### 1.1 检查本地环境

在项目目录打开PowerShell：

```powershell
cd C:\Users\schenfune\Documents\Coding\course
```

确认Node、pnpm、Docker、k6和Allure可用：

```powershell
node -v
pnpm -v
docker --version
k6 version
allure --version
```

确认PostgreSQL和Redis容器正在运行。项目默认使用：

表1 本地基础服务

| 服务 | 地址 | 用途 |
| --- | --- | --- |
| PostgreSQL | 127.0.0.1:5432 | 保存学生、课程、登记、日志和认证数据 |
| Redis | 127.0.0.1:6379 | 预占座位、候补预占、限流和写回队列 |

可以用Docker Desktop查看两个容器是否启动，也可以使用：

```powershell
docker ps
```

如果容器已经存在但未启动，用Docker Desktop启动对应容器即可。现场不要临时新建数据库容器，避免端口、密码和数据库名不一致。

### 1.2 恢复数据库结构和演示数据

优先使用下面这一组命令恢复到可演示状态：

```powershell
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm exec tsx prisma/seed.ts
```

如果数据库数据已经被多次演示改乱，可以重新运行Seed。Seed会重建测试账号、演示课程、低容量课程和时间冲突课程。

只有在数据库结构严重不一致时，才使用破坏性重置命令：

```powershell
pnpm exec prisma migrate reset
pnpm exec tsx prisma/seed.ts
```

这会清空并重建数据库，答辩现场不建议临时执行。

### 1.3 生成自动化测试报告

普通测试命令：

```powershell
pnpm exec vitest run
```

生成Allure结果：

```powershell
pnpm exec vitest run --config vitest.allure.config.ts
```

生成Allure HTML报告：

```powershell
allure generate artifacts/allure-results -o artifacts/allure-report --clean
```

生成覆盖率报告：

```powershell
pnpm exec vitest run --coverage
```

答辩时建议打开这些结果：

表2 测试报告位置

| 材料 | 路径 | 展示重点 |
| --- | --- | --- |
| Allure报告 | artifacts/allure-report | 测试套件、用例通过情况、失败分类 |
| 覆盖率报告 | artifacts/coverage | 服务层和工具函数覆盖情况 |
| Vitest终端输出 | PowerShell或CI日志 | 所有测试通过 |

### 1.4 生成压测材料

如果机器资源足够，推荐准备1000名学生抢100个名额的压测数据。先确保后文第2.2节的Docker Compose多实例入口已经能正常访问，再运行：

```powershell
$env:LOAD_STUDENT_COUNT="1000"
$env:LOAD_COURSE_CAPACITY="100"
pnpm exec tsx scripts/seed-load-test.ts
k6 run --env MODE=flash --env BASE_URL=http://localhost:8080 --env VUS=1000 --env P95_THRESHOLD_MS=2000 tests/load/enrollment.js
pnpm exec tsx scripts/summarize-load-result.ts
```

若本机资源吃紧，可以改为500抢50：

```powershell
$env:LOAD_STUDENT_COUNT="500"
$env:LOAD_COURSE_CAPACITY="50"
pnpm exec tsx scripts/seed-load-test.ts
k6 run --env MODE=flash --env BASE_URL=http://localhost:8080 --env VUS=500 --env P95_THRESHOLD_MS=2000 tests/load/enrollment.js
pnpm exec tsx scripts/summarize-load-result.ts
```

候补压测在主压测之后运行：

```powershell
pnpm exec tsx scripts/prepare-waitlist-load-test.ts
k6 run --env MODE=waitlist --env BASE_URL=http://localhost:8080 --env TARGET_FILE=../../artifacts/load-test-waitlist-target.json tests/load/enrollment.js
pnpm exec tsx scripts/summarize-load-result.ts
```

压测后重点展示：

表3 压测证据

| 材料 | 路径 | 展示重点 |
| --- | --- | --- |
| k6 HTML报告 | artifacts/k6-enrollment-report.html | 并发学生、课程容量、P95、服务错误、容量满响应 |
| k6 JSON摘要 | artifacts/k6-enrollment-summary.json | 机器可读指标 |
| 一致性摘要 | artifacts/load-test-verification.md | ACTIVE不超过容量，enrolledCount与正式名单一致 |

### 1.5 准备GitHub Actions截图

提前打开仓库的Actions页面，准备展示最近一次成功流水线。当前CI包含：

表4 CI流水线步骤

| 步骤 | 作用 |
| --- | --- |
| Install dependencies | 安装依赖 |
| Validate Prisma schema | 校验Prisma模型 |
| Generate Prisma client | 生成Prisma Client |
| Apply database migrations | 在CI数据库执行迁移 |
| Run tests | 运行Vitest测试 |
| Lint | 静态检查 |
| Build Next.js | 构建应用 |
| Inspect k6 script | 检查压测脚本 |
| Build Docker image | 构建Docker镜像 |

## 2. 答辩当天启动流程

答辩当天按顺序执行，不要跳步。建议开三个PowerShell窗口：一个看服务，一个备用跑命令，一个展示文件或报告。

### 2.1 方案A：本地开发模式

本地开发模式适合演示页面功能，地址是http://localhost:3000。

第一个终端启动Next.js：

```powershell
pnpm dev
```

第二个终端启动Worker：

```powershell
pnpm exec tsx scripts/enrollment-worker.ts
```

浏览器打开：

```text
http://localhost:3000
```

本地开发模式的优点是启动快、日志清楚。缺点是不能展示Nginx多实例入口。

### 2.2 方案B：Docker Compose多实例模式

多实例模式适合展示Nginx、三个Next.js实例、独立Worker和水平扩展，地址是http://localhost:8080。

先构建镜像：

```powershell
docker compose -f docker-compose.lb.yml build
```

启动服务：

```powershell
docker compose -f docker-compose.lb.yml up -d
```

查看容器状态：

```powershell
docker compose -f docker-compose.lb.yml ps
```

预期看到这些服务：

表5 Docker Compose服务

| 服务 | 作用 |
| --- | --- |
| app1 | Next.js应用实例1 |
| app2 | Next.js应用实例2 |
| app3 | Next.js应用实例3 |
| enrollment-worker | 独立写回Worker |
| nginx | 统一入口，暴露localhost:8080 |

打开健康检查：

```text
http://localhost:8080/api/health
```

健康检查应返回实例标识、数据库状态和Redis状态。可以刷新几次，观察请求是否进入不同实例。

如果要看日志：

```powershell
docker compose -f docker-compose.lb.yml logs --tail=80 app1
docker compose -f docker-compose.lb.yml logs --tail=80 nginx
```

如果修改过代码或Dockerfile，先重新build，再up。

### 2.3 现场最终检查

演示开始前按表6检查一次。

表6 现场检查清单

| 检查项 | 通过标准 |
| --- | --- |
| PostgreSQL | 容器运行，端口5432可用 |
| Redis | 容器运行，端口6379可用 |
| 学生登录 | 20240001能进入学生页 |
| 管理员登录 | admin001能进入管理控制台 |
| 健康检查 | /api/health显示数据库和Redis正常 |
| Worker | 本地Worker终端运行，或Compose中enrollment-worker运行 |
| Allure报告 | artifacts/allure-report可打开 |
| k6报告 | artifacts/k6-enrollment-report.html可打开 |
| CI页面 | GitHub Actions成功记录可展示 |

## 3. 现场页面演示流程

现场页面演示建议控制在6到7分钟。优先使用http://localhost:8080，如果多实例环境临时异常，切回http://localhost:3000。

### 3.1 学生端演示

使用学生A登录：

表7 学生端演示动作

| 顺序 | 操作 | 讲解重点 |
| --- | --- | --- |
| 1 | 登录20240001 | 系统按学生角色进入学生工作区 |
| 2 | 查看顶部信息栏 | 学生、专业、年级、已登记学分、开放期 |
| 3 | 打开SE301软件体系结构详情 | 规则诊断展示选课时间、状态、类别、适合对象、名额、上课时间 |
| 4 | 打开SE302Web应用开发详情 | 展示时间冲突，冲突原因由服务层结构化返回 |
| 5 | 操作SE304软件测试实践 | 容量1课程用于演示满员和候补 |
| 6 | 进入课表Tab | 节次矩阵展示正式课程和候补课程 |
| 7 | 查看周五第9到10节 | GE204可展示课表矩阵自动扩展 |

候补演示有两种做法：

表8 候补演示方式

| 方式 | 做法 | 适用情况 |
| --- | --- | --- |
| 手动演示 | 学生B先选容量1课程，学生A再点击候补 | 页面演示更直观 |
| 压测后演示 | 使用LT101压测课程查看正式和候补状态 | 展示高并发结果 |

讲解时只说三点：正式选课只抢正式名额，满员后显示候补入口，候补需要学生显式确认。

### 3.2 退课递补演示

退课递补建议使用容量1课程。流程如下：

表9 退课递补流程

| 顺序 | 操作 | 结果 |
| --- | --- | --- |
| 1 | 学生B选中SE304 | SE304容量被占满 |
| 2 | 学生A加入SE304候补 | 学生A显示候补中 |
| 3 | 学生B退课 | 学生B登记变为退课 |
| 4 | 刷新学生A页面 | 学生A从候补转为正式入选 |
| 5 | 管理员查看课程详情 | 日志显示退课和候补转入 |

讲解重点：退课和递补在同一事务语义下处理，正式、候补、退课都是CourseRegistration的状态变化。

### 3.3 管理员端演示

使用管理员账号admin001登录。

表10 管理员端演示动作

| 顺序 | 页面 | 操作 | 讲解重点 |
| --- | --- | --- | --- |
| 1 | 课程统计 | 查看课程容量、已选、候补、退课、移除 | 管理员按开课班追踪名单 |
| 2 | 课程详情Sheet | 打开SE304或LT101详情 | 查看名单、候补顺位、登记时间、操作日志 |
| 3 | 选课时间 | 查看或调整开放期 | 开放期影响学生端规则检查 |
| 4 | 数据校验 | 查看Redis预占、待写回、数据库登记 | 异步架构可观测 |
| 5 | 操作日志 | 查看学生和管理员操作记录 | 审计追踪 |
| 6 | 导出CSV | 导出选课结果 | 外部教务系统回收最终名单 |

冻结和停开可以讲解，不建议现场随便点击。若要演示，先说明区别：

表11 冻结与停开区别

| 操作 | 含义 | 数据变化 |
| --- | --- | --- |
| 冻结名单 | 锁定当前名单 | 课程保留，学生不能再选课或退课 |
| 停开课程 | 取消这个开课班 | 有效登记和候补登记统一转为移除 |

## 4. 工程证据展示流程

工程证据建议控制在4到5分钟。顺序是Docker Compose、压测、Allure、覆盖率、GitHub Actions。

### 4.1 Docker Compose和健康检查

展示`docker compose -f docker-compose.lb.yml ps`输出，说明当前运行了三个Web实例、一个Worker和一个Nginx。

打开：

```text
http://localhost:8080/api/health
```

讲解重点：

表12 多实例演示点

| 点 | 说明 |
| --- | --- |
| Nginx | 统一入口，把请求分发到app1、app2、app3 |
| Next.js实例 | Web层无状态，可以水平扩展 |
| Redis | 保存预占、限流和写回队列 |
| PostgreSQL | 保存最终登记和操作日志 |
| Worker | 独立消费写回任务 |

### 4.2 k6压力测试和一致性摘要

打开：

```text
artifacts/k6-enrollment-report.html
artifacts/load-test-verification.md
```

讲解顺序：

表13 压测讲解顺序

| 顺序 | 指标 | 说明 |
| --- | --- | --- |
| 1 | 并发学生数 | 例如1000名学生同时抢课 |
| 2 | 课程容量 | 例如100个正式名额 |
| 3 | 正式入选响应 | 应接近课程容量 |
| 4 | 容量满响应 | 容量外学生收到业务结果 |
| 5 | 服务错误 | 应为0 |
| 6 | 数据库校验 | ACTIVE不超过容量，enrolledCount一致 |

说明候补压测时强调：满员不会自动候补，学生需要显式点击候补，候补压测使用未抢到正式名额的学生名单。

### 4.3 Allure测试报告

打开：

```text
artifacts/allure-report
```

展示内容：

表14 Allure展示点

| 页面 | 讲解重点 |
| --- | --- |
| Overview | 自动化测试整体通过情况 |
| Suites | 测试按模块组织 |
| Categories | 业务规则、并发一致性、环境配置分类 |
| 单个用例 | 选课、候补、递补、写回、运维等核心行为 |

### 4.4 覆盖率报告

打开：

```text
artifacts/coverage/index.html
```

讲解重点：覆盖率用于辅助说明测试范围，核心价值在于关键业务风险有测试，例如时间冲突、密码哈希、候补、退课递补、Worker写回、管理员统计和一致性运维。

### 4.5 GitHub Actions

打开仓库Actions页面，展示最近一次成功流水线。

讲解重点：CI在GitHub环境中启动PostgreSQL和Redis服务容器，执行Prisma校验、数据库迁移、Vitest、Lint、Next.js构建、k6脚本检查和Docker镜像构建。它证明项目不是只在本机手动跑通。

## 5. 现场备用方案

### 5.1 页面打不开

先判断入口：

表15 页面打不开排查

| 现象 | 处理 |
| --- | --- |
| localhost:8080打不开 | 检查Docker Compose状态，必要时切回localhost:3000 |
| localhost:3000打不开 | 检查pnpm dev终端是否运行 |
| 登录失败 | 重新运行Seed，确认账号密码 |
| Server Actions报错 | 使用8080时检查Nginx是否保留Host和X-Forwarded-Host |

### 5.2 Nginx出现502

按顺序执行：

```powershell
docker compose -f docker-compose.lb.yml ps
docker compose -f docker-compose.lb.yml logs --tail=80 app1
docker compose -f docker-compose.lb.yml logs --tail=80 nginx
```

常见原因：

表16 502常见原因

| 原因 | 处理 |
| --- | --- |
| app容器没有启动 | 重新build并up |
| 镜像还是旧版本 | 重新执行docker compose build |
| 数据库不可达 | 启动PostgreSQL容器 |
| Redis不可达 | 启动Redis容器 |
| 上游尚未就绪 | 等几秒刷新健康检查 |

### 5.3 候补或课程数据乱了

普通演示数据乱了：

```powershell
pnpm exec tsx prisma/seed.ts
```

压测数据乱了：

```powershell
pnpm exec tsx scripts/seed-load-test.ts
```

重新生成压测目标后，k6脚本会读取最新的`artifacts/load-test-target.json`。

### 5.4 Allure打不开

重新生成：

```powershell
pnpm exec vitest run --config vitest.allure.config.ts
allure generate artifacts/allure-results -o artifacts/allure-report --clean
```

若现场仍打不开，直接展示Vitest终端输出和GitHub Actions日志。

### 5.5 压测现场跑不动

不要现场硬跑1000并发。可以展示提前生成的：

表17 压测备用材料

| 材料 | 路径 |
| --- | --- |
| k6 HTML报告 | artifacts/k6-enrollment-report.html |
| 一致性摘要 | artifacts/load-test-verification.md |
| k6 JSON摘要 | artifacts/k6-enrollment-summary.json |
| GitHub Actions截图 | 仓库Actions页面 |

如果必须现场演示压测，可以降为200抢30或100抢20。

## 6. 最终演示顺序速查

表18给出现场最短操作顺序。

表18 现场速查清单

| 顺序 | 要做的事 |
| --- | --- |
| 1 | 启动PostgreSQL和Redis |
| 2 | 进入项目目录 |
| 3 | 运行`pnpm exec prisma generate` |
| 4 | 运行`pnpm exec prisma migrate deploy` |
| 5 | 运行`pnpm exec tsx prisma/seed.ts` |
| 6 | 选择启动方式：`pnpm dev`加Worker，或Docker Compose多实例 |
| 7 | 打开学生页，演示规则诊断、选课、候补、课表 |
| 8 | 打开管理员页，演示统计、详情、日志、数据校验 |
| 9 | 展示`/api/health`和Docker Compose服务 |
| 10 | 展示k6报告和一致性摘要 |
| 11 | 展示Allure、覆盖率和GitHub Actions |
| 12 | 用状态机、领域模型和测试证据收束 |


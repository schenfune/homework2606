# 关键时序图

本文件整理答辩时可展示的关键时序。每个场景都从用户操作出发，经过边界对象、控制对象和实体对象，最终落到登记状态、容量计数和操作日志。

## 3.4.1 正常选课时序

正常选课场景展示系统如何从学生点击按钮推进到有效登记。该场景覆盖规则诊断、事务提交、容量更新和日志记录。

```mermaid
sequenceDiagram
    actor Student as 学生
    participant Page as 学生选课页
    participant Action as 选课动作
    participant Service as 选课事务服务
    participant Rule as 规则诊断构造器
    participant DB as PostgreSQL
    participant Log as 操作日志

    Student->>Page: 点击选课
    Page->>Action: 提交开课班编号
    Action->>Service: 调用selectCourse
    Service->>DB: 读取学生学期和开课班
    Service->>Rule: 构造规则诊断
    Rule-->>Service: 返回全部通过
    Service->>DB: 加锁并增加已选人数
    Service->>DB: 写入ACTIVE登记
    Service->>Log: 记录COURSE_SELECTED
    Service-->>Action: 返回登记结果
    Action-->>Page: 刷新学生页面
```

图3.1 正常选课时序图

## 3.4.2 满员候补时序

满员候补场景展示系统如何把容量不足转化为候补登记。该场景体现扩展事件流，也能说明候补队列从登记记录自然形成。

```mermaid
sequenceDiagram
    actor Student as 学生
    participant Page as 学生选课页
    participant Service as 选课事务服务
    participant Rule as 规则诊断构造器
    participant DB as PostgreSQL
    participant Log as 操作日志

    Student->>Page: 点击候补
    Page->>Service: 提交开课班编号
    Service->>DB: 获取学生锁和开课班锁
    Service->>DB: 读取已有登记和候补队列
    Service->>Rule: 校验开放期状态资格和冲突
    Rule-->>Service: 返回容量提示
    Service->>DB: 计算下一候补顺位
    Service->>DB: 写入WAITLISTED登记
    Service->>Log: 记录COURSE_WAITLISTED
    Service-->>Page: 返回候补顺位
    Page-->>Student: 显示候补中
```

图3.2 满员候补时序图

## 3.4.3 退课自动递补时序

退课递补场景展示系统如何在一个事务中完成退课、释放容量、队首递补和日志记录。该场景是答辩时说明一致性控制的重点。

```mermaid
sequenceDiagram
    actor Student as 学生
    participant Page as 课表页
    participant Service as 退课递补服务
    participant DB as PostgreSQL
    participant Log as 操作日志

    Student->>Page: 点击退课
    Page->>Service: 提交登记编号
    Service->>DB: 获取学生锁和开课班锁
    Service->>DB: 读取登记课程和学期
    Service->>DB: 登记改为DROPPED
    Service->>DB: 已选人数减一
    Service->>DB: 查询队首WAITLISTED登记
    Service->>DB: 队首登记改为ACTIVE
    Service->>DB: 已选人数加一
    Service->>Log: 记录COURSE_DROPPED
    Service->>Log: 记录WAITLIST_PROMOTED
    Service-->>Page: 刷新课表和候补名单
```

图3.3 退课自动递补时序图

## 3.4.4 管理员停开课程时序

管理员停开课程场景展示后台如何批量处理名单。停开操作会移除有效登记和候补登记，日志保存停开原因和影响人数。

```mermaid
sequenceDiagram
    actor Admin as 管理员
    participant Page as 管理控制台
    participant Service as 管理员课程服务
    participant DB as PostgreSQL
    participant Cache as Redis缓存
    participant Log as 操作日志

    Admin->>Page: 点击停开课程
    Page->>Service: 提交开课班编号和原因
    Service->>DB: 读取开课班和名单
    Service->>DB: 开课班状态改为CANCELED
    Service->>DB: ACTIVE和WAITLISTED改为REMOVED
    Service->>Log: 记录OFFERING_CANCELED
    Service->>Cache: 清理学生和管理端缓存
    Service-->>Page: 刷新课程统计
```

图3.4 管理员停开课程时序图

## 3.4.5 时序分析结论

四个时序图共同说明系统的职责分配。页面只提交用户意图，服务层集中处理规则和事务，数据库保存领域状态，日志保存审计事实。学生锁解决同一学生重复提交，开课班锁保护候补顺位和递补顺序，Read Committed事务在显式锁保护下确保容量计数和登记状态同步更新。

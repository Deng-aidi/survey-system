# AI 使用日志

> 本文件记录每个模块开发过程中的真实 AI 使用情况，作为课程评分依据。

---

## Auth 模块（注册、登录、JWT 鉴权）

### 1. 使用工具

- 对话式 AI Agent（Claude）
- 人工执行 PowerShell 测试
- 人工执行 git 命令

### 2. 提示词摘要

> 基于已冻结的 API 契约 v1.2.1，只生成 auth 模块：注册、登录、JWT 中间件、GET /api/auth/me。要求 Node.js + Express + Mongoose + bcrypt + jsonwebtoken。不要生成 survey / question / submission / stats 任何相关代码。

### 3. AI 产出

首次一次性生成以下 7 个文件：

| 文件 | 内容 |
|------|------|
| `package.json` | 依赖：express, mongoose, bcryptjs, jsonwebtoken, dotenv, cors |
| `.env.example` | PORT / MONGODB_URI / JWT_SECRET / JWT_EXPIRES_IN |
| `server.js` | Express 入口、健康检查、路由注册、404 兜底、全局错误处理 |
| `config/db.js` | Mongoose 连接封装 |
| `models/User.js` | Schema + bcrypt pre('save') hook + comparePassword 实例方法 |
| `middleware/auth.js` | JWT 验证中间件（Bearer token 提取 + 验签 + 挂载 req.user） |
| `routes/auth.js` | register / login / me 三个路由 |

附带：运行说明 + 5 条 PowerShell 手工测试步骤。

### 4. 我在 Review 中发现并要求 AI 修改的点

以下问题均在首次生成后、启动前发现，由我指出后 AI 做定点 Edit 修复：

| # | 问题 | 位置 | 修正 |
|---|------|------|------|
| 1 | `username` 字段同时有 `unique: true` 和 `index: true`，Mongoose 会建重复唯一索引并打印警告 | `models/User.js` | 删除 `index: true`，`unique: true` 本身会触发 Mongoose 建唯一索引 |
| 2 | `pre('save')` 用了 `async function hashPassword(next)` 又手动调 `next()` 和 `try/catch next(err)`，写法冗余 | `models/User.js` | 改为纯 `async function`，不加 `next` 参数，Mongoose 自动捕获异常 |
| 3 | E11000 重复键判断写了 `err.code === 11000 && err.keyPattern && err.keyPattern.username`，过度依赖 `keyPattern.username` 字段，某些驱动版本可能不返回 | `routes/auth.js` | 去掉 `err.keyPattern && err.keyPattern.username` 检查，只保留 `err.code === 11000` |
| 4 | `server.js` 的 `start()` 调用没有 `.catch`，如果 `connectDB` 失败会导致未处理的 Promise rejection | `server.js` | 改为 `start().catch(err => { console.error('[startup-failed]', err); process.exit(1); })` |

**修正后我本地重新验证**：服务器正常启动，无重复索引警告，4 个问题均消除。

> **小结**：AI 一次生成整体可用，主要问题集中在 Mongoose 用法细节（索引重复、hook 写法）和错误处理健壮性（E11000 判断、启动 catch），均属"能跑但不够规范"，由我在 review 阶段发现并要求修正，不涉及架构返工。

### 5. 测试结果

所有测试在本地 PowerShell 终端执行，服务器由 `npm run dev` 启动。

| # | 测试用例 | 方法 + URL | 预期 | 实际 | 通过 |
|---|---------|-----------|------|------|:----:|
| T1 | 注册新用户 bob | POST /api/auth/register | 201 | 201，响应含 `_id`, `username: "bob"`, `created_at`，**无 password 字段** | ✅ |
| T2 | 重复注册 bob | POST /api/auth/register | 409 | 409 | ✅ |
| T3 | 正确密码登录 | POST /api/auth/login | 200 + token | 200，token 以 `eyJ` 开头（JWT） | ✅ |
| T4 | 带有效 token 调 /me | GET /api/auth/me (Bearer token) | 200 | 200，返回 bob 用户信息，**无 password 字段** | ✅ |
| T5 | 带伪造 token 调 /me | GET /api/auth/me (Bearer eyJbad...) | 401 | 401 | ✅ |
| T6 | 错误密码登录 | POST /api/auth/login | 401 | 401 | ✅ |
| T7 | 无 token 调 /me | GET /api/auth/me | 401 | 401 | ✅ |
| T8 | 缺 password 注册 | POST /api/auth/register | 400 | 400 | ✅ |
| T9 | 密码 5 位注册（不足 6 位） | POST /api/auth/register | 400 | 400 | ✅ |
| T10 | 密码 6 位注册 | POST /api/auth/register | 201 | 201 | ✅ |
| T11 | mongosh 查 users 集合 | `db.users.findOne({username:"bob"})` | password 已哈希 | `password: "$2a$10$bGZtXUYL..."`，bcrypt 哈希格式 | ✅ |

**中途踩的坑（不是代码 bug）**：

> 测试 4 第一次执行失败：我把 PowerShell 命令中的 `"Bearer 这里粘贴你的token"` 里的 `这里粘贴你的token` 当字面量传了，而不是先把 token 存进变量 `$TOKEN` 再引用。改用 `$TOKEN` 变量传递后通过。**根因是测试命令写法问题，不是后端代码问题。**

### 6. 我自己确认或补充的决策（AI 已实现，由我 review 时确认并固化为约束）

| # | 决策 | 内容 | 理由 |
|---|------|------|------|
| D1 | JWT payload 字段 | `{ _id: user._id.toString(), username: user.username }` —— AI 已实现，我 review 时确认其正确性，**要求后续 Survey CRUD 模块继续遵守**同样的 `_id.toString()` 约束 | 避免下游 Mongoose 查询中 ObjectId 与字符串比较时出现隐性不一致 |
| D2 | .gitignore 配置 | 排除 `node_modules/`、`.env`、`*.log`；把 `大作业一.docx` 移出项目目录 | 项目目录保持干净，敏感文件不入版本控制 |
| D3 | git 初始化误入 node_modules | 执行 `git add .` 时 node_modules 被纳入暂存区；用 `git reset` 取消暂存 + 新建 `.gitignore` 修正，再 `git gc` 清理无效对象 | 事后补救，首次 init 前应先写 .gitignore |

---

> 下一个模块（Survey CRUD）的日志接续追加到此文件。

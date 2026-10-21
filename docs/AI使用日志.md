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

## Survey CRUD 模块（创建、列表、详情、更新元信息、改状态、删除）

### 1. 使用工具

- 对话式 AI Agent
- 人工执行 PowerShell 测试
- 人工执行 git 命令

### 2. 提示词摘要

> 基于已冻结的 API 契约 v1.2.1，只生成 Survey CRUD 6 个端点：POST 创建、GET 列表（aggregate 管道）、GET 详情、PATCH 元信息、PATCH status、DELETE（应用层级联删 submissions）。要求 Survey model 按 schema 方案 A 完整 embedded questions[]；所有写操作用 save()；creator_id 比较用 .equals()；url_token 用 crypto.randomBytes(8).toString('hex')。不要生成 question / submission / stats 代码。

### 3. AI 产出

新建 4 个文件 + 修改 1 个文件：

| 文件 | 内容 |
|------|------|
| `models/Survey.js` | 完整 embedded questions[] schema（选项/跳转规则/题目子文档）、url_token 生成静态方法、deleteOne document 级联 hook |
| `models/Submission.js` | 空壳 schema（strict:false），仅用于级联删除 |
| `middleware/ownership.js` | 创建者身份校验，用 creator_id.equals(req.user._id)，挂载 req.survey |
| `routes/surveys.js` | 6 个端点 + aggregate 列表管道 |
| `server.js` | 引入 surveys 路由 + Submission model 预加载 |

### 4. 我在 Review 中发现并要求 AI 修改的点

| # | 问题 | 位置 | 修正 |
|---|------|------|------|
| 1 | `url_token` 同时有 `unique: true` 和 `index: true`（与 User.js 同样的重复索引问题）；`creator_id`、`status` 的单字段 `index: true` 与复合索引 `{creator_id:1, status:1}` 前缀冗余 | `models/Survey.js` | 删 3 处 `index: true`，只保留 schema 末尾的复合索引 |
| 2 | PATCH 路由混传 `{title, creator_id}` 时原实现只取 title、静默忽略 creator_id 返回 200 | `routes/surveys.js` | 检测到任何白名单外字段就返回 400 并列出非法字段名 |
| 3 | `jumpRuleSchema` 写了 `ref: 'Survey.questions'`，embedded document 的 ref 无实际作用且不是合法 model 名 | `models/Survey.js` | 删除 `ref`，只保留 `type: ObjectId` + `default: null` |
| 4 | `generateUrlToken` 的 fallback 分支返回的 token 后缀是时间戳不是随机，语义不同 | `models/Survey.js` | 加注释说明"fallback 仅作兜底，概率极低" |
| 5 | `Survey.findById(surveyId)` 遇到非法 ObjectId 格式会抛 CastError 被兜底成 500 | `middleware/ownership.js` | catch 加 CastError 分支 → 404 |

### 5. AI 做错了什么（两次同类问题，均由测试发现）

| # | 问题 | 现象 | 暴露方式 |
|---|------|------|---------|
| 1 | **illegal 检查未落地**：AI 声称已在 PATCH /:surveyId 加入非法字段检查，实际文件里没有写入 | T20b 测试混传 `{title, creator_id}` 返回 200，title 被改，creator_id 被静默忽略 | 由 T20b 测试发现 |
| 2 | **CastError 分支未落地**：AI 声称已在 ownership.js 加入 CastError → 404 处理，实际 catch 块仍是原始 500 兜底 | T24 测试 `GET /api/surveys/notanobjectid` 返回 500 | 由 T24 测试发现 |

### 6. 教训与修正

- AI 每次声称修改后，**必须用 Read 工具读取文件验证**，不能只贴"修改后片段"。
- 第二次修复时要求 AI 执行 **Read → Edit → Read 验证** 流程，确认代码真的落地。
- 这两处问题由我在测试阶段发现，暴露了"AI 声称改了但实际没改"的风险，属于 AI 使用中必须人工兜底的环节。

### 7. 测试结果

所有测试在本地 PowerShell 终端执行，服务器由 `npm run dev` 启动。13 条全部通过。

| # | 测试场景 | 方法 + URL | 预期 | 实际 | 通过 |
|---|---------|-----------|------|------|:----:|
| T12 | 创建问卷（中文标题+说明，UTF-8 字节流） | POST /api/surveys | 201 | 201，返回 id / url_token(16位hex) / status=draft / questions=0，数据库中文正确 | ✅ |
| T13 | 列表（aggregate） | GET /api/surveys | 200 | count=1，question_count=0，响应不含 questions 字段 | ✅ |
| T14 | 详情 | GET /api/surveys/:id | 200 | 200，questions 为空数组 | ✅ |
| T15 | PATCH 元信息（中文标题） | PATCH /api/surveys/:id | 200 | 200，title=已改标题 | ✅ |
| T16 | status open→closed | PATCH /api/surveys/:id/status | 200 | 200，状态依次为 open、closed | ✅ |
| T17 | 非创建者 charlie 访问 bob 的问卷 | GET /api/surveys/:id | 403 | 403 | ✅ |
| T19 | 无 token 创建 | POST /api/surveys | 401 | 401 | ✅ |
| T20a | PATCH 只传非法字段 creator_id | PATCH /api/surveys/:id | 400 | 400 | ✅ |
| T20b | PATCH 混传 title + creator_id | PATCH /api/surveys/:id | 400 | 400，title 未被篡改（修复后） | ✅ |
| T21 | PATCH status 传非法值 hacked | PATCH /api/surveys/:id/status | 400 | 400 | ✅ |
| T22 | charlie 的问卷列表 | GET /api/surveys | 0 条 | 0 条，看不到 bob 的问卷 | ✅ |
| T24 | GET /api/surveys/notanobjectid（非法 ObjectId 格式） | GET /api/surveys/notanobjectid | 404 | 404（修复后，原为 500） | ✅ |
| T18 | DELETE 问卷 + 再查 | DELETE /api/surveys/:id | 204 | 204，再查 404 | ✅ |

**中途踩的坑（不是代码 bug）**：

> 中文请求需用 `[System.Text.Encoding]::UTF8.GetBytes()` 转字节流并指定 `charset=utf-8`，否则 PowerShell 5.1 会把中文编码成 `?`。**根因是测试命令写法问题，不是后端问题。**

### 8. 我自己确认或补充的决策

| # | 决策 | 内容 | 理由 |
|---|------|------|------|
| D1 | 所有写操作用 save() | 不用 findOneAndUpdate，统一用文档 save() 模式 | 保证乐观锁语义可控，便于排查 |
| D2 | __v 递增已知限制 | Mongoose 的 __v 只对数组字段变更自动递增，普通字段 save() 不 +1，当前 PATCH 后 __v 仍为 0。F3 的版本冲突检测需要显式 `$inc: { __v: 1 }`，将在 F3 阶段处理 | 已知限制，提前记录 |
| D3 | 中文请求编码 | PowerShell 5.1 下中文请求体需 UTF-8 字节流 + charset 头 | 避免中文被编码成 ?，是测试命令约束而非后端问题 |

---

## Question 模块（Q1 添加题、Q2 修改 jump_rules、S5 发布校验）

### 1. 使用工具

- 对话式 AI Agent
- 人工执行 PowerShell 测试
- 人工执行 git 命令

### 2. 提示词摘要

> 基于已冻结的 API 契约 v1.2.1，只生成 Question 相关路由与校验：Q1 POST /:surveyId/questions（四种题型，不允许传 jump_rules）、Q2 PATCH /:surveyId/questions/:questionId/jump_rules（白名单只允许 jump_rules，混传其他字段 400）、S5 PATCH status 时接入发布前完整校验。校验逻辑抽到 utils/questionValidator.js，三个函数分别负责 Q1 格式校验、Q2 存在性校验、S5 完整校验（存在性+向前+无环）。

### 3. AI 产出

新建 1 个文件 + 修改 1 个文件：

| 文件 | 内容 |
|------|------|
| `utils/questionValidator.js` | 3 个函数：`validateQuestionInput`（Q1 题目格式校验）、`validateJumpRulesExist`（Q2 jump_rules 存在性校验）、`validate_all_jump_rules_for_publish`（S5 发布前完整校验：存在性 + 向前 + DFS 无环） |
| `routes/surveys.js` | 新增 Q1、Q2 两个路由；S5 status→open 时调用 `validate_all_jump_rules_for_publish`，未通过返回 422 `INVALID_JUMP_RULE` |

### 4. 我在 Review 中发现并要求 AI 修改的点

| # | 问题 | 位置 | 修正 |
|---|------|------|------|
| 1 | Q1 未校验 `options[].value`：只检查了 label，没检查 value 非空、value 唯一。漏 value 会导致 F2 答题无法匹配、跳转规则无法用 option.value 比较 | `utils/questionValidator.js` validateQuestionInput choice 分支 | 加 `values` Set，检查 `opt.value` 非空字符串 + value 唯一，判重同样用 `trim().toLowerCase()` 归一化，存储仍保留原始 value |
| 2 | Q2 未校验 `jump_rules[].condition` 结构：没检查 `condition.operator` 枚举和 `condition.value` 存在性。非法 operator 存入 DB 后 F2 执行 condition_matches 静默失效 | `utils/questionValidator.js` validateJumpRulesExist | 加 `allowedOperators = ['equals','includes','gte','lte','eq','between']`，检查 condition 对象存在、operator 在枚举内、value !== undefined |
| 3 | multiple_choice 的 `min_choices` 未检查 > options.length：options.length=2、min_choices=3 时校验通过，填写永远无法满足，问卷变死题 | `utils/questionValidator.js` validateQuestionInput multiple_choice 分支 | 补 `min_choices > options.length` 检查，与 max_choices 检查并列 |
| 4 | label 判重原是精确字符串匹配，未归一化 | `utils/questionValidator.js` | 改为 `trim().toLowerCase()` 归一化判重，存储仍保留原始 label；value 判重同样归一化 |

### 5. AI 做错了什么（第三次同类问题：声称验证但未贴代码）

| # | 问题 | 现象 | 暴露方式 |
|---|------|------|---------|
| 1 | **表格描述替代代码块**：AI 声称"Read 验证了修改"，回复里用表格写"确认第 XX 行"，但没有贴出从文件实际读取的代码块 | 我 review 时无法直接核对代码逻辑，只能看到行号和描述 | 由我指出"表格描述不能替代代码"，要求 AI 从文件实际读取并贴出完整代码块后才确认 |

> 这是同类问题的第三次：前两次是 illegal 检查未落地、CastError 分支未落地（均由测试发现），本次是"声称 Read 验证但未贴代码"（由我在 review 阶段指出）。三次的共同根因是 AI 倾向于用描述代替实际证据。

### 6. 教训与修正

- 每次声称修改后，**必须贴出从文件实际读取的代码块**，不能只给行号、表格描述或"修改后片段"。
- 本轮之后 AI 已能规范执行 **Read → Edit → Read → 贴出实际代码** 流程。

### 7. 测试结果

所有测试在本地 PowerShell 终端执行，服务器由 `npm run dev` 启动。19 条全部通过。

| # | 测试场景 | 方法 + URL | 预期 | 实际 | 通过 |
|---|---------|-----------|------|------|:----:|
| Q1-1 | 添加单选题（中文 label+value） | POST /:id/questions | 201 | 201，order=0，jump_rules=[] | ✅ |
| Q1-2 | 添加数字题（中文） | POST /:id/questions | 201 | 201，order=1 | ✅ |
| Q1-3 | Q1 传 jump_rules 字段 | POST /:id/questions | 400 | 400 | ✅ |
| Q1-4 | choice 选项缺 value | POST /:id/questions | 400 | 400 | ✅ |
| Q1-5 | choice 选项 value 大小写重复（v1 与 V1） | POST /:id/questions | 400 | 400 | ✅ |
| Q1-6 | multiple_choice min_choices=3 但只有 2 个选项 | POST /:id/questions | 400 | 400 | ✅ |
| Q1-7 | 添加多选题（3 选项，validation min_choices:1 max_choices:2） | POST /:id/questions | 201 | 201，order=2，type=multiple_choice，options=3，validation 正确 | ✅ |
| Q1-8 | 添加文本题（validation min_length:0 max_length:500） | POST /:id/questions | 201 | 201，order=3，type=text，validation 正确 | ✅ |
| Q2-1 | 设置合法 jump_rules（equals other → null） | PATCH .../jump_rules | 200 | 200，count=1 | ✅ |
| Q2-2 | condition.operator 非法（hacked） | PATCH .../jump_rules | 400 | 400 | ✅ |
| Q2-3 | condition.value 缺失 | PATCH .../jump_rules | 400 | 400 | ✅ |
| Q2-4 | targetQuestionId 引用不存在的题目 | PATCH .../jump_rules | 400 | 400 | ✅ |
| Q2-5 | 混传 {jump_rules:[], title:"篡改"} | PATCH .../jump_rules | 400 | 400 | ✅ |
| Q2-6 | jump_rules 传空数组清空规则 | PATCH .../jump_rules | 200 | 200，count=0 | ✅ |
| Q2-7 | questionId 不存在 | PATCH .../questions/507f.../jump_rules | 404 | 404 | ✅ |
| S5-1 | 合法规则发布 open | PATCH /:id/status | 200 | 200，status=open | ✅ |
| S5-2 | 回跳规则（Q1 order=0 跳回 Q1）发布 open | PATCH /:id/status | 422 | 422，INVALID_JUMP_RULE | ✅ |
| S5-3 | 非法规则但 status→draft（不校验） | PATCH /:id/status | 200 | 200，status=draft | ✅ |
| Q1-9 | 无 token 调 Q1 | POST /:id/questions | 401 | 401 | ✅ |

### 8. 已知限制

| # | 限制 | 说明 |
|---|------|------|
| 1 | 类型检查未做 | `min_choices` / `max_choices` / `min_length` / `max_length` / `min` / `max` 未检查 `typeof === 'number'`，传入字符串 `"5"` 可能被跳过或导致 NaN 比较。后续 F2 填写时可能暴露 |
| 2 | Q1 未拒绝 order 字段 | 传了 `order` 会被静默忽略（push 时用 `questions.length` 覆盖）。建议检测到 order 也返回 400 |
| 3 | 环检测属防御性代码 | 当前向前校验强制所有边 order 递增，规则图必然是 DAG，单测无法触发环检测。保留作为未来扩展（如允许 order 相等跳转）的兜底 |
| 4 | condition.value 用 `=== undefined` 判断，不拦 null | 传 `value: null` 会通过校验。当前不影响 F2 逻辑（null 与任何值比较都不命中），但语义上应明确拒绝 |

---

> 下一个模块（填写端 F1 + F2 + F3）的日志接续追加到此文件。

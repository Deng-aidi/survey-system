# AI 使用日志

> 本文件记录每个模块开发过程中的真实 AI 使用情况，作为课程评分依据。

---

## Auth 模块（注册、登录、JWT 鉴权）

### 1. 使用工具

- Trae（AI 编程工具，对话式 Agent）
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

- Trae（AI 编程工具，对话式 Agent）
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

- Trae（AI 编程工具，对话式 Agent）
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

## Fill 模块（F1 取问卷、F2 单题校验+跳转、F3 整卷提交+重放校验）

### 1. 使用工具

- Trae（AI 编程工具，对话式 Agent）
- 人工执行 PowerShell 测试
- 人工执行 git 命令
- 人工执行 mongosh DB 验证

### 2. 提示词摘要

> 按 API 契约 v1.2.1 实现填写端 F1/F2/F3。新建 `routes/fill.js` 挂载 `/api/surveys/by-token`、`middleware/optionalAuth.js`（条件鉴权：有 Bearer 头则验签挂 req.user，无头放行）、`utils/jumpResolver.js`（`condition_matches` 支持 6 种 operator、`resolve_next_question` 返回 `{ matched, target }`）。复用 `validateAnswer`。不改 `routes/surveys.js` 和 `models/Survey.js`，不生成前端与统计代码。

### 3. AI 产出

| 文件 | 内容 |
|------|------|
| `middleware/optionalAuth.js` | 新建。有 Bearer 头则验签挂 req.user，无头或验签失败均放行 |
| `utils/jumpResolver.js` | 新建。`condition_matches` 支持 equals/includes/gte/lte/eq/between 6 种 operator；`resolve_next_question` 返回 `{ matched, target }` 结构，消除 null 二义性 |
| `routes/fill.js` | 新建。F1 取问卷（不含 creator_id）、F2 单题校验+跳转（无状态）、F3 重放路径+全量校验+落库；公共函数 `loadAccessibleSurvey` |
| `server.js` | 引入并挂载 fillRouter，置于 `/api/surveys` 之前 |

### 4. 我 review 中发现并要求修改的点

| # | 优先级 | 问题 | 修正 |
|---|:---:|------|------|
| 1 | P0 | **draft 问卷可被填写**。`loadAccessibleSurvey` 原只拦 closed 和过期，draft 放行会导致"未发布即可填"且绕过 S5 发布校验 | 改为 `status !== 'open'` 一律 403，draft 用 `SURVEY_NOT_OPEN`、closed 用 `SURVEY_CLOSED` 区分 |
| 2 | P1 | F2 校验失败的 errors 是 `string[]`，与契约要求的 `[{question_id, reason}]` 不一致，前端要为 F2/F3 写两套解析 | 改为 `result.errors.map((reason) => ({ question_id, reason }))` |
| 3 | P2 | F3 的 answers 里重复 question_id 静默 last-wins | 加 `seenQids` Set 检测，重复返回 400 |

### 5. AI 做错了什么

本轮无"声称改了但未落地"问题。AI 按约束执行 Read → Edit → Read 并贴出从文件实际读取的代码块。但设计层面有 1 个 P0 语义漏洞（draft 可填写），由我在 review 阶段发现，不是 AI 自查发现。

### 6. 我对 AI 提出的 6 条设计决策的裁决

| # | 决策 | 裁决 |
|---|------|------|
| 1 | `skipped_count` = 题目总数 - 已答题数 | 接受 |
| 2 | F3 题目归属检查提前到重放之前 | 接受，可观察结果相同（都是 409） |
| 3 | optionalAuth 无效 token 静默按匿名 | 接受，写入已知限制 |
| 4 | F3 循环保护 | 保留，必要。路径不完整导致的额外误报写入已知限制 |
| 5 | F2 题目不存在返回 400 + `QUESTION_NOT_FOUND` | 接受 |
| 6 | draft 可填写 | 不接受，见 P0 |

### 7. __v 说明（良性特性，非限制）

**说明：本节修正 Survey CRUD 模块第 8 节 D2 的判断。** 当时认为 __v 只在数组变更时递增不够用、需要显式 $inc；实际开发 F 模块时验证发现，影响填写路径的所有操作（加题、改 jump_rules）恰好都是 questions[] 数组变更，__v 天然递增已足够覆盖，无需显式 $inc。原 D2 的"已知限制"判断不成立，以本节为准。

Mongoose 的 `__v` 在数组字段变更时递增，而"题目增删/修改 jump_rules"恰好都是 `questions[]` 数组变更，因此 `expected_version` 能覆盖所有影响填写路径的结构性变化。`title`/`status`/`description` 变更不递增 `__v`，但不影响填写逻辑。实测 F1-1 返回 `__v=7`，与多次加题、设规则的次数吻合。

### 8. 测试结果

所有测试在本地 PowerShell 终端执行，服务器由 `npm run dev` 启动。23 条全部通过（F1×6、F2×9、F3×8，含 DB 验证）。

F1：

| # | 测试场景 | 预期 | 实际 | 通过 |
|---|---------|------|------|:----:|
| F1-1 | 匿名问卷无 token 取 | 200 | 200，status=open，q=4，无 creator_id，__v=7 | ✅ |
| F1-2 | 非匿名无 token | 401 | 401 LOGIN_REQUIRED | ✅ |
| F1-3 | 非匿名带 token | 200 | 200 | ✅ |
| F1-4 | draft 问卷 | 403 | 403 SURVEY_NOT_OPEN | ✅ |
| F1-5 | closed 问卷 | 403 | 403 SURVEY_CLOSED | ✅ |
| F1-6 | token 不存在 | 404 | 404 SURVEY_NOT_FOUND | ✅ |

F2：

| # | 测试场景 | 预期 | 实际 | 通过 |
|---|---------|------|------|:----:|
| F2-1 | Q1=male（不命中规则） | valid=true，next 非空 | valid=true，next=QT（默认下一题） | ✅ |
| F2-2 | QN=30（最后一题，不命中 gte60） | valid=true，next=null | valid=true，next=null | ✅ |
| F2-3 | QM 空数组（必答） | valid=false | valid=false，errors=[{question_id, reason:"本题必答"}] | ✅ |
| F2-4 | QM 选 3 个超 max=2 | valid=false | valid=false | ✅ |
| F2-5 | QN=3.5（integer=true） | valid=false | valid=false | ✅ |
| F2-6 | Q1=other（命中 equals→null） | valid=true，next=null | valid=true，next=null | ✅ |
| F2-7 | QM=[apple,banana]（命中 includes→null） | valid=true，next=null | valid=true，next=null | ✅ |
| F2-8 | QM=[apple]（不命中） | valid=true，next 非空 | valid=true，next=QN（默认下一题） | ✅ |
| F2-9 | 缺 question_id | 400 | 400 MALFORMED_REQUEST | ✅ |

F3：

| # | 测试场景 | 预期 | 实际 | 通过 |
|---|---------|------|------|:----:|
| F3-1 | 登录用户完整提交 4 题 | 201 | 201，answered=4，skipped=0 | ✅ |
| F3-2 | 匿名未登录完整提交 | 201 | 201，answered=4 | ✅ |
| F3-3 | Q1=other 跳结束，QM/QN 必答被绕过 | 201，不校验被跳过题 | 201，answered=1，skipped=3（不报必答错） | ✅ |
| F3-4 | 路径内漏答必答 QN | 400 | 400 FINAL_VALIDATION_FAILED，errors 含 QN 必答未作答 | ✅ |
| F3-5 | Q1=other 路径外又带 QM | 400 | 400 FINAL_VALIDATION_FAILED，errors 含"该题目不在本次填写路径上" | ✅ |
| F3-6 | expected_version=999 冲突 | 409 | 409 SURVEY_CONFLICT | ✅ |
| F3-7 | answers 不是数组 | 400 | 400 MALFORMED_REQUEST | ✅ |
| F3-8 | DB 验证 SUB1/SUB2 | DB 形态正确 | SUB1 user_id=ObjectId(bob)，SUB2 user_id=null；answers 4 条按 order 排，question_type 齐全，answer 形态 String/String/String[]/Number | ✅ |

关键对照：F2-1(QT) vs F2-6(null)、F2-8(QN) vs F2-7(null) 两组证明跳转解释器真正数据驱动；F3-3 vs F3-4 证明重放路径能区分"跳转绕过必答"和"真漏答必答"。

### 9. 已知限制

| # | 限制 | 说明 |
|---|------|------|
| 1 | optionalAuth 对无效/过期 token 静默按匿名处理 | 过期 token 访问非匿名问卷会得到 LOGIN_REQUIRED 而非 TOKEN_EXPIRED，UX 稍差 |
| 2 | F3 循环保护提前 break 时 path_ids 不完整 | 可能同时报"循环"和"不在路径上"两类错误 |
| 3 | started_at 与 submitted_at 均取提交时刻 | 未接入真实开始填写时间（F1 未下发会话标识） |
| 4 | expected_version 用严格 `!==` 比较 | 前端传字符串 `"0"` 会被判为冲突 |
| 5 | user_id 直接 `new ObjectId(req.user._id)` | 若 JWT 中 `_id` 非 24 位 hex 会抛错转为 500 |

---

## Stats 模块（T1 整卷统计、T2 单题统计）

### 1. 使用工具

- Trae（AI 编程工具，对话式 Agent）
- 人工执行 PowerShell 测试
- 人工执行 git 命令

### 2. 提示词摘要

> 实现 T1 整卷统计（支持 `?questionId=` 可选筛选）、T2 单题统计，严格按 API 契约 v1.2.1。单选 `$group by answer`，多选 `$unwind answer` 再 `$group`，数字 `$avg/$min/$max`，文本 `$push`。option.value → label 映射由后端做，零计数选项保留。聚合不 `$lookup`，questions 定义从已查到的 survey 文档取。可新建 routes/stats.js 或复用 routes/surveys.js，stats 路由必须注册在 `GET /:surveyId` 之前。

### 3. AI 产出

| 文件 | 内容 |
|------|------|
| `routes/surveys.js` | 新增 `Submission` 导入、`buildQuestionStats` 公共函数、T1/T2 两路由（注册在 `GET /:surveyId` 之前） |
| 其他文件 | 未新建 routes/stats.js，未修改其他文件 |

### 4. 方案选择

选 surveys.js 而非新建 stats.js：统计是问卷的创建者子资源，`authenticate + requireSurveyOwner` 已现成接线，server.js 零改动。

### 5. 我拍板的 3 个决策

| # | 决策 |
|---|------|
| 1 | T1 的 `?questionId=` 不存在返回 404 QUESTION_NOT_FOUND，与 T2 一致 |
| 2 | 响应按题型只含相关字段：choice 无 stats/all_values，number/text 无 option_counts |
| 3 | 多选 answer_count 用额外 countDocuments 单独计数（Σcount 是选择次数不是作答次数） |

### 6. 我 review 确认的 5 个关键点

1. 零计数选项按 question.options 顺序遍历补 0，不是只遍历聚合结果。
2. stats 路由注册在 GET /:surveyId 之前。
3. number 无数据时 stats 全 null，不是 0。
4. 多选两次 $unwind（先 answers 再 answers.answer）。
5. answer_count 与 total_submissions 独立。

### 7. AI 做错了什么

本轮无"声称改了但未落地"问题，代码一次通过 review。设计决策由 AI 提出、我拍板，无返工。

### 8. 测试结果

12 条全部通过。

| # | 测试场景 | 预期 | 实际 | 通过 |
|---|---------|------|------|:----:|
| T1-1 | 整卷统计 | total=3，4 题 | total=3，questions=4 | ✅ |
| T1-2 | Q1 单选 | male=2 other=1 female=0 | answer_count=3，male=2 female=0 other=1（零计数保留） | ✅ |
| T1-3 | QM 多选 | apple=2 banana=0 grape=0 | answer_count=2，apple=2 banana=0 grape=0 | ✅ |
| T1-4 | QN 数字 | count=2 avg=27.5 min=25 max=30 | 全部符合，all_values=30,25 | ✅ |
| T1-5 | QT 文本 | count=2，含 good/anon | all_values=good\|anon | ✅ |
| T1-6 | ?questionId= 筛选 | 只返回 Q1 | questions=1，id=Q1 | ✅ |
| T1-7 | 非创建者 charlie | 403 | 403 | ✅ |
| T1-8 | 无 token | 401 | 401 | ✅ |
| T1-9 | surveyId 不存在 | 404 | 404 | ✅ |
| T1-10 | S_B 零提交问卷 | total=0，选项全 0 | total=0 answer_count=0，a=0 b=0 | ✅ |
| T2-1 | 单题统计 | Q1，count=3 | question_id=Q1，answer_count=3 | ✅ |
| T2-2 | questionId 不属于该问卷 | 404 | 404 | ✅ |

关键验证：T1-2 的 female=0 和 T1-3 的 banana=0/grape=0 证明零计数选项按 options 顺序补全，前端画图不会缺项；T1-4 的 avg=27.5 证明数字聚合正确；T1-10 证明零提交时结构完整。

### 9. 已知限制

| # | 限制 | 说明 |
|---|------|------|
| 1 | T1 对 N 道题做 N 个聚合管道 + 多选题额外 countDocuments | 数据量大时是 N+1 次查询；题目量小可接受 |
| 2 | `all_values` 无分页 | 文本题答案量大时响应体积不可控 |

---

> 下一个模块（前端页面）的日志接续追加到此文件。

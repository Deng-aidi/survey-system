# API 接口说明

## 1. 基础约定

### 1.1 接口前缀

所有接口统一挂载在 `/api` 前缀下，基址为 `http://localhost:3000/api`。

### 1.2 鉴权方式

采用 **Bearer Token** 模式。登录成功后，客户端需在后续请求的 Header 中携带：

```
Authorization: Bearer <token>
```

Token 为 JWT（HS256 签名），payload 含 `{ _id, username }`，有效期由后端配置决定。

- **必须鉴权**：Auth 模块的 `/me`、Survey CRUD 全部、Question 模块全部、Stats 模块全部。缺失或无效 token 返回 401。
- **可选鉴权**：Fill 模块全部。携带有效 token 时提交会记录填写者 `user_id`，否则按匿名处理（问卷 `allow_anonymous` 为 false 时才强制要求登录）。

### 1.3 统一错误响应格式

```json
{
  "code": "ERROR_CODE",
  "message": "人类可读的错误描述",
  "errors": [
    { "question_id": "...", "reason": "具体错误原因" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | String | 是 | 稳定错误码，前端可据此做分支处理 |
| `message` | String | 是 | 一句话概括 |
| `errors` | Array | 否 | 结构化详细错误。跳转规则发布校验（422）、提交重放校验（400）时返回；单题校验返回 200 + `valid: false` 时也返回 |

### 1.4 通用错误码速查

| HTTP | code | 出现场景 |
|---|---|---|
| 400 | MALFORMED_REQUEST | 请求体格式不合法（缺字段、类型不对、混传非法字段） |
| 400 | VALIDATION_ERROR | Mongoose Schema 校验未通过 |
| 400 | INVALID_JUMP_RULE | 跳转规则配置非法（Q2 配置阶段） |
| 400 | DUPLICATE_QUESTION | 同一问卷重复添加同一版本的同一题库题（跨卷统计防漏算，见第二阶段 M7） |
| 401 | UNAUTHORIZED | 无 token / 无效 token |
| 401 | LOGIN_REQUIRED | 该问卷仅限登录用户填写（匿名访问非匿名问卷） |
| 403 | FORBIDDEN | 非创建者访问他人问卷 |
| 403 | SURVEY_NOT_OPEN | 问卷处于 draft 状态，尚未发布 |
| 403 | SURVEY_CLOSED | 问卷已关闭 |
| 403 | SURVEY_EXPIRED | 问卷已过截止时间 |
| 403 | QUESTION_NOT_ACCESSIBLE | 无权限使用该题库题（既非创建者、也非共享对象） |
| 404 | NOT_FOUND | 路由不存在 |
| 404 | SURVEY_NOT_FOUND | 问卷不存在（按 token 查找时） |
| 404 | QUESTION_NOT_FOUND | 题目不存在（问卷内嵌题或题库题） |
| 409 | DUPLICATE_KEY | 用户名重复注册 / 题库版本号并发冲突 |
| 409 | SURVEY_CONFLICT | 填写期间问卷结构被修改，版本不匹配 |
| 409 | SURVEY_STRUCTURE_LOCKED | 问卷已发布或已关闭，结构不可修改（加题、改跳转、从题库加、删题） |
| 409 | CANNOT_REVERT_TO_DRAFT | 已发布过的问卷不能再回退 draft（open / closed → draft 均拒绝） |
| 409 | VERSION_CONFLICT | 题库版本号并发冲突，创建新版本时重试后仍撞号 |
| 422 | INVALID_JUMP_RULE | 发布时跳转规则校验未通过 |
| 500 | INTERNAL_ERROR | 服务器内部错误 |

---

## 2. Auth 模块

### 2.1 POST /api/auth/register — 注册

是否需鉴权：否

请求体：
```json
{ "username": "bob", "password": "secret123" }
```
- `username`：2–32 字符，trim 后唯一
- `password`：≥6 字符

成功响应 `201`：
```json
{ "_id": "...", "username": "bob", "created_at": "2026-10-20T..." }
```
- 响应**不含** password 字段

主要错误：400 参数错（缺字段/密码过短）、409 用户名重复（E11000）

### 2.2 POST /api/auth/login — 登录

是否需鉴权：否

请求体：
```json
{ "username": "bob", "password": "secret123" }
```

成功响应 `200`：
```json
{ "token": "eyJhbGci...", "user": { "_id": "...", "username": "bob" } }
```

主要错误：400 参数错、401 用户名或密码错误

### 2.3 GET /api/auth/me — 当前用户

是否需鉴权：是

成功响应 `200`：
```json
{ "_id": "...", "username": "bob", "created_at": "..." }
```
- 响应**不含** password 字段

主要错误：401 未登录 / token 无效

---

## 3. Survey CRUD 模块

所有端点需鉴权 + 创建者身份校验（`creator_id === 当前用户`）。

### 3.1 POST /api/surveys — 创建问卷

是否需鉴权：是

请求体：
```json
{
  "title": "用户满意度调查",
  "description": "简短的问卷说明（可选）",
  "allow_anonymous": true,
  "deadline": "2026-12-31T23:59:59Z"
}
```
- 全部字段可选；`title` 必填，trim 后最长 100 字符
- 默认 `allow_anonymous: false`，默认 `status: 'draft'`
- `url_token` 由后端自动生成（16 位十六进制），全局唯一

成功响应 `201`：返回完整 Survey 文档

主要错误：400 参数错（缺 title / 字段类型不对）

### 3.2 GET /api/surveys — 我的问卷列表

是否需鉴权：是

无请求体。

成功响应 `200`：
```json
[
  {
    "_id": "...",
    "url_token": "abc123...",
    "title": "...",
    "status": "draft",
    "question_count": 0,
    "allow_anonymous": true,
    "deadline": null,
    "created_at": "...",
    "updated_at": "..."
  }
]
```
- 通过 aggregate 管道返回，**不含** `questions[]`、`creator_id`、`__v`，附 `question_count` 字段
- 按 `created_at` 倒序

### 3.3 GET /api/surveys/:surveyId — 问卷详情

是否需鉴权：是

成功响应 `200`：返回完整 Survey 文档（含 `questions[]`、`__v`）

主要错误：403 非创建者、404 surveyId 不存在

### 3.4 PATCH /api/surveys/:surveyId — 更新元信息

是否需鉴权：是

请求体：**仅允许** `title` / `description` / `allow_anonymous` / `deadline` 四个字段，混传其他字段返回 400。

```json
{ "title": "新标题", "deadline": "2026-11-30T00:00:00Z" }
```

成功响应 `200`：返回更新后的完整 Survey

主要错误：400 非法字段 / 参数错、403 非创建者、404 不存在

### 3.5 PATCH /api/surveys/:surveyId/status — 改变状态

是否需鉴权：是

请求体：
```json
{ "status": "open" }
```
- 枚举：`draft` / `open` / `closed`
- 置为 `open` 时触发**发布前校验**（跳转规则存在性 + 只允许向前 + DFS 无环）

成功响应 `200`：返回更新后的 Survey

主要错误：400 status 非法值、403 非创建者、404 不存在、**422 INVALID_JUMP_RULE**（发布校验未通过，errors 数组逐条列出）

### 3.6 DELETE /api/surveys/:surveyId — 删除问卷

是否需鉴权：是

成功响应 `204`：无响应体。Survey 文档删除时会**级联删除**其下所有 Submission（通过 pre('deleteOne') hook）。

主要错误：403 非创建者、404 不存在

---

## 4. Question 模块

均需鉴权 + 创建者身份校验。操作对象是 Survey 内嵌的 `questions[]` 数组。

### 4.1 POST /api/surveys/:surveyId/questions — 添加题目

是否需鉴权：是

请求体按题型有差异，**不允许**传 `jump_rules`、`order`、`_id`（`order` 由后端自动设为当前数组长度）。

通用字段：
```json
{
  "type": "single_choice",        // single_choice / multiple_choice / text / number
  "title": "你最常用的是？",
  "required": true
}
```

按题型附加字段：
- **single_choice / multiple_choice**：
  ```json
  "options": [
    { "label": "微信", "value": "wechat" },
    { "label": "QQ", "value": "qq" }
  ]
  ```
  - `value` 必填、非空、同题内唯一（大小写不敏感判重）
- **multiple_choice 独有**：
  ```json
  "validation": { "min_choices": 1, "max_choices": 2 }
  ```
- **text 独有**：
  ```json
  "validation": { "min_length": 0, "max_length": 500 }
  ```
- **number 独有**：
  ```json
  "validation": { "min": 0, "max": 100, "integer": true }
  ```

成功响应 `201`：返回更新后的完整 Survey

主要错误：400 参数错（缺字段、options 缺 value、value 重复、min_choices > options.length、混传 jump_rules）、403 非创建者、404 surveyId 不存在

### 4.2 PATCH /api/surveys/:surveyId/questions/:questionId/jump_rules — 配置跳转规则

是否需鉴权：是

请求体**仅允许** `jump_rules` 一个字段，混传其他返回 400。

```json
{
  "jump_rules": [
    {
      "condition": { "operator": "equals", "value": "other" },
      "targetQuestionId": null
    },
    {
      "condition": { "operator": "includes", "value": "apple" },
      "targetQuestionId": null
    }
  ]
}
```

- `condition.operator` 枚举：`equals` / `includes` / `gte` / `lte` / `eq` / `between`
- `condition.value` 必填；`between` 时应为二元数组 `[min, max]`
- `targetQuestionId`：目标题 `_id`；`null` 表示跳到问卷结束
- 规则按数组顺序匹配，第一条命中即生效

成功响应 `200`：返回更新后的完整 Survey

主要错误：400 非法 operator / 缺 value / targetQuestionId 引用不存在 / 混传字段、403 非创建者、404 surveyId 或 questionId 不存在

---

## 5. Fill 模块（填写端）

挂载在 `/api/surveys/by-token` 前缀下，**在 `/api/surveys` 之前注册**，避免被单段路由抢占。均使用 `optionalAuth`：无 token 或无效 token 均放行，只有"非匿名问卷 + 无登录态"才返回 401。

### 5.1 F1 GET /api/surveys/by-token/:token — 取问卷

是否需鉴权：可选（anonymous 问卷无需）

成功响应 `200`：
```json
{
  "_id": "...",
  "url_token": "...",
  "title": "...",
  "description": "...",
  "allow_anonymous": true,
  "status": "open",
  "deadline": null,
  "questions": [
    {
      "_id": "...",
      "type": "single_choice",
      "title": "...",
      "order": 0,
      "required": true,
      "options": [...],
      "validation": {...},
      "jump_rules": [...]
    }
  ],
  "__v": 7
}
```
- **不含** `creator_id`，防止泄露创建者身份
- `__v` 用于提交时的版本冲突检测

主要错误：401 LOGIN_REQUIRED（非匿名问卷 + 未登录）、403 SURVEY_NOT_OPEN / SURVEY_CLOSED / SURVEY_EXPIRED、404 SURVEY_NOT_FOUND

### 5.2 F2 POST /api/surveys/by-token/:token/answers/validate — 单题校验 + 跳转

是否需鉴权：可选

请求体：
```json
{ "question_id": "...", "answer": "male" }
```

answer 形态：
| 题型 | 形态 | 示例 |
|---|---|---|
| single_choice | String | `"male"` |
| multiple_choice | String[] | `["apple", "banana"]` |
| text | String | `"good product"` |
| number | Number | `25` |

成功响应（校验通过）`200`：
```json
{ "valid": true, "next_question_id": "... | null" }
```
- `next_question_id` 为 `null` 表示问卷结束

业务态（校验未通过）**仍返回 200**：
```json
{ "valid": false, "errors": [{ "question_id": "...", "reason": "本题必答" }] }
```

主要错误（传输层）：401 / 403 / 404 同 F1，400 MALFORMED_REQUEST（缺 question_id / answer 为 undefined）

### 5.3 F3 POST /api/surveys/by-token/:token/submissions — 提交

是否需鉴权：可选（匿名问卷无需）

请求体：
```json
{
  "answers": [
    { "question_id": "...", "answer": "male" },
    { "question_id": "...", "answer": ["apple"] },
    { "question_id": "...", "answer": "good" },
    { "question_id": "...", "answer": 30 }
  ],
  "expected_version": 7
}
```
- `answers` 必须是数组，每项含 `question_id`（字符串）+ `answer`（已定义），不允许重复 `question_id`
- `expected_version` 为 F1 返回时的 `__v`，用于乐观锁

成功响应 `201`：
```json
{ "submission_id": "...", "submitted_at": "..." }
```

主要错误：
- **409 SURVEY_CONFLICT**：expected_version 与当前 `__v` 不一致（问卷结构被改过），或答案中 question_id 不属于当前问卷
- **400 FINAL_VALIDATION_FAILED**：重放路径校验未通过，errors 数组逐条列出（必答未作答 / 答案类型不对 / 不在路径上 / 跳转目标不存在 / 路径成环）
- 400 MALFORMED_REQUEST：answers 不是数组 / 元素格式错 / 重复 question_id
- 401 / 403 / 404 同 F1

---

## 6. Stats 模块

均需鉴权 + 创建者身份校验。

### 6.1 T1 GET /api/surveys/:surveyId/stats — 整卷统计

是否需鉴权：是

可选查询参数：`?questionId=<id>` 仅返回指定题，不存在时 404

成功响应 `200`：
```json
{
  "survey_id": "...",
  "survey_title": "用户满意度调查",
  "total_submissions": 3,
  "questions": [
    {
      "question_id": "...",
      "question_title": "性别",
      "question_type": "single_choice",
      "answer_count": 3,
      "option_counts": [
        { "option_label": "男", "option_value": "male", "count": 2 },
        { "option_label": "女", "option_value": "female", "count": 0 },
        { "option_label": "其他", "option_value": "other", "count": 1 }
      ]
    },
    {
      "question_id": "...",
      "question_title": "年龄",
      "question_type": "number",
      "answer_count": 2,
      "stats": { "avg": 27.5, "min": 25, "max": 30 },
      "all_values": [30, 25]
    },
    {
      "question_id": "...",
      "question_title": "意见",
      "question_type": "text",
      "answer_count": 2,
      "all_values": ["good product", "匿名用户意见"]
    }
  ]
}
```

按题型裁剪字段：`single_choice` / `multiple_choice` 只有 `option_counts`，`number` / `text` 只有 `stats` + `all_values`。零计数选项按 `question.options` 顺序补 0。

主要错误：401 未登录、403 非创建者、404 surveyId 或 questionId 不存在

### 6.2 T2 GET /api/surveys/:surveyId/stats/:questionId — 单题统计

是否需鉴权：是

成功响应 `200`：响应结构与 T1 的 `questions[i]` 相同，按题型裁剪字段。

主要错误：401 未登录、403 非创建者、404 surveyId 或 questionId 不存在

---

## 7. 端点清单汇总

| # | 模块 | Method | URL | 需鉴权 |
|:-:|---|---|---|:-:|
| 1 | Auth | POST | /api/auth/register | 否 |
| 2 | Auth | POST | /api/auth/login | 否 |
| 3 | Auth | GET | /api/auth/me | 是 |
| 4 | Survey CRUD | POST | /api/surveys | 是 |
| 5 | Survey CRUD | GET | /api/surveys | 是 |
| 6 | Survey CRUD | GET | /api/surveys/:surveyId | 是 |
| 7 | Survey CRUD | PATCH | /api/surveys/:surveyId | 是 |
| 8 | Survey CRUD | PATCH | /api/surveys/:surveyId/status | 是 |
| 9 | Survey CRUD | DELETE | /api/surveys/:surveyId | 是 |
| 10 | Question | POST | /api/surveys/:surveyId/questions | 是 |
| 11 | Question | PATCH | /api/surveys/:surveyId/questions/:questionId/jump_rules | 是 |
| 12 | Fill (F1) | GET | /api/surveys/by-token/:token | 可选 |
| 13 | Fill (F2) | POST | /api/surveys/by-token/:token/answers/validate | 可选 |
| 14 | Fill (F3) | POST | /api/surveys/by-token/:token/submissions | 可选 |
| 15 | Stats (T1) | GET | /api/surveys/:surveyId/stats | 是 |
| 16 | Stats (T2) | GET | /api/surveys/:surveyId/stats/:questionId | 是 |
| 17 | 题库 | POST | /api/questions | 是 |
| 18 | 题库 | GET | /api/questions | 是 |
| 19 | 题库 | GET | /api/questions/:questionId | 是 |
| 20 | 题库 | PATCH | /api/questions/:questionId | 是 |
| 21 | 题库 | POST | /api/questions/:questionId/versions | 是 |
| 22 | 题库 | GET | /api/questions/:questionId/versions | 是 |
| 23 | 题库 | POST | /api/questions/:questionId/restore | 是 |
| 24 | 题库 | PATCH | /api/questions/:questionId/sharing | 是 |
| 25 | 题库 | GET | /api/questions/:questionId/usages | 是 |
| 26 | 题库 | GET | /api/questions/:questionId/stats | 是 |
| 27 | 题库 | GET | /api/questions/shared | 是 |
| 28 | 问卷 | DELETE | /api/surveys/:surveyId/questions/:questionId | 是 |
| 29 | 问卷 | POST | /api/surveys/:surveyId/questions/from-library | 是 |

---

## 8. 题库模块（第二阶段新增，11 个端点）

挂载在 `/api/questions` 前缀下，全部需鉴权。权限分三类：创建者（可读可写）、共享对象（可读 + 可在自己问卷里引用）、其他登录用户（`is_shared=true` 时可读 + 可引用）。

### 8.1 POST /api/questions — 新建题库题（v1）

是否需鉴权：是（任何登录用户都能建题库题）

请求体：**仅允许** `type / title / options / validation` 四个字段，混传 `order / required / jump_rules` 等问卷上下文字段返回 400。

```json
{
  "type": "single_choice",
  "title": "你更喜欢哪种饮品？",
  "options": [
    { "label": "咖啡", "value": "coffee" },
    { "label": "茶", "value": "tea" }
  ],
  "validation": {}
}
```

成功响应 `201`：返回完整 Question 文档（含 `root_id = 自身 _id`、`parent_id = null`、`version = 1`）。

主要错误：400 参数错（缺 type / title、非法字段、options 缺 value）。

### 8.2 GET /api/questions — 我的题库（可含共享）

是否需鉴权：是

可选查询参数：`?type=single_choice`、`?keyword=coffee`（题干模糊匹配）、`?includeShared=true`。

- 默认（不带 `includeShared`）：只返回当前用户自己创建的、未归档的题库题；
- `includeShared=true`：额外包含 `is_shared=true` 的公开共享题和 `shared_with` 含当前用户的定向共享题；**自己创建的题同时也会在结果中返回**。

成功响应 `200`：数组，按 `updated_at` 倒序，最多 200 条。每条含完整 Question 文档。

### 8.3 GET /api/questions/shared — 可见共享题

是否需鉴权：是

无请求体。返回当前用户**能看到但不是自己创建**的共享题（`is_shared=true` 或 `shared_with` 含当前用户）。用于 "从题库添加" 时单独切到共享视角。

成功响应 `200`：数组，与 8.2 相同结构。

### 8.4 GET /api/questions/:questionId — 题库题详情

是否需鉴权：是（需有读权限）

成功响应 `200`：完整 Question 文档。

主要错误：403 QUESTION_NOT_ACCESSIBLE（既非创建者、也非共享对象）、404 QUESTION_NOT_FOUND。

### 8.5 PATCH /api/questions/:questionId — 仅改共享/归档字段

是否需鉴权：是（仅创建者）

请求体**仅允许** `is_shared / shared_with / archived_at` 三个字段，混传结构字段（`type / title / options / validation`）返回 400 `QUESTION_STRUCTURE_IMMUTABLE`。**改题必须走 POST /versions**，生成新版本。

```json
{ "is_shared": true }
```

成功响应 `200`：返回更新后的完整 Question。

### 8.6 POST /api/questions/:questionId/versions — 生成新版本

是否需鉴权：是（仅创建者）

请求体可选：不传时沿用当前版本内容；传 `type / title / options / validation` 时用新值覆盖（生成"基于当前版本的 vN+1"）。

```json
{ "title": "你现在更喜欢哪种饮品？（v2）" }
```

成功响应 `201`：新 Question 文档。关键字段：`root_id` 继承根节点、`parent_id = 当前文档 _id`、`version = 链内最大版本 + 1`、`is_shared / shared_with` 继承当前版本。

并发：`{root_id, version}` 唯一索引防重，冲突时应用层重试 1 次。

主要错误：409 VERSION_CONFLICT（重试后仍撞号）、403 非创建者、404 不存在。

### 8.7 GET /api/questions/:questionId/versions — 版本链

是否需鉴权：是（需有读权限）

成功响应 `200`：数组，按 `version` 升序返回整条链上所有版本的完整 Question 文档。

### 8.8 POST /api/questions/:questionId/restore — 基于旧版生成新版

是否需鉴权：是（仅创建者）

无请求体。**不覆盖**旧版本——而是用被恢复版本的内容，再生成一个新版本（`version = 链内最大 + 1`），`parent_id` 指向链尾，保持线性历史。

成功响应 `201`：新 Question 文档。

### 8.9 PATCH /api/questions/:questionId/sharing — 显式共享设置

是否需鉴权：是（仅创建者）

请求体：`{ is_shared: boolean, shared_with: [userId1, userId2] }`。禁止把自己加进 `shared_with`（返回 400）。

成功响应 `200`：返回更新后的 Question。

### 8.10 GET /api/questions/:questionId/usages — 引用追踪

是否需鉴权：是（仅创建者）

成功响应 `200`：

```json
{
  "question_id": "...",
  "root_id": "...",
  "usages": [
    { "survey_id": "...", "title": "用户调研 v1", "status": "open",
      "source_version": 1, "local_question_id": "..." },
    { "survey_id": "...", "title": "用户调研 v1", "status": "open",
      "source_version": 1, "local_question_id": "..." }
  ]
}
```

同一问卷多次引用同一题（同版本或不同版本）会返回多条记录。仅创建者可调用（隐私保护：他人不应看到自己问卷被哪些题引用）。

### 8.11 GET /api/questions/:questionId/stats — 跨卷统计

是否需鉴权：是（仅创建者）

可选查询参数：
- `?includeVersions=true`：统计整条版本链上所有版本（默认只统计当前版本）；
- `?limit=N`：数字题/文本题的 `all_values` 最多返回 N 条（默认 50）。

**统计口径**：只统计当前用户自己创建的问卷。他人创建的问卷（无论是否匿名）全部剔除，计入 `excluded_surveys_count`。

**按 schema_hash 分组**：同根题的不同快照可能有不同题面（draft 期允许本地改写），用 `schema_hash`（`type + options + validation` 规范化 MD5）分组。相同结构的快照答案合并统计，不同结构独立成组，避免本地改写污染统计。

**多版本同卷合并**：同一问卷里同时引用了 v1 和 v2 时，`answer_count` 按提交文档计数（同一人同时答了 v1 和 v2 只算 1 人），选项计数合并两个版本的答案（不遗漏）。

成功响应 `200`：

```json
{
  "question_id": "...",
  "root_id": "...",
  "included_versions": [1, 2],
  "excluded_surveys_count": 1,
  "surveys": [
    { "survey_id": "...", "title": "用户调研",
      "source_versions": [1, 2], "answer_count": 4 }
  ],
  "aggregate": {
    "answer_count": 4,
    "by_schema_group": [
      {
        "schema_hash": "a1b2c3...",
        "representative_version": 1,
        "aggregate": {
          "option_counts": [
            { "option_value": "coffee", "option_label": "咖啡", "count": 3 },
            { "option_value": "tea", "option_label": "茶", "count": 1 }
          ]
        }
      }
    ]
  }
}
```

主要错误：403 FORBIDDEN（非创建者，即使能看到这道共享题）、404 QUESTION_NOT_FOUND。

---

## 9. 问卷结构端点（第二阶段新增 2 个）

### 9.1 POST /api/surveys/:surveyId/questions/from-library — 从题库选题生成快照

是否需鉴权：是（`authenticate + requireSurveyOwner + structureLock`）

请求体：
```json
{
  "question_id": "6512a9f0...",
  "required": false,
  "order": 3
}
```

- 题库题读权限 = 创建者 ∪ `is_shared=true` ∪ `shared_with` 含当前用户；无权限返回 403 QUESTION_NOT_ACCESSIBLE；
- 同一问卷**同一版本不允许重复添加**（`source_question_id === question_id` 即命中），返回 400 DUPLICATE_QUESTION；
- 已发布/已关闭问卷返回 409 SURVEY_STRUCTURE_LOCKED。

成功响应 `201`：返回更新后的完整 Survey。新题目 `_id` 是本地生成的 ObjectId，与题库题 `_id` 不同；`source_question_id / source_version / snapshot_at / schema_hash` 自动写入。

### 9.2 DELETE /api/surveys/:surveyId/questions/:questionId — 删除问卷内题目

是否需鉴权：是（`authenticate + requireSurveyOwner + structureLock`）

成功响应 `200`：返回更新后的完整 Survey。删除后自动清理指向该题的跳转规则（避免悬空引用导致发布校验失败）；剩余题目 `order` 重排为 0..n-1。

主要错误：404 QUESTION_NOT_FOUND、409 SURVEY_STRUCTURE_LOCKED、403 FORBIDDEN。

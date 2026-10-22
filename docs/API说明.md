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
| 401 | UNAUTHORIZED | 无 token / 无效 token |
| 401 | LOGIN_REQUIRED | 该问卷仅限登录用户填写（匿名访问非匿名问卷） |
| 403 | FORBIDDEN | 非创建者访问他人问卷 |
| 403 | SURVEY_NOT_OPEN | 问卷处于 draft 状态，尚未发布 |
| 403 | SURVEY_CLOSED | 问卷已关闭 |
| 403 | SURVEY_EXPIRED | 问卷已过截止时间 |
| 404 | NOT_FOUND | 路由不存在 |
| 404 | SURVEY_NOT_FOUND | 问卷不存在（按 token 查找时） |
| 404 | QUESTION_NOT_FOUND | 题目不存在 |
| 409 | DUPLICATE_KEY | 用户名重复注册 |
| 409 | SURVEY_CONFLICT | 填写期间问卷结构被修改，版本不匹配 |
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

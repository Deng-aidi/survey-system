# 在线问卷系统

基于 **Node.js + Express + MongoDB** 构建的在线问卷系统，支持四种题型、可配置跳转、路径重放校验和零计数统计。

## ✨ 核心功能

- **四种题型**：单选、多选、文本、数字，每种题型有独立的校验规则（min/max/integer、min_choices/max_choices、min_length/max_length）
- **可配置跳转**：每道题可以配置多条跳转规则，六种 operator（equals / includes / gte / lte / eq / between），支持跳到指定题或直接结束
- **路径重放二次校验**：提交时在后端重放整个填写过程，精确区分"被跳转合法绕过"与"真漏答必答"，客户端不可信
- **零计数统计**：统计模块对题目所有保留选项（包括零次选择）都按 options 顺序返回 count:0
- **版本冲突检测**：乐观锁 `__v` 机制，填写期间问卷结构被修改会返回 409 要求刷新重填
- **发布前校验**：状态 draft→open 时完整校验跳转规则（引用存在性 + 只允许向前 + DFS 环检测）

## 🚀 本地运行

### 环境要求

- Node.js 18+
- MongoDB 5+（本地默认端口 27017）

### 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 复制环境变量并编辑（主要是 JWT_SECRET）
cp .env.example .env

# 3. 启动 MongoDB（如果没跑）
# Windows 服务：net start MongoDB
# 或 mongod --dbpath ./data

# 4. 启动开发服务器
npm run dev
# 生产环境
npm start
```

### 访问地址

| 路径 | 说明 |
|---|---|
| http://localhost:3000/ | 登录/注册页 |
| http://localhost:3000/surveys.html | 我的问卷列表 |
| http://localhost:3000/edit.html?surveyId=xxx | 问卷编辑器 |
| http://localhost:3000/fill.html?token=xxx | 填写页 |
| http://localhost:3000/stats.html?surveyId=xxx | 统计页 |
| http://localhost:3000/api/health | 后端健康检查 |

### 测试

全部 78 条接口测试为手工执行，记录见 `docs/测试用例.md`。

## 📁 目录结构

```
├── server.js                 # Express 入口
├── package.json
├── .env.example
├── config/
│   └── db.js                 # Mongoose 连接封装
├── middleware/
│   ├── auth.js               # JWT 强制鉴权（Bearer Token）
│   ├── optionalAuth.js       # 条件鉴权（Fill 模块用）
│   └── ownership.js          # 创建者身份校验
├── models/
│   ├── User.js               # 用户（bcrypt pre('save') + comparePassword）
│   ├── Survey.js             # 问卷 + questions[] 内嵌 + deleteOne 级联 Submission
│   └── Submission.js         # 提交记录，answers[] 含 question_type 冗余
├── routes/
│   ├── auth.js               # register / login / me
│   ├── surveys.js            # CRUD + Question + Stats（11 个端点）
│   └── fill.js               # by-token F1 / F2 / F3
├── utils/
│   ├── jumpResolver.js       # condition_matches（6 种 operator）+ resolve_next_question
│   └── questionValidator.js  # validateAnswer + 配置校验 + 发布校验
├── public/                   # 纯 HTML + 原生 JS 前端（Pico.css CDN）
│   ├── index.html/index.js   # 登录/注册
│   ├── surveys.html/js       # 问卷列表 + 创建
│   ├── edit.html/js          # 问卷编辑器（添加题目 + 配置跳转）
│   ├── fill.html/js          # 填写页（F1/F2/F3）
│   ├── stats.html/js         # 统计页（choice 横向条 / number avg / text 列表）
│   ├── api.js                # 统一 fetch 封装（自动带 JWT + 401 跳登录）
│   └── style.css             # 自定义样式（Pico.css 覆盖）
└── docs/                     # 四份设计与测试文档
    ├── 数据库设计.md
    ├── 关键逻辑说明.md
    ├── API说明.md
    ├── 测试用例.md
    └── AI使用日志.md
```

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js |
| 后端框架 | Express 4 |
| 数据库 | MongoDB（Mongoose ODM） |
| 密码哈希 | bcryptjs |
| 鉴权 | jsonwebtoken |
| 前端 | 原生 HTML + JS + fetch |
| CSS | Pico.css（CDN） |

## 📝 文档索引

- **数据库设计**：[docs/数据库设计.md](docs/数据库设计.md) — 为什么选 MongoDB、集合划分、Schema 字段表、设计权衡（题目嵌入 / answers 冗余 question_type / answer Mixed 四种形态）、索引、已知限制
- **关键逻辑**：[docs/关键逻辑说明.md](docs/关键逻辑说明.md) — 跳转六种 operator 语义、{matched, target} 设计选择、F3 重放路径二次校验（含完整例子）、空答案判定、创建者鉴权类型不对称问题、optionalAuth 三种状态
- **API 说明**：[docs/API说明.md](docs/API说明.md) — 16 端点、统一错误码、请求体/响应体示例
- **测试用例**：[docs/测试用例.md](docs/测试用例.md) — 78 条接口测试汇总表 + 端到端联调记录
- **AI 使用日志**：[docs/AI使用日志.md](docs/AI使用日志.md) — 各模块开发踩坑与 Read 验证策略

## 📄 License

MIT

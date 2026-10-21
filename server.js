require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');
const surveyRoutes = require('./routes/surveys');

// 提前注册 Submission model —— Survey.deleteOne 的 pre hook 要用到它
require('./models/Submission');

// ── 初始化 ──
const app = express();

// ── 中间件 ──
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── 健康检查（根路由）──
app.get('/', (req, res) => {
  res.json({
    service: 'survey-backend',
    phase: '4',
    module: 'auth-only',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// ── 路由注册 ──
app.use('/api/auth', authRoutes);
app.use('/api/surveys', surveyRoutes);

// ── 404 兜底 ──
app.use((req, res) => {
  res.status(404).json({
    code: 'NOT_FOUND',
    message: `路由 ${req.method} ${req.originalUrl} 不存在`,
  });
});

// ── 全局错误处理（兜底）──
app.use((err, req, res, next) => {
  console.error('[global-error]', err);
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? '服务器内部错误' : err.message,
  });
});

// ── 启动 ──
const PORT = process.env.PORT || 3000;

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
    console.log(`   Auth:  POST /api/auth/register | POST /api/auth/login | GET /api/auth/me`);
    console.log(`   Survey CRUD:`);
    console.log(`     POST   /api/surveys                    (create)`);
    console.log(`     GET    /api/surveys                    (list)`);
    console.log(`     GET    /api/surveys/:id                (detail)`);
    console.log(`     PATCH  /api/surveys/:id                (update meta)`);
    console.log(`     PATCH  /api/surveys/:id/status         (change status)`);
    console.log(`     DELETE /api/surveys/:id                (delete + cascade submissions)`);
  });
}

start().catch((err) => {
  console.error('[startup-failed]', err);
  process.exit(1);
});

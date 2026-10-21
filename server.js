require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/auth');

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
    console.log(`   Auth endpoints:`);
    console.log(`   POST /api/auth/register`);
    console.log(`   POST /api/auth/login`);
    console.log(`   GET  /api/auth/me  (requires JWT)`);
  });
}

start().catch((err) => {
  console.error('[startup-failed]', err);
  process.exit(1);
});

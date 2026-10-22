/**
 * API 集成测试（Jest + Supertest）
 *
 * 运行前提：本地 MongoDB 已启动（默认 27017 端口）。
 * 测试使用独立数据库 survey_system_test，绝不污染业务库 survey_system。
 *
 * 执行：npm test
 */
const mongoose = require('mongoose');
const request = require('supertest');

// ── 在 require server 之前设置测试环境变量 ──
// dotenv.config() 不会覆盖已存在的 process.env，因此这里的设置会生效
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_jest_only';
process.env.MONGODB_URI = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/\s?]+(\?.*)?$/, '/survey_system_test')
  : 'mongodb://localhost:27017/survey_system_test';

// server.js 内的 dotenv.config() 不会覆盖上面已设置的变量
const app = require('../server');

// 集成测试涉及 DB 连接与多次请求，放宽默认 5s 超时
jest.setTimeout(30000);

describe('API 集成测试', () => {
  // ── 连接测试数据库并清空 ──
  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    // 清空测试库，确保每次运行从干净状态开始
    await mongoose.connection.dropDatabase();
  });

  // ── 测试结束后断开连接 ──
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  // ============================================================
  // 测试 1：注册并登录，断言成功获取 token
  // ============================================================
  test('1. 注册并登录，成功获取 token', async () => {
    const username = `testuser_${Date.now()}`;
    const password = 'testpass123';

    // 注册
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ username, password });

    expect(regRes.status).toBe(201);
    expect(regRes.body._id).toBeDefined();
    expect(regRes.body.username).toBe(username);
    expect(regRes.body.password).toBeUndefined(); // 密码不应返回

    // 登录
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username, password });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    expect(typeof loginRes.body.token).toBe('string');
    expect(loginRes.body.token.length).toBeGreaterThan(0);
    expect(loginRes.body.user.username).toBe(username);
  });

  // ============================================================
  // 测试 2：创建问卷并添加题目，断言 order 正确
  // ============================================================
  test('2. 创建问卷并添加题目，order 自增正确', async () => {
    // 注册 + 登录
    const username = `testuser2_${Date.now()}`;
    await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
    const token = loginRes.body.token;

    // 创建问卷
    const createRes = await request(app)
      .post('/api/surveys')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '测试问卷2', allow_anonymous: true });

    expect(createRes.status).toBe(201);
    const surveyId = createRes.body._id;

    // 添加第一题
    const q1Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'single_choice',
        title: '第一题',
        required: true,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      });

    expect(q1Res.status).toBe(201);
    expect(q1Res.body.questions[0].order).toBe(0);

    // 添加第二题
    const q2Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'text',
        title: '第二题',
        required: false,
      });

    expect(q2Res.status).toBe(201);
    expect(q2Res.body.questions[1].order).toBe(1);
  });

  // ============================================================
  // 测试 3：F3 重放校验 —— 被跳转规则合法绕过的必答题不报错，返回 201
  // ============================================================
  test('3. F3 重放：选 A 跳到结束，必答题 Q2 被合法绕过，返回 201', async () => {
    // 注册 + 登录
    const username = `testuser3_${Date.now()}`;
    await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
    const token = loginRes.body.token;

    // 创建允许匿名的问卷
    const createRes = await request(app)
      .post('/api/surveys')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '跳转测试问卷', allow_anonymous: true });

    expect(createRes.status).toBe(201);
    const surveyId = createRes.body._id;

    // Q1：单选必答，选项 A/B
    const q1Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'single_choice',
        title: '第一题（选 A 直接结束）',
        required: true,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      });
    const q1Id = q1Res.body.questions[0]._id;

    // Q2：文本题，必答（选 A 时会被跳转规则合法绕过）
    const q2Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'text',
        title: '第二题（必答，选 A 时跳过）',
        required: true,
      });
    expect(q2Res.status).toBe(201);

    // 配置 Q1 的跳转规则：answer === 'a' → 跳到结束
    const jumpRes = await request(app)
      .patch(`/api/surveys/${surveyId}/questions/${q1Id}/jump_rules`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        jump_rules: [
          { condition: { operator: 'equals', value: 'a' }, targetQuestionId: null },
        ],
      });
    expect(jumpRes.status).toBe(200);

    // 发布问卷（status → open，触发发布前校验）
    const publishRes = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'open' });
    expect(publishRes.status).toBe(200);

    // 通过详情接口获取 url_token 和当前 __v（乐观锁版本）
    const detailRes = await request(app)
      .get(`/api/surveys/${surveyId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detailRes.status).toBe(200);
    const urlToken = detailRes.body.url_token;
    const version = detailRes.body.__v;

    // F3 提交：只答 Q1 选 'a'，Q2（必答）被跳转规则合法绕过
    const submitRes = await request(app)
      .post(`/api/surveys/by-token/${urlToken}/submissions`)
      .send({
        answers: [{ question_id: q1Id, answer: 'a' }],
        expected_version: version,
      });

    expect(submitRes.status).toBe(201);
    expect(submitRes.body.submission_id).toBeDefined();
    // 只答了 1 题，跳过了 1 题（Q2）
    expect(submitRes.body.answered_count).toBe(1);
    expect(submitRes.body.skipped_count).toBe(1);
  });
});

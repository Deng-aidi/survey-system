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
  // 跨用例共享的数据句柄：由 test3 / test6 写入，后续用例只读
  // （不改变 test1–test3 的任何逻辑与断言）
  let sharedSurveyId;
  let sharedUrlToken;
  let sharedQ1Id;
  let statsSurveyId;
  let statsQ1Id;
  let statsToken;

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

    // 供 test4 复用本用例已发布的问卷（仅记录句柄，不改动任何断言）
    sharedSurveyId = surveyId;
    sharedUrlToken = urlToken;
    sharedQ1Id = q1Id;

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

  // ============================================================
  // 测试 4：F3 校验失败 —— Q1 选 B 进入必答 Q2 但未作答，返回 400
  // 复用 test3 已发布的问卷（Q1 选 a 才跳结束，选 b 会进入 Q2）
  // ============================================================
  test('4. F3 校验失败：路径内必答 Q2 未作答，返回 400 FINAL_VALIDATION_FAILED', async () => {
    expect(sharedUrlToken).toBeDefined();
    expect(sharedQ1Id).toBeDefined();

    const submitRes = await request(app)
      .post(`/api/surveys/by-token/${sharedUrlToken}/submissions`)
      .send({
        // Q1 选 'b'：不命中跳转规则，按 order 进入 Q2
        answers: [{ question_id: sharedQ1Id, answer: 'b' }],
      });

    expect(submitRes.status).toBe(400);
    expect(submitRes.body.code).toBe('FINAL_VALIDATION_FAILED');
    expect(Array.isArray(submitRes.body.errors)).toBe(true);
    expect(submitRes.body.errors.length).toBeGreaterThan(0);

    // 错误原因中应包含必答未作答提示
    const reasons = submitRes.body.errors.map((e) => e.reason).join('; ');
    expect(reasons).toContain('必答');
  });

  // ============================================================
  // 测试 5：F2 单题校验 —— 数字题超范围 valid=false，合法值 valid=true
  // 注意：F2 无状态，业务态校验失败仍返回 200 + valid:false（与 F3 的 400 不同）
  // ============================================================
  test('5. F2 单题校验：数字题超范围 valid=false，合法值 valid=true', async () => {
    const username = `testuser5_${Date.now()}`;
    await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
    const token = loginRes.body.token;

    // 独立问卷：一道数字题（1 ≤ x ≤ 10 且必须是整数）
    const createRes = await request(app)
      .post('/api/surveys')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'F2 单题校验问卷', allow_anonymous: true });
    expect(createRes.status).toBe(201);
    const surveyId = createRes.body._id;

    const qRes = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'number',
        title: '请输入 1~10 的整数',
        required: true,
        validation: { min: 1, max: 10, integer: true },
      });
    expect(qRes.status).toBe(201);
    const numberQId = qRes.body.questions[0]._id;

    const publishRes = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'open' });
    expect(publishRes.status).toBe(200);

    const detailRes = await request(app)
      .get(`/api/surveys/${surveyId}`)
      .set('Authorization', `Bearer ${token}`);
    const urlToken = detailRes.body.url_token;

    // 非法值 99（超过 max=10）
    const badRes = await request(app)
      .post(`/api/surveys/by-token/${urlToken}/answers/validate`)
      .send({ question_id: numberQId, answer: 99 });

    expect(badRes.status).toBe(200);
    expect(badRes.body.valid).toBe(false);
    expect(badRes.body.errors[0].reason).toContain('答案不能大于 10');

    // 合法值 5
    const goodRes = await request(app)
      .post(`/api/surveys/by-token/${urlToken}/answers/validate`)
      .send({ question_id: numberQId, answer: 5 });

    expect(goodRes.status).toBe(200);
    expect(goodRes.body.valid).toBe(true);
    // 只有一道题，答完即结束
    expect(goodRes.body.next_question_id).toBeNull();
  });

  // ============================================================
  // 测试 6：T1 整卷统计 —— 总数、零计数选项、数字 avg/min/max、文本 all_values
  // ============================================================
  test('6. T1 整卷统计：零计数选项保留、数字 avg/min/max、文本 all_values', async () => {
    const username = `testuser6_${Date.now()}`;
    await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
    const loginRes = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
    const token = loginRes.body.token;

    // 建一份含单选 + 数字 + 文本的问卷
    const createRes = await request(app)
      .post('/api/surveys')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '单卷统计问卷', allow_anonymous: true });
    expect(createRes.status).toBe(201);
    const surveyId = createRes.body._id;

    // Q1：单选（A/B），只提交 A，B 应保留 count:0
    const q1Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'single_choice',
        title: '单选题',
        required: true,
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      });
    expect(q1Res.status).toBe(201);
    const q1Id = q1Res.body.questions[0]._id;

    // Q2：数字题
    const q2Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'number',
        title: '数字题',
        required: true,
        validation: { min: 1, max: 10, integer: true },
      });
    expect(q2Res.status).toBe(201);
    const q2Id = q2Res.body.questions[1]._id;

    // Q3：文本题
    const q3Res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'text', title: '文本题', required: true });
    expect(q3Res.status).toBe(201);
    const q3Id = q3Res.body.questions[2]._id;

    // 发布
    const publishRes = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'open' });
    expect(publishRes.status).toBe(200);

    const detailRes = await request(app)
      .get(`/api/surveys/${surveyId}`)
      .set('Authorization', `Bearer ${token}`);
    const urlToken = detailRes.body.url_token;
    const version = detailRes.body.__v;

    // 提交 1 份答卷（无跳转规则，三题全部作答）
    const submitRes = await request(app)
      .post(`/api/surveys/by-token/${urlToken}/submissions`)
      .send({
        answers: [
          { question_id: q1Id, answer: 'a' },
          { question_id: q2Id, answer: 5 },
          { question_id: q3Id, answer: 'hello' },
        ],
        expected_version: version,
      });
    expect(submitRes.status).toBe(201);

    // T1 整卷统计
    const statsRes = await request(app)
      .get(`/api/surveys/${surveyId}/stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(statsRes.status).toBe(200);
    expect(statsRes.body.total_submissions).toBe(1);
    expect(statsRes.body.questions).toHaveLength(3);

    // ① 单选题：选项按 options 顺序返回，未选中的 B 保留 count:0
    const q1Stats = statsRes.body.questions.find((q) => String(q.question_id) === q1Id);
    expect(q1Stats).toBeDefined();
    expect(q1Stats.option_counts).toHaveLength(2);
    expect(q1Stats.option_counts[0]).toMatchObject({ option_value: 'a', count: 1 });
    expect(q1Stats.option_counts[1]).toMatchObject({ option_value: 'b', count: 0 });
    expect(q1Stats.answer_count).toBe(1);

    // ② 数字题：avg/min/max + all_values
    const q2Stats = statsRes.body.questions.find((q) => String(q.question_id) === q2Id);
    expect(q2Stats).toBeDefined();
    expect(q2Stats.stats).toEqual({ avg: 5, min: 5, max: 5 });
    expect(q2Stats.all_values).toEqual([5]);

    // ③ 文本题：all_values 列表
    const q3Stats = statsRes.body.questions.find((q) => String(q.question_id) === q3Id);
    expect(q3Stats).toBeDefined();
    expect(q3Stats.all_values).toEqual(['hello']);

    // 供 test7 复用（含创建者 token，stats 接口要求创建者身份）
    statsSurveyId = surveyId;
    statsQ1Id = q1Id;
    statsToken = token;
  });

  // ============================================================
  // 测试 7：T2 单题统计 —— 结构与 T1 的 questions[i] 一致，answer_count 正确
  // ============================================================
  test('7. T2 单题统计：结构与 T1 单题一致，answer_count 正确', async () => {
    expect(statsSurveyId).toBeDefined();
    expect(statsQ1Id).toBeDefined();

    // 复用 test6 的问卷与创建者 token
    const t1Res = await request(app)
      .get(`/api/surveys/${statsSurveyId}/stats`)
      .set('Authorization', `Bearer ${statsToken}`);
    expect(t1Res.status).toBe(200);

    const t2Res = await request(app)
      .get(`/api/surveys/${statsSurveyId}/stats/${statsQ1Id}`)
      .set('Authorization', `Bearer ${statsToken}`);

    expect(t2Res.status).toBe(200);
    expect(String(t2Res.body.question_id)).toBe(statsQ1Id);

    const fromT1 = t1Res.body.questions.find((q) => String(q.question_id) === statsQ1Id);
    expect(fromT1).toBeDefined();
    // T2 响应结构与 T1 的 questions[i] 完全一致
    expect(t2Res.body).toEqual(fromT1);
    expect(t2Res.body.answer_count).toBe(1);
  });
});

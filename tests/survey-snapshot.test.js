/**
 * M2 问卷快照与发布结构锁定 集成测试
 *
 * 覆盖：
 *   1. 从题库加题生成快照（source_question_id / source_version / 本地新 _id）
 *   2. 发布写入 published_at
 *   3. 发布后普通加题 → 409
 *   4. 发布后从题库加题 → 409
 *   5. 发布后改跳转规则 → 409
 *   6. 旧式问卷（无 source 字段）draft 状态加题仍正常
 */
const mongoose = require('mongoose');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_for_jest_only';
process.env.MONGODB_URI = process.env.MONGODB_URI
  ? process.env.MONGODB_URI.replace(/\/[^/\s?]+(\?.*)?$/, '/survey_system_test')
  : 'mongodb://localhost:27017/survey_system_test';

const app = require('../server');
const Question = require('../models/Question');

jest.setTimeout(30000);

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('M2 问卷快照与结构锁定', () => {
  let token;
  let libQuestionId;
  let surveyId;
  let snapshotQuestionId;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.dropDatabase();
    await Question.syncIndexes();

    const username = `m2_owner_${Date.now()}`;
    await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
    const login = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
    token = login.body.token;
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('1. 从题库加题生成快照：source 字段正确且本地 _id 不同', async () => {
    // 先建一道题库题
    const libRes = await request(app)
      .post('/api/questions')
      .set(auth(token))
      .send({
        type: 'single_choice',
        title: '你常用的开发语言',
        options: [
          { label: 'JavaScript', value: 'js' },
          { label: 'Python', value: 'py' },
        ],
      });
    expect(libRes.status).toBe(201);
    libQuestionId = libRes.body._id;

    // 建 draft 问卷
    const surveyRes = await request(app)
      .post('/api/surveys')
      .set(auth(token))
      .send({ title: 'M2 快照测试问卷', allow_anonymous: true });
    expect(surveyRes.status).toBe(201);
    surveyId = surveyRes.body._id;

    // 从题库加入
    const res = await request(app)
      .post(`/api/surveys/${surveyId}/questions/from-library`)
      .set(auth(token))
      .send({ question_id: libQuestionId, required: true });

    expect(res.status).toBe(201);
    const q = res.body.questions[0];
    expect(q.source_question_id).toBe(libQuestionId);
    expect(q.source_version).toBe(1);
    expect(q.snapshot_at).toBeTruthy();
    expect(q._id).not.toBe(libQuestionId);
    expect(q.required).toBe(true);
    expect(q.order).toBe(0);
    expect(q.jump_rules).toEqual([]);
    // value 原样保留
    expect(q.options.map((o) => o.value)).toEqual(['js', 'py']);
    // 选项 _id 重新生成，不等于题库题的选项 _id
    expect(q.options[0]._id).not.toBe(libRes.body.options[0]._id);

    snapshotQuestionId = q._id;
  });

  test('2. 发布问卷：published_at 被写入', async () => {
    const res = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set(auth(token))
      .send({ status: 'open' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('open');
    expect(res.body.published_at).toBeTruthy();
  });

  test('3. 发布后普通加题返回 409 SURVEY_STRUCTURE_LOCKED', async () => {
    const res = await request(app)
      .post(`/api/surveys/${surveyId}/questions`)
      .set(auth(token))
      .send({ type: 'text', title: '发布后新增的题' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SURVEY_STRUCTURE_LOCKED');
  });

  test('4. 发布后从题库加题返回 409', async () => {
    const res = await request(app)
      .post(`/api/surveys/${surveyId}/questions/from-library`)
      .set(auth(token))
      .send({ question_id: libQuestionId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SURVEY_STRUCTURE_LOCKED');
  });

  test('5. 发布后修改跳转规则返回 409', async () => {
    const res = await request(app)
      .patch(`/api/surveys/${surveyId}/questions/${snapshotQuestionId}/jump_rules`)
      .set(auth(token))
      .send({ jump_rules: [] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SURVEY_STRUCTURE_LOCKED');
  });

  test('6. 兼容性：旧式问卷（无 source 字段）draft 状态加题仍返回 201', async () => {
    const surveyRes = await request(app)
      .post('/api/surveys')
      .set(auth(token))
      .send({ title: '旧式问卷兼容测试', allow_anonymous: true });
    expect(surveyRes.status).toBe(201);

    const res = await request(app)
      .post(`/api/surveys/${surveyRes.body._id}/questions`)
      .set(auth(token))
      .send({ type: 'text', title: '旧式题目', required: true });

    expect(res.status).toBe(201);
    const q = res.body.questions[0];
    expect(q._id).toBeTruthy();
    expect(q.source_question_id).toBeNull();
    expect(q.source_version).toBeNull();
    expect(q.snapshot_at).toBeNull();
    expect(q.title).toBe('旧式题目');
  });
});

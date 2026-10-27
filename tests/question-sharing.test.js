/**
 * M3 题目共享与引用追踪 集成测试
 *
 * 覆盖：
 *   1. 创建者更新 is_shared → 200 且数据库落库
 *   2. 创建者更新 shared_with（定向共享）→ 200
 *   3. 非创建者修改共享设置 → 403
 *   4. GET /api/questions/shared 能看到公开题与定向共享题
 *   5. GET /api/questions/:id/usages 返回引用该题的问卷
 *   6. 非创建者查看 usages → 403
 *
 * 运行：npm test（独立数据库 survey_system_test）
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

async function registerAndLogin(username) {
  await request(app).post('/api/auth/register').send({ username, password: 'testpass123' });
  const res = await request(app).post('/api/auth/login').send({ username, password: 'testpass123' });
  return { token: res.body.token, id: res.body.user._id };
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

describe('M3 题目共享与引用追踪', () => {
  let user1;
  let user2;
  let publicQuestionId;
  let targetedQuestionId;
  let privateQuestionId;
  let surveyId;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.dropDatabase();
    await Question.syncIndexes();

    user1 = await registerAndLogin(`share_owner_${Date.now()}`);
    user2 = await registerAndLogin(`share_other_${Date.now()}`);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  async function createQuestion(title) {
    const res = await request(app)
      .post('/api/questions')
      .set(auth(user1.token))
      .send({
        type: 'single_choice',
        title,
        options: [
          { label: '选项 A', value: 'a' },
          { label: '选项 B', value: 'b' },
        ],
      });
    expect(res.status).toBe(201);
    return res.body._id;
  }

  test('1. 创建者设置 is_shared = true，返回 200 且数据库已更新', async () => {
    publicQuestionId = await createQuestion('公开共享题');
    privateQuestionId = await createQuestion('未共享题');

    const res = await request(app)
      .patch(`/api/questions/${publicQuestionId}/sharing`)
      .set(auth(user1.token))
      .send({ is_shared: true });

    expect(res.status).toBe(200);
    expect(res.body.is_shared).toBe(true);

    const db = await Question.findById(publicQuestionId);
    expect(db.is_shared).toBe(true);
  });

  test('2. 创建者设置 shared_with = [user2]，返回 200', async () => {
    targetedQuestionId = await createQuestion('定向共享题');

    const res = await request(app)
      .patch(`/api/questions/${targetedQuestionId}/sharing`)
      .set(auth(user1.token))
      .send({ shared_with: [user2.id, user2.id] });   // 重复 id 应被去重

    expect(res.status).toBe(200);
    expect(res.body.is_shared).toBe(false);
    expect(res.body.shared_with).toEqual([user2.id]);

    const db = await Question.findById(targetedQuestionId);
    expect(db.shared_with.map((id) => id.toString())).toEqual([user2.id]);
  });

  test('3. 非创建者修改共享设置返回 403 FORBIDDEN', async () => {
    const res = await request(app)
      .patch(`/api/questions/${publicQuestionId}/sharing`)
      .set(auth(user2.token))
      .send({ is_shared: false });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('4. 他人能获取公开题与定向共享题，且看不到未共享题', async () => {
    const res = await request(app)
      .get('/api/questions/shared')
      .set(auth(user2.token));

    expect(res.status).toBe(200);
    const ids = res.body.map((q) => q._id);
    expect(ids).toContain(publicQuestionId);
    expect(ids).toContain(targetedQuestionId);
    expect(ids).not.toContain(privateQuestionId);
    // 关键字段齐全
    const first = res.body.find((q) => q._id === publicQuestionId);
    expect(first.creator_id).toBe(user1.id);
    expect(first.type).toBe('single_choice');
    expect(first.title).toBe('公开共享题');
  });

  test('5. usages 返回引用该题的问卷及快照版本', async () => {
    const surveyRes = await request(app)
      .post('/api/surveys')
      .set(auth(user1.token))
      .send({ title: '引用追踪测试问卷', allow_anonymous: true });
    expect(surveyRes.status).toBe(201);
    surveyId = surveyRes.body._id;

    const addRes = await request(app)
      .post(`/api/surveys/${surveyId}/questions/from-library`)
      .set(auth(user1.token))
      .send({ question_id: targetedQuestionId });
    expect(addRes.status).toBe(201);
    const localQuestionId = addRes.body.questions[0]._id;

    const res = await request(app)
      .get(`/api/questions/${targetedQuestionId}/usages`)
      .set(auth(user1.token));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].survey_id).toBe(surveyId);
    expect(res.body[0].title).toBe('引用追踪测试问卷');
    expect(res.body[0].status).toBe('draft');
    expect(res.body[0].source_version).toBe(1);
    expect(res.body[0].local_question_id).toBe(localQuestionId);
  });

  test('6. 非创建者调用 usages 返回 403', async () => {
    const res = await request(app)
      .get(`/api/questions/${targetedQuestionId}/usages`)
      .set(auth(user2.token));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});

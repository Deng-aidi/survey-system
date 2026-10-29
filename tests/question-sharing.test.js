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
 *   7. GET /api/questions/shared 不包含自己创建的题目（M7）
 *   8. 同一问卷多次引用同一题时 usages 返回多条（M7）
 *   9. 新版本继承源题目的共享状态（M7）
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
const Survey = require('../models/Survey');

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

  test('7. 共享列表不再包含自己创建的题目', async () => {
    const res = await request(app)
      .get('/api/questions/shared')
      .set(auth(user1.token));

    expect(res.status).toBe(200);
    const ids = res.body.map((q) => q._id);
    expect(ids).not.toContain(publicQuestionId);
    expect(ids).not.toContain(targetedQuestionId);
    expect(ids).not.toContain(privateQuestionId);
    expect(res.body).toEqual([]);
  });

  test('8. 同卷重复加入同版本被拦截；历史重复快照 usages 仍返回多条', async () => {
    const surveyRes = await request(app)
      .post('/api/surveys')
      .set(auth(user1.token))
      .send({ title: '重复引用测试问卷', allow_anonymous: true });
    expect(surveyRes.status).toBe(201);
    const duplicateSurveyId = surveyRes.body._id;

    const add1 = await request(app)
      .post(`/api/surveys/${duplicateSurveyId}/questions/from-library`)
      .set(auth(user1.token))
      .send({ question_id: targetedQuestionId });
    expect(add1.status).toBe(201);
    const local1 = add1.body.questions[add1.body.questions.length - 1]._id;

    // 规则上线后，同一版本再次加入会被 400 拦截
    const add2 = await request(app)
      .post(`/api/surveys/${duplicateSurveyId}/questions/from-library`)
      .set(auth(user1.token))
      .send({ question_id: targetedQuestionId });
    expect(add2.status).toBe(400);
    expect(add2.body.code).toBe('DUPLICATE_QUESTION');

    // 历史数据可能已存在同卷多份同源快照：直接写入一份，验证 usages 仍能全部返回
    const snapshot = add1.body.questions[0];
    const surveyDoc = await Survey.findById(duplicateSurveyId);
    surveyDoc.questions.push({
      type: snapshot.type,
      title: '旧快照副本',
      order: 1,
      required: false,
      options: [],
      validation: {},
      jump_rules: [],
      source_question_id: snapshot.source_question_id,
      source_version: snapshot.source_version,
      snapshot_at: new Date(),
    });
    await surveyDoc.save();
    const local2 = String(surveyDoc.questions[surveyDoc.questions.length - 1]._id);

    const res = await request(app)
      .get(`/api/questions/${targetedQuestionId}/usages`)
      .set(auth(user1.token));

    expect(res.status).toBe(200);
    const hits = res.body.filter((u) => u.survey_id === duplicateSurveyId);
    expect(hits).toHaveLength(2);
    expect(hits.map((u) => u.local_question_id).sort()).toEqual([local1, local2].sort());
  });

  test('9. 新版本继承源题目的共享状态', async () => {
    const res = await request(app)
      .post(`/api/questions/${targetedQuestionId}/versions`)
      .set(auth(user1.token))
      .send({ title: '定向共享题 v2' });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    expect(res.body.is_shared).toBe(false);
    expect(res.body.shared_with.map(String)).toEqual([user2.id]);

    const db = await Question.findById(res.body._id);
    expect(db.is_shared).toBe(false);
    expect(db.shared_with.map(String)).toEqual([user2.id]);
  });
});

/**
 * M4 跨问卷统计 集成测试
 *
 * 覆盖：
 *   1. 单问卷单版本：选项分布与 answer_count
 *   2. 跨问卷单版本：surveys 多条 + 汇总
 *   3. 数字题：avg/min/max
 *   4. includeVersions：默认只统计当前版本，整链统计给出 by_version
 *   5. 非创建者访问 → 403
 *   6. 无引用题目：返回 answer_count 0 的稳定结构
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

describe('M4 跨问卷统计', () => {
  let owner;
  let other;
  let choiceQuestionId;
  let numberQuestionId;
  let survey1;
  let survey2;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.dropDatabase();
    await Question.syncIndexes();

    owner = await registerAndLogin(`stats_owner_${Date.now()}`);
    other = await registerAndLogin(`stats_other_${Date.now()}`);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  // ── 辅助：建题 / 建卷 / 加题 / 发布 / 提交 ──
  async function createQuestion(payload) {
    const res = await request(app)
      .post('/api/questions')
      .set(auth(owner.token))
      .send(payload);
    expect(res.status).toBe(201);
    return res.body;
  }

  async function createSurvey(title) {
    const res = await request(app)
      .post('/api/surveys')
      .set(auth(owner.token))
      .send({ title, allow_anonymous: true });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function addFromLibrary(surveyId, questionId) {
    const res = await request(app)
      .post(`/api/surveys/${surveyId}/questions/from-library`)
      .set(auth(owner.token))
      .send({ question_id: questionId, required: true });
    expect(res.status).toBe(201);
    return res.body.questions[res.body.questions.length - 1];
  }

  async function publish(surveyId) {
    const res = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set(auth(owner.token))
      .send({ status: 'open' });
    expect(res.status).toBe(200);
  }

  async function submit(token, answers) {
    const res = await request(app)
      .post(`/api/surveys/by-token/${token}/submissions`)
      .send({ answers });
    expect(res.status).toBe(201);
  }

  test('1. 单问卷单版本：答案分布与作答数正确', async () => {
    const q = await createQuestion({
      type: 'single_choice',
      title: '你更喜欢哪种语言',
      options: [
        { label: 'JavaScript', value: 'js' },
        { label: 'Python', value: 'py' },
      ],
    });
    choiceQuestionId = q._id;

    survey1 = await createSurvey('统计问卷一');
    const local = await addFromLibrary(survey1._id, choiceQuestionId);
    await publish(survey1._id);

    await submit(survey1.url_token, [{ question_id: local._id, answer: 'js' }]);
    await submit(survey1.url_token, [{ question_id: local._id, answer: 'py' }]);

    const res = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.included_versions).toEqual([1]);
    expect(res.body.surveys).toHaveLength(1);
    expect(res.body.surveys[0].survey_id).toBe(survey1._id);
    expect(res.body.surveys[0].answer_count).toBe(2);
    expect(res.body.aggregate.answer_count).toBe(2);

    const counts = Object.fromEntries(
      res.body.aggregate.option_counts.map((o) => [o.option_value, o.count])
    );
    expect(counts).toEqual({ js: 1, py: 1 });
  });

  test('2. 跨问卷单版本：两份问卷汇总', async () => {
    survey2 = await createSurvey('统计问卷二');
    const local = await addFromLibrary(survey2._id, choiceQuestionId);
    await publish(survey2._id);

    await submit(survey2.url_token, [{ question_id: local._id, answer: 'js' }]);

    const res = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.surveys).toHaveLength(2);
    const bySurvey = Object.fromEntries(
      res.body.surveys.map((s) => [s.survey_id, s.answer_count])
    );
    expect(bySurvey[survey1._id]).toBe(2);
    expect(bySurvey[survey2._id]).toBe(1);

    expect(res.body.aggregate.answer_count).toBe(3);
    const counts = Object.fromEntries(
      res.body.aggregate.option_counts.map((o) => [o.option_value, o.count])
    );
    expect(counts).toEqual({ js: 2, py: 1 });
  });

  test('3. 数字题跨问卷统计：avg / min / max 正确', async () => {
    const q = await createQuestion({
      type: 'number',
      title: '你的年龄',
      validation: { min: 0, max: 120 },
    });
    numberQuestionId = q._id;

    const survey = await createSurvey('数字题问卷');
    const local = await addFromLibrary(survey._id, numberQuestionId);
    await publish(survey._id);

    await submit(survey.url_token, [{ question_id: local._id, answer: 10 }]);
    await submit(survey.url_token, [{ question_id: local._id, answer: 30 }]);

    const res = await request(app)
      .get(`/api/questions/${numberQuestionId}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.aggregate.answer_count).toBe(2);
    expect(res.body.aggregate.stats).toEqual({ avg: 20, min: 10, max: 30 });
    expect([...res.body.aggregate.all_values].sort((a, b) => a - b)).toEqual([10, 30]);
  });

  test('4. includeVersions：默认只统计当前版本，整链统计返回 by_version', async () => {
    // 为 choice 题生成 v2
    const v2Res = await request(app)
      .post(`/api/questions/${choiceQuestionId}/versions`)
      .set(auth(owner.token))
      .send({ title: '你更喜欢哪种语言（2026）' });
    expect(v2Res.status).toBe(201);
    const v2Id = v2Res.body._id;
    expect(v2Res.body.version).toBe(2);

    // 新问卷引用 v2 并提交一份
    const survey3 = await createSurvey('统计问卷三（v2）');
    const local = await addFromLibrary(survey3._id, v2Id);
    await publish(survey3._id);
    await submit(survey3.url_token, [{ question_id: local._id, answer: 'py' }]);

    // 默认：只统计 v1 的快照
    const single = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats`)
      .set(auth(owner.token));
    expect(single.status).toBe(200);
    expect(single.body.included_versions).toEqual([1]);
    expect(single.body.surveys).toHaveLength(2);
    expect(single.body.aggregate.answer_count).toBe(3);

    // includeVersions：整链统计 + by_version
    const all = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats?includeVersions=true`)
      .set(auth(owner.token));
    expect(all.status).toBe(200);
    expect(all.body.included_versions).toEqual([1, 2]);
    expect(all.body.surveys).toHaveLength(3);
    expect(all.body.aggregate.by_version).toHaveLength(2);

    const v1Group = all.body.aggregate.by_version.find((g) => g.version === 1);
    const v2Group = all.body.aggregate.by_version.find((g) => g.version === 2);
    expect(v1Group.aggregate.answer_count).toBe(3);
    expect(v2Group.aggregate.answer_count).toBe(1);
    expect(v2Group.aggregate.option_counts).toEqual([
      { option_value: 'js', option_label: 'JavaScript', count: 0 },
      { option_value: 'py', option_label: 'Python', count: 1 },
    ]);
  });

  test('5. 非创建者访问统计返回 403', async () => {
    const res = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats`)
      .set(auth(other.token));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('6. 无引用题目：返回 answer_count 0 的稳定结构', async () => {
    const q = await createQuestion({ type: 'text', title: '无人引用的题' });

    const res = await request(app)
      .get(`/api/questions/${q._id}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.surveys).toEqual([]);
    expect(res.body.included_versions).toEqual([1]);
    expect(res.body.aggregate.answer_count).toBe(0);
    expect(res.body.aggregate.all_values).toEqual([]);
  });
});

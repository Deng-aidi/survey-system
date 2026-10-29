/**
 * M4 跨问卷统计 集成测试
 *
 * 覆盖：
 *   1. 单问卷单版本：选项分布与 answer_count
 *   2. 跨问卷单版本：surveys 多条 + 汇总
 *   3. 数字题：avg/min/max
 *   4. includeVersions：默认只统计当前版本；同 schema 归为同一组
 *   5. 非创建者访问 → 403
 *   6. 无引用题目：返回 answer_count 0 的稳定结构
 *   7. 分叉：草稿改选项文案后按 schema_hash 分组
 *   8. 权限穿透：他人非匿名问卷被剔除并计数
 *   9. 他人匿名问卷同样被剔除并计数（M7：取消匿名豁免）
 *  10. 同一问卷重复引用同一题：stats 按问卷去重不翻倍（M7）
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
const { computeSchemaHash } = require('../utils/schemaHash');

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

  async function createSurvey(title, allowAnonymous, who) {
    allowAnonymous = allowAnonymous !== false;
    who = who || owner;
    const res = await request(app)
      .post('/api/surveys')
      .set(auth(who.token))
      .send({ title, allow_anonymous: allowAnonymous });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function addFromLibrary(surveyId, questionId, who) {
    who = who || owner;
    const res = await request(app)
      .post(`/api/surveys/${surveyId}/questions/from-library`)
      .set(auth(who.token))
      .send({ question_id: questionId, required: true });
    expect(res.status).toBe(201);
    return res.body.questions[res.body.questions.length - 1];
  }

  async function publish(surveyId, who) {
    who = who || owner;
    const res = await request(app)
      .patch(`/api/surveys/${surveyId}/status`)
      .set(auth(who.token))
      .send({ status: 'open' });
    expect(res.status).toBe(200);
  }

  async function submit(token, answers, who) {
    let req = request(app).post(`/api/surveys/by-token/${token}/submissions`);
    if (who) req = req.set(auth(who.token));
    const res = await req.send({ answers });
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

  test('4. includeVersions：默认只统计当前版本；同 schema 归为同一组', async () => {
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
    expect(single.body.aggregate.by_schema_group).toHaveLength(1);

    // includeVersions：整链统计。v2 只改了标题，schema_hash 不变 → 仍属同一组
    const all = await request(app)
      .get(`/api/questions/${choiceQuestionId}/stats?includeVersions=true`)
      .set(auth(owner.token));
    expect(all.status).toBe(200);
    expect(all.body.included_versions).toEqual([1, 2]);
    expect(all.body.surveys).toHaveLength(3);
    expect(all.body.aggregate.by_schema_group).toHaveLength(1);

    const group = all.body.aggregate.by_schema_group[0];
    expect(group.representative_version).toBe(1);
    expect(group.aggregate.answer_count).toBe(4);
    expect(group.aggregate.option_counts).toEqual([
      { option_value: 'js', option_label: 'JavaScript', count: 2 },
      { option_value: 'py', option_label: 'Python', count: 2 },
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

  test('7. 分叉：草稿改选项文案后按 schema_hash 分成两组', async () => {
    const q = await createQuestion({
      type: 'single_choice',
      title: '分叉测试题',
      options: [
        { label: '选项A', value: 'a' },
        { label: '选项B', value: 'b' },
      ],
    });

    // A 公开共享，B 才能引用
    const share = await request(app)
      .patch(`/api/questions/${q._id}/sharing`)
      .set(auth(owner.token))
      .send({ is_shared: true });
    expect(share.status).toBe(200);

    // A 的问卷：原始 schema
    const surveyA = await createSurvey('A 的问卷');
    const localA = await addFromLibrary(surveyA._id, q._id);
    await publish(surveyA._id);
    await submit(surveyA.url_token, [{ question_id: localA._id, answer: 'a' }]);

    // B 的问卷：引用同一题后，在草稿里改了选项 A 的文案（value 不变）
    const surveyB = await createSurvey('B 的问卷', true, owner);
    const localB = await addFromLibrary(surveyB._id, q._id, owner);

    const surveyDoc = await Survey.findById(surveyB._id);
    const snapshot = surveyDoc.questions.find((x) => x._id.toString() === localB._id);
    snapshot.options[0].label = '选项A（B 改过文案）';
    snapshot.schema_hash = computeSchemaHash(snapshot.type, snapshot.options, snapshot.validation);
    await surveyDoc.save();

    await publish(surveyB._id, owner);
    await submit(surveyB.url_token, [{ question_id: localB._id, answer: 'a' }], owner);

    const res = await request(app)
      .get(`/api/questions/${q._id}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.aggregate.by_schema_group).toHaveLength(2);

    const groups = res.body.aggregate.by_schema_group;
    const firstLabels = groups.map((g) => g.aggregate.option_counts[0].option_label).sort();
    expect(firstLabels).toEqual(['选项A', '选项A（B 改过文案）'].sort());

    groups.forEach((g) => {
      // 两组各自 1 份答卷，没有被错误合并成 2
      expect(g.aggregate.answer_count).toBe(1);
      expect(g.representative_version).toBe(1);
    });
  });

  test('8. 权限穿透：他人非匿名问卷被剔除并计数', async () => {
    const q = await createQuestion({
      type: 'single_choice',
      title: '隐私测试题',
      options: [
        { label: '选项A', value: 'a' },
        { label: '选项B', value: 'b' },
      ],
    });

    const share = await request(app)
      .patch(`/api/questions/${q._id}/sharing`)
      .set(auth(owner.token))
      .send({ shared_with: [other.id] });
    expect(share.status).toBe(200);

    // B 的非匿名问卷：受访者身份与答卷关联，A 不应看到其数据
    const surveyB = await createSurvey('B 的非匿名问卷', false, other);
    const localB = await addFromLibrary(surveyB._id, q._id, other);
    await publish(surveyB._id, other);
    await submit(surveyB.url_token, [{ question_id: localB._id, answer: 'a' }], other);

    const res = await request(app)
      .get(`/api/questions/${q._id}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.aggregate.answer_count).toBe(0);
    expect(res.body.excluded_surveys_count).toBe(1);
    expect(res.body.surveys).toEqual([]);
    expect(res.body.aggregate.by_schema_group).toEqual([]);
  });

  test('9. 匿名不再豁免：他人匿名问卷同样被剔除并计数', async () => {
    const q = await createQuestion({
      type: 'single_choice',
      title: '匿名豁免测试题',
      options: [
        { label: '选项A', value: 'a' },
        { label: '选项B', value: 'b' },
      ],
    });

    const share = await request(app)
      .patch(`/api/questions/${q._id}/sharing`)
      .set(auth(owner.token))
      .send({ shared_with: [other.id] });
    expect(share.status).toBe(200);

    const surveyB = await createSurvey('B 的匿名问卷', true, other);
    const localB = await addFromLibrary(surveyB._id, q._id, other);
    await publish(surveyB._id, other);
    await submit(surveyB.url_token, [{ question_id: localB._id, answer: 'a' }]);

    const res = await request(app)
      .get(`/api/questions/${q._id}/stats`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.excluded_surveys_count).toBe(1);
    expect(res.body.surveys).toEqual([]);
    expect(res.body.aggregate.answer_count).toBe(0);
    expect(res.body.aggregate.by_schema_group).toEqual([]);
  });

  test('10. 同卷重复加同版本被拦截；同题不同版本 stats 按问卷去重不翻倍', async () => {
    const q = await createQuestion({
      type: 'single_choice',
      title: '重复引用统计题',
      options: [
        { label: '选项A', value: 'a' },
        { label: '选项B', value: 'b' },
      ],
    });

    const survey = await createSurvey('重复引用统计问卷');

    async function addFromLib(questionId) {
      return request(app)
        .post(`/api/surveys/${survey._id}/questions/from-library`)
        .set(auth(owner.token))
        .send({ question_id: questionId, required: false });
    }

    // 第一次加入 v1：成功
    const first = await addFromLib(q._id);
    expect(first.status).toBe(201);
    const local1 = first.body.questions[first.body.questions.length - 1]._id;

    // 同一版本再次加入：400 拦截，从源头避免同卷多份同源快照
    const dup = await addFromLib(q._id);
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('DUPLICATE_QUESTION');

    // 生成 v2 并加入：不同版本，允许
    const v2 = await request(app)
      .post(`/api/questions/${q._id}/versions`)
      .set(auth(owner.token))
      .send({ title: '重复引用统计题 v2' });
    expect(v2.status).toBe(201);

    const second = await addFromLib(v2.body._id);
    expect(second.status).toBe(201);
    const local2 = second.body.questions[second.body.questions.length - 1]._id;

    await publish(survey._id);

    const answers = [
      { question_id: local1, answer: 'a' },
      { question_id: local2, answer: 'a' },
    ];
    await submit(survey.url_token, answers);
    await submit(survey.url_token, answers);

    // 两个版本都在同一问卷里，includeVersions 才会把 v2 快照纳入统计
    const res = await request(app)
      .get(`/api/questions/${q._id}/stats?includeVersions=true`)
      .set(auth(owner.token));

    expect(res.status).toBe(200);
    expect(res.body.surveys).toHaveLength(1);
    expect(res.body.surveys[0].survey_id).toBe(survey._id);
    expect(res.body.surveys[0].answer_count).toBe(2);
    expect(res.body.aggregate.answer_count).toBe(2);

    const counts = Object.fromEntries(
      res.body.aggregate.option_counts.map((o) => [o.option_value, o.count])
    );
    // 两次提交、每次对 v1 与 v2 各答一次 a，共 4 票
    expect(counts).toEqual({ a: 4, b: 0 });
  });
});

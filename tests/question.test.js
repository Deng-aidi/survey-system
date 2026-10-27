/**
 * M1 题库（questions）集成测试
 *
 * 覆盖：v1 创建、列表隔离、读权限、结构不可原地修改、版本派生、
 *       版本链、restore 生成新版、并发建版本唯一性。
 *
 * 运行：npm test
 * 使用独立数据库 survey_system_test，不污染业务库。
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

describe('M1 题库（questions）', () => {
  let owner;
  let other;
  let v1Id;

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    await mongoose.connection.dropDatabase();
    // 确保 {root_id, version} 唯一索引存在
    await Question.syncIndexes();

    owner = await registerAndLogin(`q_owner_${Date.now()}`);
    other = await registerAndLogin(`q_other_${Date.now()}`);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('1. 新建题库题生成 v1：root_id = _id，parent_id = null', async () => {
    const res = await request(app)
      .post('/api/questions')
      .set(auth(owner.token))
      .send({
        type: 'single_choice',
        title: '你的年龄段',
        options: [
          { label: '18-25', value: 'a' },
          { label: '26+', value: 'b' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.body.root_id).toBe(res.body._id);
    expect(res.body.parent_id).toBeNull();
    expect(res.body.is_shared).toBe(false);
    expect(res.body.creator_id).toBe(owner.id);

    v1Id = res.body._id;
  });

  test('2. 题库题拒绝 order / required / jump_rules 字段', async () => {
    const res = await request(app)
      .post('/api/questions')
      .set(auth(owner.token))
      .send({ type: 'text', title: '不该出现', order: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MALFORMED_REQUEST');
    expect(res.body.message).toContain('order');
  });

  test('3. 列表只返回自己的题', async () => {
    const mine = await request(app).get('/api/questions').set(auth(owner.token));
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBe(1);

    const others = await request(app).get('/api/questions').set(auth(other.token));
    expect(others.status).toBe(200);
    expect(others.body.length).toBe(0);
  });

  test('4. 未共享时他人读取详情返回 403', async () => {
    const res = await request(app).get(`/api/questions/${v1Id}`).set(auth(other.token));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('5. PATCH 结构字段返回 400；PATCH 共享字段成功且他人可读', async () => {
    const patchStructure = await request(app)
      .patch(`/api/questions/${v1Id}`)
      .set(auth(owner.token))
      .send({ title: '偷偷改题' });

    expect(patchStructure.status).toBe(400);
    expect(patchStructure.body.code).toBe('QUESTION_STRUCTURE_IMMUTABLE');

    const patchShare = await request(app)
      .patch(`/api/questions/${v1Id}`)
      .set(auth(owner.token))
      .send({ is_shared: true });

    expect(patchShare.status).toBe(200);
    expect(patchShare.body.is_shared).toBe(true);

    const detail = await request(app).get(`/api/questions/${v1Id}`).set(auth(other.token));
    expect(detail.status).toBe(200);
    expect(detail.body.versions_count).toBe(1);
  });

  test('6. POST /versions 生成 v2，parent_id 指向来源版本', async () => {
    const res = await request(app)
      .post(`/api/questions/${v1Id}/versions`)
      .set(auth(owner.token))
      .send({ title: '你的年龄段（2026 新版）' });

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
    expect(res.body.parent_id).toBe(v1Id);
    expect(res.body.root_id).toBe(v1Id);
    expect(res.body.title).toBe('你的年龄段（2026 新版）');

    // 旧版本内容未被改动
    const old = await Question.findById(v1Id);
    expect(old.title).toBe('你的年龄段');

    v1Id = v1Id; // 保持引用
  });

  test('7. GET /versions 返回升序版本链', async () => {
    const res = await request(app).get(`/api/questions/${v1Id}/versions`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    expect(res.body.map((v) => v.version)).toEqual([1, 2]);
    expect(res.body[0]._id).toBe(v1Id);
  });

  test('8. restore 旧版本内容生成 v3，parent 指向链尾', async () => {
    const res = await request(app)
      .post(`/api/questions/${v1Id}/restore`)
      .set(auth(owner.token));

    expect(res.status).toBe(201);
    expect(res.body.version).toBe(3);
    expect(res.body.title).toBe('你的年龄段'); // 内容回到 v1
    // parent 是 v2（当前链尾），不是被恢复的 v1
    expect(res.body.parent_id).not.toBe(v1Id);
  });

  test('9. 并发创建版本：唯一索引生效，版本号不重复', async () => {
    const [a, b] = await Promise.all([
      request(app).post(`/api/questions/${v1Id}/versions`).set(auth(owner.token)).send({}),
      request(app).post(`/api/questions/${v1Id}/versions`).set(auth(owner.token)).send({}),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    const versions = [a.body.version, b.body.version].sort((x, y) => x - y);
    expect(versions).toEqual([4, 5]);

    const chain = await request(app).get(`/api/questions/${v1Id}/versions`).set(auth(owner.token));
    const allVersions = chain.body.map((v) => v.version);
    expect(allVersions).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(allVersions).size).toBe(allVersions.length);
  });
});

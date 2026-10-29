/**
 * 题库题路由（M1：草案 4.1 的 1–7 号接口）
 *
 * 挂载点：/api/questions
 *
 * 1. POST   /                      新建题库题（v1）
 * 2. GET    /                      我的题库（可含共享）
 * 3. GET    /:questionId           详情
 * 4. PATCH  /:questionId           仅共享/归档字段
 * 5. POST   /:questionId/versions  生成新版本
 * 6. GET    /:questionId/versions  版本链
 * 7. POST   /:questionId/restore   按历史版本内容生成新版本
 */
const express = require('express');
const mongoose = require('mongoose');

const Question = require('../models/Question');
const Survey = require('../models/Survey');
const Submission = require('../models/Submission');
const authenticate = require('../middleware/auth');
const { validateQuestionInput } = require('../utils/questionValidator');
const { computeSchemaHash } = require('../utils/schemaHash');

const router = express.Router();

// 题面语义字段：只有这四个属于题库
const CONTENT_FIELDS = ['type', 'title', 'options', 'validation'];
// 库管理字段：PATCH 只允许改这些
const MANAGE_FIELDS = ['is_shared', 'shared_with', 'archived_at'];

// ── 工具函数 ──

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOwner(doc, userId) {
  return doc.creator_id.toString() === userId.toString();
}

// 可读 = 创建者 ∪ 公开共享 ∪ 定向共享
function hasReadAccess(doc, userId) {
  if (isOwner(doc, userId)) return true;
  if (doc.is_shared) return true;
  return (doc.shared_with || []).some((id) => id.toString() === userId.toString());
}

async function findQuestion(req, res) {
  const { questionId } = req.params;
  if (!mongoose.isValidObjectId(questionId)) {
    res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
    return null;
  }
  const doc = await Question.findById(questionId);
  if (!doc) {
    res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
    return null;
  }
  return doc;
}

/**
 * 基于 source 版本生成新版本。
 * 并发安全：{root_id, version} 唯一索引；撞号后重算 max+1 重试一次。
 */
async function createNextVersion(source, overrides, parentId) {
  const content = {
    type: overrides.type !== undefined ? overrides.type : source.type,
    title: overrides.title !== undefined ? overrides.title : source.title,
    options: overrides.options !== undefined
      ? overrides.options
      : (source.options || []).map((o) => ({ label: o.label, value: o.value })),
    validation: overrides.validation !== undefined ? overrides.validation : source.validation,
  };

  const { valid, errors } = validateQuestionInput(content);
  if (!valid) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await Question.findOne({ root_id: source.root_id })
      .sort({ version: -1 })
      .select('version');
    const nextVersion = (latest ? latest.version : source.version) + 1;

    try {
      return await Question.create({
        creator_id: source.creator_id,
        root_id: source.root_id,
        parent_id: parentId,
        version: nextVersion,
        type: content.type,
        title: content.title.trim(),
        options: content.options || [],
        validation: content.validation || {},
        is_shared: source.is_shared,
        shared_with: source.shared_with || [],
      });
    } catch (err) {
      if (err.code === 11000) {
        // 并发撞号：第一次重试，第二次仍失败才报 409
        if (attempt === 0) continue;
        const conflict = new Error('版本号并发冲突，请重试');
        conflict.status = 409;
        conflict.code = 'VERSION_CONFLICT';
        throw conflict;
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────
// 1. POST /api/questions —— 新建题库题（v1）
// ─────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    // order / required / jump_rules 属于问卷上下文，禁止写入题库
    const illegal = Object.keys(req.body).filter((k) => !CONTENT_FIELDS.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `题库题不接受字段：${illegal.join(', ')}（order / required / jump_rules 属于问卷上下文）`,
      });
    }

    const { valid, errors } = validateQuestionInput(req.body);
    if (!valid) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: errors.join('; ') });
    }

    const { type, title, options, validation } = req.body;

    const doc = new Question({
      creator_id: req.user._id,
      type,
      title: title.trim(),
      options: options || [],
      validation: validation || {},
      version: 1,
    });
    // 首版：root_id = 自身 _id
    doc.root_id = doc._id;

    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: Object.values(err.errors).map((e) => e.message).join('; '),
      });
    }
    console.error('[questions POST]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 2. GET /api/questions —— 我的题库（?includeShared=true 含共享题）
// ─────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { type, keyword, includeShared } = req.query;

    const filter = { archived_at: null };

    if (includeShared === 'true') {
      filter.$or = [
        { creator_id: req.user._id },
        { is_shared: true },
        { shared_with: req.user._id },
      ];
    } else {
      filter.creator_id = req.user._id;
    }

    if (type) filter.type = type;
    if (keyword) filter.title = new RegExp(escapeRegExp(keyword), 'i');

    const items = await Question.find(filter).sort({ updated_at: -1 }).limit(200);
    res.status(200).json(items);
  } catch (err) {
    console.error('[questions GET]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 8. GET /api/questions/shared —— 他人共享给我的 + 全站公开的
//    必须注册在 GET /:questionId 之前，避免 "shared" 被当成 id
// ─────────────────────────────────────────────────────
router.get('/shared', authenticate, async (req, res) => {
  try {
    const userId = req.user._id;

    const items = await Question.find({
      // 排除自己创建的（自己的题在 GET / 里）
      creator_id: { $ne: new mongoose.Types.ObjectId(userId) },
      archived_at: null,
      $or: [
        { is_shared: true },
        { shared_with: userId },
      ],
    }).sort({ updated_at: -1 }).limit(200);

    res.status(200).json(items);
  } catch (err) {
    console.error('[questions shared GET]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 3. GET /api/questions/:questionId —— 详情
// ─────────────────────────────────────────────────────
router.get('/:questionId', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!hasReadAccess(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '无权访问该题目' });
    }

    const versionsCount = await Question.countDocuments({ root_id: doc.root_id });

    res.status(200).json({
      ...doc.toObject(),
      versions_count: versionsCount,
    });
  } catch (err) {
    console.error('[questions GET detail]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 4. PATCH /api/questions/:questionId —— 仅共享 / 归档字段
// ─────────────────────────────────────────────────────
router.patch('/:questionId', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以修改该题目' });
    }

    const keys = Object.keys(req.body);

    // 结构字段必须走 POST /versions，保证历史可追溯
    const structureKeys = keys.filter((k) => CONTENT_FIELDS.includes(k));
    if (structureKeys.length > 0) {
      return res.status(400).json({
        code: 'QUESTION_STRUCTURE_IMMUTABLE',
        message: `题库结构不可原地修改（${structureKeys.join(', ')}），请使用 POST /api/questions/:id/versions 生成新版本`,
      });
    }

    const illegal = keys.filter((k) => !MANAGE_FIELDS.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `仅允许更新 ${MANAGE_FIELDS.join(' / ')}，不允许：${illegal.join(', ')}`,
      });
    }

    if (req.body.is_shared !== undefined) {
      if (typeof req.body.is_shared !== 'boolean') {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'is_shared 必须是布尔值' });
      }
      doc.is_shared = req.body.is_shared;
    }

    if (req.body.shared_with !== undefined) {
      const { shared_with } = req.body;
      if (!Array.isArray(shared_with)) {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'shared_with 必须是用户 id 数组' });
      }
      const invalid = shared_with.filter((id) => !mongoose.isValidObjectId(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: `shared_with 含非法用户 id：${invalid.join(', ')}`,
        });
      }
      // 去重后写入
      doc.shared_with = [...new Set(shared_with.map((id) => id.toString()))];
    }

    if (req.body.archived_at !== undefined) {
      if (req.body.archived_at === null) {
        doc.archived_at = null;
      } else {
        const d = new Date(req.body.archived_at);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'archived_at 必须是合法时间或 null' });
        }
        doc.archived_at = d;
      }
    }

    await doc.save();
    res.status(200).json(doc);
  } catch (err) {
    console.error('[questions PATCH]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 9. PATCH /api/questions/:questionId/sharing —— 共享设置（仅创建者）
//    is_shared：公开给所有登录用户
//    shared_with：定向共享（只授予读 + 使用，不授予编辑权）
// ─────────────────────────────────────────────────────
router.patch('/:questionId/sharing', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以修改共享设置' });
    }

    const allowedFields = ['is_shared', 'shared_with'];
    const illegal = Object.keys(req.body).filter((k) => !allowedFields.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `共享设置仅接受 ${allowedFields.join(' / ')}，不允许：${illegal.join(', ')}`,
      });
    }

    if (req.body.is_shared === undefined && req.body.shared_with === undefined) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `共享设置至少提供 ${allowedFields.join(' / ')} 之一`,
      });
    }

    if (req.body.is_shared !== undefined) {
      if (typeof req.body.is_shared !== 'boolean') {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'is_shared 必须是布尔值' });
      }
      doc.is_shared = req.body.is_shared;
    }

    if (req.body.shared_with !== undefined) {
      const { shared_with } = req.body;
      if (!Array.isArray(shared_with)) {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'shared_with 必须是用户 id 数组' });
      }
      const invalid = shared_with.filter((id) => !mongoose.isValidObjectId(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: `shared_with 含非法用户 id：${invalid.join(', ')}`,
        });
      }

      // 去重后写入；不允许共享给自己
      const ids = [...new Set(shared_with.map((id) => id.toString()))];
      if (ids.includes(req.user._id.toString())) {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: 'shared_with 不允许包含自己',
        });
      }
      doc.shared_with = ids;
    }

    await doc.save();
    res.status(200).json(doc);
  } catch (err) {
    console.error('[questions sharing PATCH]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 5. POST /api/questions/:questionId/versions —— 生成新版本
// ─────────────────────────────────────────────────────
router.post('/:questionId/versions', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以创建新版本' });
    }

    const illegal = Object.keys(req.body).filter((k) => !CONTENT_FIELDS.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `创建新版本不接受字段：${illegal.join(', ')}`,
      });
    }

    // parent 指向"被派生的那一版"
    const created = await createNextVersion(doc, req.body, doc._id);
    res.status(201).json(created);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
    }
    if (err.status === 409) {
      return res.status(409).json({ code: err.code, message: err.message });
    }
    console.error('[questions versions POST]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 6. GET /api/questions/:questionId/versions —— 版本链
// ─────────────────────────────────────────────────────
router.get('/:questionId/versions', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!hasReadAccess(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '无权访问该题目' });
    }

    const chain = await Question.find({ root_id: doc.root_id }).sort({ version: 1 });
    res.status(200).json(chain);
  } catch (err) {
    console.error('[questions versions GET]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 7. POST /api/questions/:questionId/restore —— 按旧版本内容生成新版本
//    语义：不是回滚，而是"用旧内容再做一个新版"，parent 指向当前链尾
// ─────────────────────────────────────────────────────
router.post('/:questionId/restore', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以恢复版本' });
    }

    const latest = await Question.findOne({ root_id: doc.root_id }).sort({ version: -1 });
    if (!latest) {
      return res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '版本链不存在' });
    }

    // parent 指向链尾（保持线性历史），内容取被恢复的那一版
    const created = await createNextVersion(doc, {}, latest._id);
    res.status(201).json(created);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
    }
    if (err.status === 409) {
      return res.status(409).json({ code: err.code, message: err.message });
    }
    console.error('[questions restore POST]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 10. GET /api/questions/:questionId/usages —— 引用追踪（仅创建者）
//     找出 surveys.questions 中 source_question_id 指向该题的内嵌快照
// ─────────────────────────────────────────────────────
router.get('/:questionId/usages', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以查看引用情况' });
    }

    // 内嵌数组匹配；取出完整 questions 数组，避免 $elemMatch 只返回第一个命中项
    const surveys = await Survey.find(
      { 'questions.source_question_id': doc._id },
      { title: 1, status: 1, questions: 1 }
    );

    const usages = [];
    for (const survey of surveys) {
      const hits = (survey.questions || []).filter(
        (q) => q.source_question_id && q.source_question_id.equals(doc._id)
      );
      for (const hit of hits) {
        usages.push({
          survey_id: survey._id,
          title: survey.title,
          status: survey.status,
          source_version: hit.source_version,
          local_question_id: hit._id,
        });
      }
    }

    res.status(200).json(usages);
  } catch (err) {
    console.error('[questions usages GET]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────
// 11. GET /api/questions/:questionId/stats —— 跨问卷统计（仅创建者）
//     ?includeVersions=true 时按整个版本链统计，并额外给出 by_version
//     ?limit=N 限制 number / text 的 all_values 长度（默认 100）
// ─────────────────────────────────────────────────────

// 去重后保留 ObjectId 实例
function uniqueObjectIds(ids) {
  return [...new Map(ids.map((id) => [id.toString(), id])).values()];
}

// 无引用时的空统计结构：按题型给出稳定的字段形状
function emptyAggregate(type, options) {
  if (type === 'single_choice' || type === 'multiple_choice') {
    return {
      answer_count: 0,
      option_counts: (options || []).map((o) => ({
        option_value: o.value,
        option_label: o.label,
        count: 0,
      })),
    };
  }
  if (type === 'number') {
    return {
      answer_count: 0,
      stats: { avg: null, min: null, max: null },
      all_values: [],
    };
  }
  return { answer_count: 0, all_values: [] };
}

/**
 * 对一组 (survey, 本地题) 映射做答案聚合。
 * mappings：[{ survey_id, local_question_id }]
 */
async function aggregateAnswers({ type, options, mappings, limit }) {
  if (mappings.length === 0) return emptyAggregate(type, options);

  const surveyIds = uniqueObjectIds(mappings.map((m) => m.survey_id));
  const localIds = uniqueObjectIds(mappings.map((m) => m.local_question_id));

  const matchStage = {
    survey_id: { $in: surveyIds },
    'answers.question_id': { $in: localIds },
  };

  // 作答次数按 submission 计（多选不会因为选了多个值而重复计数）
  const answer_count = await Submission.countDocuments(matchStage);

  if (type === 'single_choice' || type === 'multiple_choice') {
    const pipeline = [
      { $match: matchStage },
      { $unwind: '$answers' },
      { $match: { 'answers.question_id': { $in: localIds } } },
    ];
    // 多选：answer 是数组，再展开一次，每个选中值算一票
    if (type === 'multiple_choice') {
      pipeline.push({ $unwind: '$answers.answer' });
    }
    pipeline.push({ $group: { _id: '$answers.answer', count: { $sum: 1 } } });

    const agg = await Submission.aggregate(pipeline);
    const countMap = new Map(agg.map((r) => [String(r._id), r.count]));

    return {
      answer_count,
      option_counts: (options || []).map((o) => ({
        option_value: o.value,
        option_label: o.label,
        count: countMap.get(o.value) || 0,
      })),
    };
  }

  if (type === 'number') {
    const [agg] = await Submission.aggregate([
      { $match: matchStage },
      { $unwind: '$answers' },
      { $match: { 'answers.question_id': { $in: localIds } } },
      {
        $group: {
          _id: null,
          avg: { $avg: '$answers.answer' },
          min: { $min: '$answers.answer' },
          max: { $max: '$answers.answer' },
          values: { $push: '$answers.answer' },
        },
      },
    ]);

    return {
      answer_count,
      stats: agg
        ? { avg: agg.avg, min: agg.min, max: agg.max }
        : { avg: null, min: null, max: null },
      all_values: agg ? agg.values.slice(0, limit) : [],
    };
  }

  // text：收集原文
  const [agg] = await Submission.aggregate([
    { $match: matchStage },
    { $unwind: '$answers' },
    { $match: { 'answers.question_id': { $in: localIds } } },
    { $group: { _id: null, values: { $push: '$answers.answer' } } },
  ]);

  return {
    answer_count,
    all_values: agg ? agg.values.slice(0, limit) : [],
  };
}

router.get('/:questionId/stats', authenticate, async (req, res) => {
  try {
    const doc = await findQuestion(req, res);
    if (!doc) return;

    if (!isOwner(doc, req.user._id)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: '只有创建者可以查看题目统计' });
    }

    let limit = 100;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'limit 必须是非负整数' });
      }
      limit = n;
    }

    const includeVersions = req.query.includeVersions === 'true';

    // 版本范围：默认当前版本；includeVersions 取整条版本链
    const chain = includeVersions
      ? await Question.find({ root_id: doc.root_id }).sort({ version: 1 })
      : [doc];

    const included_versions = chain.map((v) => v.version);
    const versionIds = chain.map((v) => v._id);

    // 反查引用这些版本的问卷（带 creator_id 做隐私过滤）
    const surveys = await Survey.find(
      { 'questions.source_question_id': { $in: versionIds } },
      { title: 1, creator_id: 1, questions: 1 }
    );

    // 跨卷统计权限：只统计当前用户自己的问卷
    // 他人的问卷（无论是否匿名）全部剔除，只返回被剔除的问卷数
    const currentUserId = req.user._id.toString();
    const visibleSurveys = [];
    let excluded_surveys_count = 0;

    for (const survey of surveys) {
      const isMine = survey.creator_id.toString() === currentUserId;
      if (isMine) {
        visibleSurveys.push(survey);
      } else {
        excluded_surveys_count += 1;
      }
    }

    // 同一问卷里可能同时引用了这道题的多个版本（v1/v2），
    // 每个命中快照都要映射进 mappings，聚合时用全部 localIds 查询，答案才不会丢
    const mappings = [];
    const surveyBuckets = new Map(); // survey_id -> 该问卷下所有命中快照
    for (const survey of visibleSurveys) {
      const sid = String(survey._id);

      const hits = (survey.questions || []).filter(
        (q) => q.source_question_id &&
          versionIds.some((vid) => vid.equals(q.source_question_id))
      );
      if (!hits.length) continue;

      const bucket = surveyBuckets.get(sid) || {
        survey_id: survey._id,
        title: survey.title,
        localIds: [],
        versions: [],
      };

      for (const q of hits) {
        bucket.localIds.push(q._id);
        bucket.versions.push(q.source_version);
        mappings.push({
          survey_id: survey._id,
          survey_title: survey.title,
          local_question_id: q._id,
          source_version: q.source_version,
          // 旧快照没有指纹时，用其自身题面现算，避免全部落入同一组
          schema_hash: q.schema_hash || computeSchemaHash(q.type, q.options, q.validation),
          snapshot_type: q.type,
          snapshot_options: q.options,
        });
      }

      surveyBuckets.set(sid, bucket);
    }

    // 按问卷合并：同一问卷内多个版本的作答人数合并统计
    const surveyEntries = await Promise.all(
      [...surveyBuckets.values()].map(async (b) => {
        const versions = [...new Set(b.versions)].filter((v) => typeof v === 'number');
        return {
          survey_id: b.survey_id,
          title: b.title,
          // 单版本时就是本身版本号；多版本取最小版本作为代表，完整列表见 source_versions
          source_version: versions.length ? Math.min(...versions) : null,
          source_versions: versions,
          answer_count: await Submission.countDocuments({
            survey_id: b.survey_id,
            'answers.question_id': { $in: b.localIds },
          }),
        };
      })
    );

    // 总体汇总
    const aggregate = await aggregateAnswers({
      type: doc.type,
      options: doc.options,
      mappings,
      limit,
    });

    // 按快照指纹分组：选项文案/取值/校验不同即视为不同 schema，不做跨组求和
    const groups = new Map();
    for (const m of mappings) {
      if (!groups.has(m.schema_hash)) groups.set(m.schema_hash, []);
      groups.get(m.schema_hash).push(m);
    }

    aggregate.by_schema_group = await Promise.all(
      [...groups.entries()].map(async ([schema_hash, group]) => {
        const versions = group
          .map((m) => m.source_version)
          .filter((v) => typeof v === 'number');
        return {
          schema_hash,
          representative_version: versions.length > 0 ? Math.min(...versions) : null,
          aggregate: await aggregateAnswers({
            type: group[0].snapshot_type,
            options: group[0].snapshot_options,
            mappings: group,
            limit,
          }),
        };
      })
    );

    res.status(200).json({
      question_id: doc._id,
      root_id: doc.root_id,
      included_versions,
      excluded_surveys_count,
      surveys: surveyEntries,
      aggregate,
    });
  } catch (err) {
    console.error('[questions stats GET]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

module.exports = router;

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
const authenticate = require('../middleware/auth');
const { validateQuestionInput } = require('../utils/questionValidator');

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

module.exports = router;

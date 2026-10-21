const express = require('express');
const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const authenticate = require('../middleware/auth');
const requireSurveyOwner = require('../middleware/ownership');

const router = express.Router();
// ↑ mongoose require 已提升到顶部，aggregate 管道里的 mongoose.Types.ObjectId 可以正常使用

// ── 所有创建者专属路由都需要 JWT + 创建者身份 ──
// 创建：authenticate（要 JWT）
// 其他 5 个：authenticate + requireSurveyOwner（要 JWT + 是创建者）

/**
 * POST /api/surveys
 * 创建问卷（draft 状态，自动生成 url_token）
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, description, allow_anonymous, deadline } = req.body;

    // 格式校验
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'title 必填' });
    }

    // 生成 url_token
    const url_token = await Survey.generateUrlToken();

    const survey = new Survey({
      url_token,
      creator_id: req.user._id,   // 字符串 → Mongoose 自动转 ObjectId
      title: title.trim(),
      description: description || '',
      allow_anonymous: allow_anonymous ?? false,
      deadline: deadline || null,
      status: 'draft',
    });

    await survey.save();

    res.status(201).json(survey);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: Object.values(err.errors).map((e) => e.message).join('; '),
      });
    }
    console.error('[surveys POST]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

/**
 * GET /api/surveys
 * 我的问卷列表（aggregate：$match creator_id → $addFields question_count → $project questions:0 → $sort）
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const surveys = await Survey.aggregate([
      { $match: { creator_id: new mongoose.Types.ObjectId(req.user._id) } },
      { $addFields: { question_count: { $size: '$questions' } } },
      {
        $project: {
          questions: 0,
          creator_id: 0,
          __v: 0,
        },
      },
      { $sort: { created_at: -1 } },
    ]);

    res.status(200).json(surveys);
  } catch (err) {
    console.error('[surveys GET /]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

/**
 * GET /api/surveys/:surveyId
 * 创建者详情（完整 survey 含 questions[]）
 */
router.get('/:surveyId', authenticate, requireSurveyOwner, async (req, res) => {
  // req.survey 已由 requireSurveyOwner 挂好，直接返回
  res.status(200).json(req.survey);
});

/**
 * PATCH /api/surveys/:surveyId
 * 更新元信息：仅 title / description / allow_anonymous / deadline
 */
router.patch('/:surveyId', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    const allowedFields = ['title', 'description', 'allow_anonymous', 'deadline'];
    const updates = {};

    // 检查是否有不在白名单里的字段（混传也拒绝）
    const illegal = Object.keys(req.body).filter((k) => !allowedFields.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `不允许更新以下字段：${illegal.join(', ')}`,
      });
    }

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `仅允许更新以下字段：${allowedFields.join(', ')}`,
      });
    }

    // 用 save() 保证 __v 递增
    Object.assign(req.survey, updates);
    await req.survey.save();

    res.status(200).json(req.survey);
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: Object.values(err.errors).map((e) => e.message).join('; '),
      });
    }
    console.error('[surveys PATCH]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

/**
 * PATCH /api/surveys/:surveyId/status
 * 改变状态：draft → open → closed
 * status → open 时暂留校验钩子（等 Q2 实现 jump_rules 后再接）
 */
router.patch('/:surveyId/status', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    const { status } = req.body;

    const allowedStatuses = ['draft', 'open', 'closed'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `status 必须是 ${allowedStatuses.join(' / ')}`,
      });
    }

    // 发布前校验钩子（v1.2.1 要求：status → open 时统一校验 jump_rules）
    // TODO: 等 Q2 实现后，在这里调 validate_all_jump_rules_for_publish()
    // 现在先跳过，直接更新状态
    // if (status === 'open') {
    //   const errors = validate_all_jump_rules_for_publish(req.survey);
    //   if (errors.length > 0) return res.status(422).json({ ... });
    // }

    req.survey.status = status;
    await req.survey.save();   // save() 保证 __v 递增

    res.status(200).json({ _id: req.survey._id, status: req.survey.status, updated_at: req.survey.updated_at });
  } catch (err) {
    console.error('[surveys PATCH status]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

/**
 * DELETE /api/surveys/:surveyId
 * 删除问卷（应用层级联删 submissions，由 Survey.deleteOne pre hook 执行）
 */
router.delete('/:surveyId', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    // survey.deleteOne() 会触发 Survey model 里的 pre('deleteOne') 级联 submissions
    await req.survey.deleteOne();

    res.status(204).send();
  } catch (err) {
    console.error('[surveys DELETE]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

module.exports = router;

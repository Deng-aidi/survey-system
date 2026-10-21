const express = require('express');
const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const Submission = require('../models/Submission');
const authenticate = require('../middleware/auth');
const requireSurveyOwner = require('../middleware/ownership');
const {
  validateQuestionInput,
  validateJumpRulesExist,
  validate_all_jump_rules_for_publish,
} = require('../utils/questionValidator');

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

// ─────────────────────────────────────────────────────
// T1/T2 公共：单题统计
// 一题一管道；option.value → label 映射由后端完成；
// 未出现在提交中的选项保留 count:0（按 question.options 顺序遍历）
// ─────────────────────────────────────────────────────
async function buildQuestionStats(survey, question) {
  const qid = question._id;
  const base = {
    question_id: qid,
    question_title: question.title,
    question_type: question.type,
  };

  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const pipeline = [
      { $match: { survey_id: survey._id } },
      { $unwind: '$answers' },
      { $match: { 'answers.question_id': qid } },
    ];
    // 多选：answer 是数组，再展开一次，每个选中值算一票
    if (question.type === 'multiple_choice') {
      pipeline.push({ $unwind: '$answers.answer' });
    }
    pipeline.push({ $group: { _id: '$answers.answer', count: { $sum: 1 } } });

    const agg = await Submission.aggregate(pipeline);
    const countMap = new Map(agg.map((r) => [String(r._id), r.count]));

    // 按 options 顺序遍历，聚合结果里查不到的选项补 0
    const option_counts = (question.options || []).map((opt) => ({
      option_label: opt.label,
      option_value: opt.value,
      count: countMap.get(opt.value) || 0,
    }));

    // answer_count = 该题被作答次数，可能小于 total_submissions（非必答被跳过、被跳转绕过）
    // 多选的 sum(count) 是"选择次数"不是"作答次数"，需按 submission 单独计数
    let answer_count;
    if (question.type === 'single_choice') {
      answer_count = agg.reduce((s, r) => s + r.count, 0);
    } else {
      answer_count = await Submission.countDocuments({
        survey_id: survey._id,
        'answers.question_id': qid,
      });
    }

    return { ...base, answer_count, option_counts };
  }

  if (question.type === 'number') {
    const [agg] = await Submission.aggregate([
      { $match: { survey_id: survey._id } },
      { $unwind: '$answers' },
      { $match: { 'answers.question_id': qid } },
      {
        $group: {
          _id: null,
          avg: { $avg: '$answers.answer' },
          min: { $min: '$answers.answer' },
          max: { $max: '$answers.answer' },
          values: { $push: '$answers.answer' },
          answer_count: { $sum: 1 },
        },
      },
    ]);

    return {
      ...base,
      answer_count: agg ? agg.answer_count : 0,
      // 无数据时 avg/min/max 全为 null
      stats: agg
        ? { avg: agg.avg, min: agg.min, max: agg.max }
        : { avg: null, min: null, max: null },
      all_values: agg ? agg.values : [],
    };
  }

  // text：聚合所有文本答案
  const [agg] = await Submission.aggregate([
    { $match: { survey_id: survey._id } },
    { $unwind: '$answers' },
    { $match: { 'answers.question_id': qid } },
    {
      $group: {
        _id: null,
        values: { $push: '$answers.answer' },
        answer_count: { $sum: 1 },
      },
    },
  ]);

  return {
    ...base,
    answer_count: agg ? agg.answer_count : 0,
    all_values: agg ? agg.values : [],
  };
}

/**
 * T1：GET /api/surveys/:surveyId/stats
 * 整卷统计；?questionId= 可选筛选单题（不存在 → 404）
 * 注册在 GET /:surveyId 之前，避免被单段路由抢占
 */
router.get('/:surveyId/stats', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    const survey = req.survey;
    const total_submissions = await Submission.countDocuments({ survey_id: survey._id });

    let questions = survey.questions;
    if (req.query.questionId !== undefined) {
      const target = questions.filter((q) => q._id.toString() === req.query.questionId);
      if (target.length === 0) {
        return res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
      }
      questions = target;
    }

    // 一题一管道，并行执行
    const questionStats = await Promise.all(questions.map((q) => buildQuestionStats(survey, q)));

    res.status(200).json({
      survey_id: survey._id,
      survey_title: survey.title,
      total_submissions,
      questions: questionStats,
    });
  } catch (err) {
    console.error('[stats T1]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

/**
 * T2：GET /api/surveys/:surveyId/stats/:questionId
 * 单题统计，响应结构与 T1 的 questions[i] 相同
 */
router.get('/:surveyId/stats/:questionId', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    const survey = req.survey;
    const question = survey.questions.find((q) => q._id.toString() === req.params.questionId);
    if (!question) {
      return res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
    }

    const stats = await buildQuestionStats(survey, question);
    res.status(200).json(stats);
  } catch (err) {
    console.error('[stats T2]', err);
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
 * status → open 时执行发布前完整校验（存在性+向前+无环），draft/closed 不校验
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

    // 发布前校验：status → open 时统一校验所有 jump_rules
    // ① targetQuestionId 存在或为 null ② 不允许回跳 ③ 规则图无环
    if (status === 'open') {
      const ruleErrors = validate_all_jump_rules_for_publish(req.survey);
      if (ruleErrors.length > 0) {
        return res.status(422).json({
          code: 'INVALID_JUMP_RULE',
          message: '问卷发布前跳转规则校验未通过',
          errors: ruleErrors,
        });
      }
    }

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

// ─────────────────────────────────────────────────────
// Q1：添加题目
// POST /api/surveys/:surveyId/questions
// 不接受 jump_rules 字段（传了直接 400）
// ─────────────────────────────────────────────────────
router.post('/:surveyId/questions', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    // Q1 不接受 jump_rules 字段
    if (req.body.jump_rules !== undefined) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: '添加题目时不接受 jump_rules 字段，请通过 PATCH /questions/:questionId/jump_rules 单独配置',
      });
    }

    // 格式校验
    const { valid, errors } = validateQuestionInput(req.body);
    if (!valid) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: errors.join('; '),
      });
    }

    const { type, title, required, options, validation } = req.body;

    // 新增题 order = 当前 questions 数组长度
    const newOrder = req.survey.questions.length;

    req.survey.questions.push({
      type,
      title: title.trim(),
      order: newOrder,
      required: required ?? false,
      options: options || [],
      validation: validation || {},
      jump_rules: [],
    });

    await req.survey.save();   // save() 保证 __v 递增

    res.status(201).json(req.survey);
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
// Q2：仅修改 jump_rules
// PATCH /api/surveys/:surveyId/questions/:questionId/jump_rules
// 不允许改题干/选项/type/required/validation/order
// ─────────────────────────────────────────────────────
router.patch('/:surveyId/questions/:questionId/jump_rules', authenticate, requireSurveyOwner, async (req, res) => {
  try {
    const { questionId } = req.params;
    const { jump_rules } = req.body;

    // 只接受 jump_rules 字段
    const allowedFields = ['jump_rules'];
    const illegal = Object.keys(req.body).filter((k) => !allowedFields.includes(k));
    if (illegal.length > 0) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: `仅允许更新 jump_rules，不允许：${illegal.join(', ')}`,
      });
    }

    // 找到目标题目
    const question = req.survey.questions.find((q) => q._id.toString() === questionId);
    if (!question) {
      return res.status(404).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
    }

    // jump_rules: [] 直接通过并清空，不做引用校验
    // 非空时只校验 targetQuestionId 存在性（向前+循环留给 S5 发布时）
    const ruleErrors = validateJumpRulesExist(req.survey, jump_rules);
    if (ruleErrors.length > 0) {
      return res.status(400).json({
        code: 'INVALID_JUMP_RULE',
        message: ruleErrors.join('; '),
      });
    }

    question.jump_rules = jump_rules;
    await req.survey.save();

    res.status(200).json(req.survey);
  } catch (err) {
    console.error('[jump_rules PATCH]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

module.exports = router;

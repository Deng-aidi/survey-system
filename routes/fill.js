const express = require('express');
const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Submission = require('../models/Submission');
const optionalAuth = require('../middleware/optionalAuth');
const { validateAnswer } = require('../utils/questionValidator');
const { resolve_next_question } = require('../utils/jumpResolver');

const router = express.Router();

// ─────────────────────────────────────────────
// 公共：按 token 取问卷 + 可填写性检查
// 检查顺序：不存在 404 → 未发布/已关闭/已过期 403 → 不允许匿名且未登录 401
// status !== 'open' 一律 403：draft 用 SURVEY_NOT_OPEN 区分，closed 用 SURVEY_CLOSED
// 返回 survey 文档；检查失败时已写响应，返回 null
// ─────────────────────────────────────────────
async function loadAccessibleSurvey(req, res) {
  const survey = await Survey.findOne({ url_token: req.params.token });

  if (!survey) {
    res.status(404).json({ code: 'SURVEY_NOT_FOUND', message: '问卷不存在' });
    return null;
  }

  if (survey.status === 'draft') {
    res.status(403).json({ code: 'SURVEY_NOT_OPEN', message: '问卷尚未发布' });
    return null;
  }

  if (survey.status === 'closed') {
    res.status(403).json({ code: 'SURVEY_CLOSED', message: '问卷已关闭' });
    return null;
  }

  const now = new Date();
  if (survey.deadline && now > survey.deadline) {
    res.status(403).json({ code: 'SURVEY_EXPIRED', message: '问卷已过截止时间' });
    return null;
  }

  if (survey.allow_anonymous === false && !req.user) {
    res.status(401).json({ code: 'LOGIN_REQUIRED', message: '该问卷仅限登录用户填写' });
    return null;
  }

  return survey;
}

// 按 order 升序排列题目
function sortedQuestions(survey) {
  return [...survey.questions].sort((a, b) => a.order - b.order);
}

// 取 order 顺序中的下一题
function nextByOrder(sorted, questionIdStr) {
  const idx = sorted.findIndex((q) => q._id.toString() === questionIdStr);
  if (idx < 0) return null;
  return idx + 1 < sorted.length ? sorted[idx + 1] : null;
}

// ─────────────────────────────────────────────
// F1：GET /api/surveys/by-token/:token
// 取问卷（精简版，不含 creator_id）
// ─────────────────────────────────────────────
router.get('/:token', optionalAuth, async (req, res) => {
  try {
    const survey = await loadAccessibleSurvey(req, res);
    if (!survey) return;

    res.status(200).json({
      _id: survey._id,
      url_token: survey.url_token,
      title: survey.title,
      description: survey.description,
      allow_anonymous: survey.allow_anonymous,
      status: survey.status,
      deadline: survey.deadline,
      questions: survey.questions.map((q) => ({
        _id: q._id,
        type: q.type,
        title: q.title,
        order: q.order,
        required: q.required,
        options: q.options,
        validation: q.validation,
        jump_rules: q.jump_rules,
      })),
      __v: survey.__v,
    });
  } catch (err) {
    console.error('[fill F1]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────
// F2：POST /api/surveys/by-token/:token/answers/validate
// 单题校验 + 跳转解释；无状态，不写数据库
// ─────────────────────────────────────────────
router.post('/:token/answers/validate', optionalAuth, async (req, res) => {
  try {
    const survey = await loadAccessibleSurvey(req, res);
    if (!survey) return;

    const { question_id, answer } = req.body || {};

    if (!question_id || typeof question_id !== 'string') {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: 'question_id 必填且必须是字符串',
      });
    }
    if (answer === undefined) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: 'answer 不能为 undefined',
      });
    }

    const question = survey.questions.find((q) => q._id.toString() === question_id);
    if (!question) {
      return res.status(400).json({ code: 'QUESTION_NOT_FOUND', message: '题目不存在' });
    }

    const result = validateAnswer(question, answer);
    if (!result.valid) {
      // 校验失败仍返回 200；errors 统一为 [{ question_id, reason }]，与 F3 保持一致
      return res.status(200).json({
        valid: false,
        errors: result.errors.map((reason) => ({ question_id, reason })),
      });
    }

    const { matched, target } = resolve_next_question(question, answer);
    let next_question_id = null;

    if (matched) {
      // matched 且 target=null → 结束
      next_question_id = target === null || target === undefined ? null : target.toString();
    } else {
      // 未命中任何规则 → 按 order 找下一题
      const sorted = sortedQuestions(survey);
      const next = nextByOrder(sorted, question._id.toString());
      next_question_id = next ? next._id.toString() : null;
    }

    res.status(200).json({ valid: true, next_question_id });
  } catch (err) {
    console.error('[fill F2]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────
// F3：POST /api/surveys/by-token/:token/submissions
// 重放跳转路径 + 全量二次校验 + 持久化
// ─────────────────────────────────────────────
router.post('/:token/submissions', optionalAuth, async (req, res) => {
  try {
    const survey = await loadAccessibleSurvey(req, res);
    if (!survey) return;

    const body = req.body || {};
    const answers = body.answers;

    // 1. 格式检查
    if (!Array.isArray(answers)) {
      return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'answers 必须是数组' });
    }
    const seenQids = new Set();
    for (const item of answers) {
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'answers 的元素必须是对象' });
      }
      if (!item.question_id || typeof item.question_id !== 'string') {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: 'answers 中每项必须有 question_id（字符串）',
        });
      }
      if (item.answer === undefined) {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: 'answers 中每项必须有 answer',
        });
      }
      if (seenQids.has(item.question_id)) {
        return res.status(400).json({
          code: 'MALFORMED_REQUEST',
          message: `answers 中存在重复的 question_id：${item.question_id}`,
        });
      }
      seenQids.add(item.question_id);
    }

    // 2. 版本冲突检查
    if (body.expected_version !== undefined && body.expected_version !== survey.__v) {
      return res.status(409).json({
        code: 'SURVEY_CONFLICT',
        message: '问卷版本已变化，请刷新后重新填写',
      });
    }

    const sorted = sortedQuestions(survey);
    const questionById = new Map(survey.questions.map((q) => [q._id.toString(), q]));

    // 3. 提交的题目必须属于当前问卷
    for (const item of answers) {
      if (!questionById.has(item.question_id)) {
        return res.status(409).json({
          code: 'SURVEY_CONFLICT',
          message: `题目 ${item.question_id} 不属于当前问卷，问卷可能已被修改`,
        });
      }
    }

    // 4. answer_map
    const answer_map = {};
    for (const item of answers) {
      answer_map[item.question_id] = item.answer;
    }

    // 5. 重放跳转路径
    const errors = [];
    const path_ids = [];
    const path_set = new Set();
    let current = sorted.length > 0 ? sorted[0] : null;

    while (current) {
      const cid = current._id.toString();
      path_ids.push(cid);
      path_set.add(cid);

      if (Object.prototype.hasOwnProperty.call(answer_map, cid)) {
        const ans = answer_map[cid];
        const result = validateAnswer(current, ans);
        if (!result.valid) {
          errors.push({ question_id: cid, reason: result.errors.join('; ') });
        }

        const { matched, target } = resolve_next_question(current, ans);

        if (matched) {
          if (target === null || target === undefined) {
            current = null; // 跳到结束
          } else {
            const tid = target.toString();
            const targetQ = questionById.get(tid);
            if (!targetQ) {
              errors.push({ question_id: cid, reason: `跳转目标 ${tid} 不存在` });
              break;
            }
            if (path_set.has(tid)) {
              // 防御：draft 问卷可能带非法规则，避免重放死循环
              errors.push({ question_id: cid, reason: `跳转路径出现循环：${tid}` });
              break;
            }
            current = targetQ;
          }
        } else {
          current = nextByOrder(sorted, cid);
        }
      } else {
        // 当前题没有答案：必答题报错，然后按 order 走下一题
        if (current.required) {
          errors.push({ question_id: cid, reason: '必答题未作答' });
        }
        current = nextByOrder(sorted, cid);
      }
    }

    // 6. 路径外答案
    for (const qid of Object.keys(answer_map)) {
      if (!path_set.has(qid)) {
        errors.push({ question_id: qid, reason: '该题目不在本次填写路径上' });
      }
    }

    // 7. 有错误 → 全量校验失败
    if (errors.length > 0) {
      return res.status(400).json({
        code: 'FINAL_VALIDATION_FAILED',
        message: '提交校验未通过',
        errors,
      });
    }

    // 8. 构造并写入 submission
    const now = new Date();
    const submissionAnswers = sorted
      .filter((q) => Object.prototype.hasOwnProperty.call(answer_map, q._id.toString()))
      .map((q) => ({
        question_id: q._id,
        question_type: q.type,
        answer: answer_map[q._id.toString()],
      }));

    const submission = await Submission.create({
      survey_id: survey._id,
      user_id: req.user ? new mongoose.Types.ObjectId(req.user._id) : null,
      started_at: now,
      submitted_at: now,
      answers: submissionAnswers,
    });

    res.status(201).json({
      submission_id: submission._id,
      answered_count: submissionAnswers.length,
      skipped_count: sorted.length - submissionAnswers.length,
    });
  } catch (err) {
    console.error('[fill F3]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
});

module.exports = router;

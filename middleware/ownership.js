const Survey = require('../models/Survey');

/**
 * 创建者身份校验中间件
 * 前置：authenticate 已跑完，req.user._id 是字符串（JWT payload 里显式 toString）
 * 后置：req.survey 挂载查好的 survey 文档；非创建者返回 403
 */
async function requireSurveyOwner(req, res, next) {
  try {
    const { surveyId } = req.params;
    if (!surveyId) {
      return res.status(400).json({ code: 'MALFORMED_REQUEST', message: 'surveyId 必填' });
    }

    const survey = await Survey.findById(surveyId);
    if (!survey) {
      return res.status(404).json({ code: 'SURVEY_NOT_FOUND', message: '问卷不存在' });
    }

    // 关键：survey.creator_id 是 ObjectId，req.user._id 是字符串（JWT toString 后）
    // 必须用 .equals()，不能用 ===
    if (!survey.creator_id.equals(req.user._id)) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: '无权操作此问卷',
      });
    }

    req.survey = survey;
    next();
  } catch (err) {
    if (err.name === 'CastError') {
      // surveyId 不是合法 ObjectId 格式（如 "abc"）→ 按 404 处理而非 500
      return res.status(404).json({ code: 'SURVEY_NOT_FOUND', message: '问卷不存在' });
    }
    console.error('[requireSurveyOwner]', err);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
  }
}

module.exports = requireSurveyOwner;

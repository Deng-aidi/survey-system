/**
 * 已发布问卷结构锁定（第二阶段 M2）
 *
 * 规则：published_at 存在 或 status !== 'draft' → 拒绝结构变更。
 * 两个条件取"或"，让第一阶段的旧 open/closed 问卷无需回填 published_at
 * 也能被正确锁定。
 *
 * 必须挂在 requireSurveyOwner 之后（依赖 req.survey）。
 */
function structureLock(req, res, next) {
  const survey = req.survey;

  if (!survey) {
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'structureLock 必须在 requireSurveyOwner 之后使用',
    });
  }

  if (survey.published_at || survey.status !== 'draft') {
    return res.status(409).json({
      code: 'SURVEY_STRUCTURE_LOCKED',
      message: '已发布或已结束的问卷不可修改结构，请新建题目版本并创建新问卷',
    });
  }

  next();
}

module.exports = structureLock;

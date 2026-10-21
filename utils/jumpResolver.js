/**
 * 跳转规则解释器
 * 由后端解释执行问卷中配置的 jump_rules，逻辑不写死。
 */

/**
 * 判断单条跳转条件是否命中
 *
 * @param {object} condition  { operator, value }
 * @param {object} question   当前题目（保留参数，供后续需要题型上下文的 operator 使用）
 * @param {*}      answer     当前题答案
 * @returns {boolean}
 */
function condition_matches(condition, question, answer) {
  if (!condition || typeof condition !== 'object') return false;

  const { operator, value } = condition;

  switch (operator) {
    case 'equals':
      return answer === value;

    case 'includes':
      return Array.isArray(answer) && answer.includes(value);

    case 'gte':
      return typeof answer === 'number' && answer >= value;

    case 'lte':
      return typeof answer === 'number' && answer <= value;

    case 'eq':
      // 数字和字符串都支持（严格相等）
      return answer === value;

    case 'between':
      return (
        Array.isArray(value) &&
        value.length === 2 &&
        answer >= value[0] &&
        answer <= value[1]
      );

    default:
      return false;
  }
}

/**
 * 解释当前题的跳转结果
 * 按 jump_rules 数组顺序匹配，第一条命中生效。
 *
 * @param {object} question 当前题目子文档
 * @param {*}      answer   当前题答案
 * @returns {{ matched: boolean, target: (object|null) }}
 *   matched=true  target=null → 跳到结束
 *   matched=true  target 有值 → 跳到该题
 *   matched=false → 调用方按 order 顺序找下一题
 */
function resolve_next_question(question, answer) {
  const rules = (question && question.jump_rules) || [];

  for (const rule of rules) {
    if (condition_matches(rule.condition, question, answer)) {
      return {
        matched: true,
        target: rule.targetQuestionId === undefined ? null : rule.targetQuestionId,
      };
    }
  }

  return { matched: false, target: null };
}

module.exports = {
  condition_matches,
  resolve_next_question,
};

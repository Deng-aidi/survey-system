/**
 * 题目与跳转规则校验工具
 * 独立于路由，便于 F2/F3 复用
 *
 * 三个函数：
 *   validateQuestionInput(body)          —— Q1 添加题时的格式校验
 *   validateJumpRulesExist(survey, rules) —— Q2 修改 jump_rules 时仅校验存在性
 *   validate_all_jump_rules_for_publish(survey) —— S5 发布时完整校验（存在性+向前+无环）
 */

// ─────────────────────────────────────────────
// Q1：添加题目的格式校验
// 返回 { valid: boolean, errors: string[] }
// ─────────────────────────────────────────────
function validateQuestionInput(body) {
  const errors = [];
  const { type, title, required, options, validation } = body;

  // type 必填且合法
  const allowedTypes = ['single_choice', 'multiple_choice', 'text', 'number'];
  if (!type || !allowedTypes.includes(type)) {
    errors.push(`type 必须是 ${allowedTypes.join(' / ')}`);
    return { valid: false, errors };
  }

  // title 必填
  if (!title || typeof title !== 'string' || !title.trim()) {
    errors.push('title 必填');
    return { valid: false, errors };
  }

  // required 必须是布尔（不填默认 false 由路由层处理，这里只校验类型）
  if (required !== undefined && typeof required !== 'boolean') {
    errors.push('required 必须是布尔值');
  }

  // choice 题型：options 非空且 label 唯一
  if (type === 'single_choice' || type === 'multiple_choice') {
    if (!Array.isArray(options) || options.length === 0) {
      errors.push('选项题型必须提供非空 options 数组');
    } else {
      const labels = new Set();
      const values = new Set();
      for (const opt of options) {
        if (!opt.label || typeof opt.label !== 'string') {
          errors.push('每个选项必须有 label');
        } else {
          // 判重时归一化（trim + toLowerCase），存储仍保留原始 label
          // 中文尾空格、英文大小写都视为重复
          const normalized = opt.label.trim().toLowerCase();
          if (labels.has(normalized)) {
            errors.push(`选项 label 重复：${opt.label}`);
          }
          labels.add(normalized);
        }
        // value 必须是非空字符串，同一题内 value 唯一
        if (!opt.value || typeof opt.value !== 'string' || !opt.value.trim()) {
          errors.push('每个选项必须有 value（非空字符串）');
        } else {
          const valueKey = opt.value.trim().toLowerCase();
          if (values.has(valueKey)) {
            errors.push(`选项 value 重复：${opt.value}`);
          }
          values.add(valueKey);
        }
      }
    }
  }

  // multiple_choice：min_choices ≤ max_choices ≤ options.length
  if (type === 'multiple_choice' && validation) {
    const { min_choices, max_choices } = validation;
    if (min_choices !== undefined && max_choices !== undefined) {
      if (min_choices > max_choices) {
        errors.push('multiple_choice: min_choices 不能大于 max_choices');
      }
    }
    if (max_choices !== undefined && options) {
      if (max_choices > options.length) {
        errors.push('multiple_choice: max_choices 不能大于选项数量');
      }
    }
    // min_choices 也不能大于选项数量，否则永远无法满足"至少选 N 个"
    if (min_choices !== undefined && options) {
      if (min_choices > options.length) {
        errors.push('multiple_choice: min_choices 不能大于选项数量');
      }
    }
  }

  // text：min_length ≤ max_length
  if (type === 'text' && validation) {
    const { min_length, max_length } = validation;
    if (min_length !== undefined && max_length !== undefined) {
      if (min_length > max_length) {
        errors.push('text: min_length 不能大于 max_length');
      }
    }
  }

  // number：min ≤ max
  if (type === 'number' && validation) {
    const { min, max } = validation;
    if (min !== undefined && max !== undefined) {
      if (min > max) {
        errors.push('number: min 不能大于 max');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────
// Q2：修改 jump_rules 时仅校验 targetQuestionId 存在性
// 不校验向前和循环（留给 S5 发布时统一做）
// 返回 errors 数组（空数组 = 通过）
// ─────────────────────────────────────────────
function validateJumpRulesExist(survey, jumpRules) {
  const errors = [];
  if (!Array.isArray(jumpRules)) {
    errors.push('jump_rules 必须是数组');
    return errors;
  }
  // [] 直接通过并清空
  if (jumpRules.length === 0) return errors;

  const questionIds = new Set((survey.questions || []).map((q) => q._id.toString()));

  const allowedOperators = ['equals', 'includes', 'gte', 'lte', 'eq', 'between'];

  for (const rule of jumpRules) {
    // 每条 rule 必须有 condition 对象
    if (!rule || typeof rule !== 'object' || !rule.condition || typeof rule.condition !== 'object') {
      errors.push('每条跳转规则必须有 condition 对象');
      continue;
    }
    // condition.operator 必须在枚举内
    if (!allowedOperators.includes(rule.condition.operator)) {
      errors.push(`跳转规则 operator 非法：${rule.condition.operator}，必须是 ${allowedOperators.join(' / ')}`);
    }
    // condition.value 必须存在
    if (rule.condition.value === undefined) {
      errors.push('跳转规则 condition.value 必填');
    }

    const target = rule.targetQuestionId;
    // target 为 null 或 undefined 合法（跳到结束）
    if (target === null || target === undefined) continue;
    const targetStr = target.toString();
    if (!questionIds.has(targetStr)) {
      errors.push(`跳转规则引用的题目 ${targetStr} 不存在`);
    }
  }
  return errors;
}

// ─────────────────────────────────────────────
// S5：发布时完整校验
// ① 每个 targetQuestionId 存在或为 null
// ② target.order > current.order（不允许回跳）
// ③ 规则图无环（DFS）
// 返回 errors 数组
// ─────────────────────────────────────────────
function validate_all_jump_rules_for_publish(survey) {
  const errors = [];
  const questions = survey.questions || [];
  const questionIds = new Set(questions.map((q) => q._id.toString()));
  const questionMap = new Map(questions.map((q) => [q._id.toString(), q]));

  // ① 存在性 + ② 向前
  for (const q of questions) {
    const rules = q.jump_rules || [];
    for (const rule of rules) {
      const target = rule.targetQuestionId;
      // null = 跳到结束，合法
      if (target === null || target === undefined) continue;

      const targetStr = target.toString();
      if (!questionIds.has(targetStr)) {
        errors.push({
          question_id: q._id.toString(),
          reason: `跳转规则引用的题目 ${targetStr} 不存在`,
        });
        continue;
      }
      const targetQ = questionMap.get(targetStr);
      if (targetQ.order <= q.order) {
        errors.push({
          question_id: q._id.toString(),
          reason: `不允许回跳：targetQuestionId(${targetStr}) 的 order(${targetQ.order}) 必须大于当前题 order(${q.order})`,
        });
      }
    }
  }

  // ③ 无环检测
  // 图：节点 = 题目 _id；边 = 每条 jump_rule 的 current → target（target=null 指向 END，不建边）
  //      + 默认边 current → order+1（无规则匹配时走默认顺序）
  // DFS 从 order 最小的题出发，遇到已访问节点即判环
  const sortedQs = [...questions].sort((a, b) => a.order - b.order);
  if (sortedQs.length > 0) {
    // 建邻接表
    const adj = new Map();
    for (const q of questions) {
      const qid = q._id.toString();
      adj.set(qid, new Set());
      // jump_rules 所有非 null target
      for (const rule of q.jump_rules || []) {
        if (rule.targetQuestionId !== null && rule.targetQuestionId !== undefined) {
          adj.get(qid).add(rule.targetQuestionId.toString());
        }
      }
      // 默认边 current → order+1
      const idx = sortedQs.findIndex((x) => x._id.toString() === qid);
      if (idx >= 0 && idx + 1 < sortedQs.length) {
        adj.get(qid).add(sortedQs[idx + 1]._id.toString());
      }
    }

    // DFS 检测环
    const visited = new Set();
    function dfs(node, path) {
      if (path.has(node)) return node; // 找到环
      if (visited.has(node)) return null;
      visited.add(node);
      path.add(node);
      const neighbors = adj.get(node) || new Set();
      for (const next of neighbors) {
        const cycle = dfs(next, path);
        if (cycle) return cycle;
      }
      path.delete(node);
      return null;
    }

    const cycleNode = dfs(sortedQs[0]._id.toString(), new Set());
    if (cycleNode) {
      errors.push({
        reason: `检测到跳转循环：节点 ${cycleNode} 可通过规则图回到自身`,
      });
    }
  }

  return errors;
}

// ─────────────────────────────────────────────
// F2/F3：单题答案校验
// question 为 surveys.questions[] 子文档，answer 为提交的答案
// 返回 { valid: boolean, errors: string[] }
// ─────────────────────────────────────────────
function validateAnswer(question, answer) {
  const errors = [];
  if (!question) {
    return { valid: false, errors: ['题目不存在'] };
  }

  const { type, required, options, validation } = question;

  // 空答案判定：undefined / null / 空字符串 / 空数组
  const isEmpty =
    answer === undefined ||
    answer === null ||
    (typeof answer === 'string' && answer.trim() === '') ||
    (Array.isArray(answer) && answer.length === 0);

  if (isEmpty) {
    if (required) errors.push('本题必答');
    return { valid: errors.length === 0, errors };
  }

  if (type === 'single_choice') {
    if (typeof answer !== 'string') {
      errors.push('单选题答案必须是选项 value 字符串');
    } else {
      const values = (options || []).map((o) => o.value);
      if (!values.includes(answer)) {
        errors.push(`答案不在选项范围内：${answer}`);
      }
    }
  } else if (type === 'multiple_choice') {
    if (!Array.isArray(answer)) {
      errors.push('多选题答案必须是数组');
    } else {
      const values = (options || []).map((o) => o.value);
      const seen = new Set();
      for (const v of answer) {
        if (typeof v !== 'string') {
          errors.push('多选题答案的每个元素必须是选项 value 字符串');
          continue;
        }
        if (!values.includes(v)) {
          errors.push(`答案不在选项范围内：${v}`);
        }
        if (seen.has(v)) {
          errors.push(`多选题答案重复：${v}`);
        }
        seen.add(v);
      }
      if (validation) {
        const { min_choices, max_choices } = validation;
        if (min_choices !== undefined && answer.length < min_choices) {
          errors.push(`至少选择 ${min_choices} 项`);
        }
        if (max_choices !== undefined && answer.length > max_choices) {
          errors.push(`最多选择 ${max_choices} 项`);
        }
      }
    }
  } else if (type === 'text') {
    if (typeof answer !== 'string') {
      errors.push('文本题答案必须是字符串');
    } else if (validation) {
      const { min_length, max_length } = validation;
      if (min_length !== undefined && answer.length < min_length) {
        errors.push(`文本长度不能少于 ${min_length} 个字符`);
      }
      if (max_length !== undefined && answer.length > max_length) {
        errors.push(`文本长度不能超过 ${max_length} 个字符`);
      }
    }
  } else if (type === 'number') {
    if (typeof answer !== 'number' || !Number.isFinite(answer)) {
      errors.push('数字题答案必须是有效数字');
    } else if (validation) {
      const { min, max, integer } = validation;
      // integer=true 时必须为整数（AC7）
      if (integer === true && !Number.isInteger(answer)) {
        errors.push('答案必须是整数');
      }
      if (min !== undefined && answer < min) {
        errors.push(`答案不能小于 ${min}`);
      }
      if (max !== undefined && answer > max) {
        errors.push(`答案不能大于 ${max}`);
      }
    }
  } else {
    errors.push(`未知题型：${type}`);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateQuestionInput,
  validateJumpRulesExist,
  validate_all_jump_rules_for_publish,
  validateAnswer,
};

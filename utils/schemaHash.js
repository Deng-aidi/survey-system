/**
 * 题面指纹：type + options + validation 的规范化 JSON 的 MD5。
 *
 * 用途：surveys.questions 是题库题的深拷贝，用户在草稿里改选项 label
 * （甚至改 value / validation）后，快照与题库、快照与快照之间会出现
 * schema 分叉。统计按该指纹分组，避免把语义不同的数据合并。
 */
const crypto = require('crypto');

// 递归按 key 排序，保证同样的对象得到同样的 JSON 字符串
function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeys(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function computeSchemaHash(type, options, validation) {
  const canonical = sortKeys({
    type: type || null,
    // 选项顺序属于题面定义，保留数组顺序；只固定对象 key 顺序
    options: (options || []).map((o) => ({ label: o.label, value: o.value })),
    validation: validation || {},
  });

  return crypto.createHash('md5').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = { computeSchemaHash };

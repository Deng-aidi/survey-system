const mongoose = require('mongoose');

// 先建空壳 schema，后续 F2/F3 填写+提交模块再补完整字段
// 当前仅用于 Survey 删除时的应用层级联删除
const submissionSchema = new mongoose.Schema({}, { strict: false });

module.exports = mongoose.model('Submission', submissionSchema);

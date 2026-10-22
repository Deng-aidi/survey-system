const mongoose = require('mongoose');

// ── 答案子文档 ──
// answer 用 Mixed 承载四种题型形态：single_choice→string、multiple_choice→string[]、text→string、number→number
// question_type 冗余存储，统计聚合时无需关联 surveys 取题型
const answerSchema = new mongoose.Schema(
  {
    question_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    question_type: {
      type: String,
      required: true,
      enum: ['single_choice', 'multiple_choice', 'text', 'number'],
    },
    answer: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { _id: false }
);

// ── 主 schema ──
// user_id 允许 null：匿名填写
// started_at/submitted_at 由 F3 提交时写入（当前实现二者相同）
const submissionSchema = new mongoose.Schema({
  survey_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Survey',
    required: [true, 'survey_id 必填'],
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  started_at: {
    type: Date,
    required: [true, 'started_at 必填'],
  },
  submitted_at: {
    type: Date,
    required: [true, 'submitted_at 必填'],
  },
  answers: {
    type: [answerSchema],
    default: [],
  },
});

module.exports = mongoose.model('Submission', submissionSchema);

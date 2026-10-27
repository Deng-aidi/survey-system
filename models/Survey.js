const mongoose = require('mongoose');
const crypto = require('crypto');

// ── 选项子文档 ──
const optionSchema = new mongoose.Schema({
  label: { type: String, required: true },
  value: { type: String, required: true },
}, { _id: true });

// ── 跳转规则子文档 ──
const jumpRuleSchema = new mongoose.Schema({
  condition: {
    operator: { type: String, required: true, enum: ['equals', 'includes', 'gte', 'lte', 'eq', 'between'] },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  targetQuestionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Survey.questions',
    default: null, // null = 跳到问卷结束
  },
}, { _id: false });

// ── 题目子文档 ──
const questionSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['single_choice', 'multiple_choice', 'text', 'number'] },
  title: { type: String, required: true, maxlength: 200 },
  order: { type: Number, required: true, default: 0 },
  required: { type: Boolean, required: true, default: false },
  options: [optionSchema],
  validation: { type: mongoose.Schema.Types.Mixed, default: {} },
  jump_rules: [jumpRuleSchema],

  // ── 第二阶段：快照来源（旧数据为 null，视为独立内嵌题）──
  source_question_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', default: null },
  source_version: { type: Number, default: null },
  snapshot_at: { type: Date, default: null },
}, { _id: true });

// ── 主 schema ──
const surveySchema = new mongoose.Schema(
  {
    url_token: {
      type: String,
      required: [true, 'url_token 生成失败'],
      unique: true,
      index: true,
    },
    creator_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, '创建者不能为空'],
      index: true,
    },
    title: {
      type: String,
      required: [true, '问卷标题不能为空'],
      trim: true,
      maxlength: [100, '标题最多 100 字符'],
    },
    description: {
      type: String,
      default: '',
      maxlength: [1000, '说明最多 1000 字符'],
    },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'open', 'closed'],
      index: true,
    },
    allow_anonymous: {
      type: Boolean,
      required: true,
      default: false,
    },
    deadline: {
      type: Date,
      default: null,
    },
    // ── 第二阶段：首次发布时间，只写不清，作为结构锁定标志 ──
    published_at: {
      type: Date,
      default: null,
    },
    questions: [questionSchema],
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    // versionKey 默认就是 __v，保留用于乐观锁
  }
);

// ── 索引 ──
// creator_id + status 复合索引（按状态过滤的列表查询）
surveySchema.index({ creator_id: 1, status: 1 });

// ── 静态方法：生成唯一 url_token（冲突重试一次）──
surveySchema.statics.generateUrlToken = async function generateUrlToken() {
  // 16 位十六进制 = crypto.randomBytes(8).toString('hex')
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomBytes(8).toString('hex');
    const exists = await this.findOne({ url_token: token });
    if (!exists) return token;
  }
  // 极罕见情况（两次都冲突），加时间戳后缀
  return crypto.randomBytes(6).toString('hex') + Date.now().toString(16).slice(-4);
};

// ── 应用层级联删除 submissions ──
surveySchema.pre('deleteOne', { document: true, query: false }, async function cascadeDeleteSubmissions() {
  const Submission = mongoose.model('Submission');
  const result = await Submission.deleteMany({ survey_id: this._id });
  if (result.deletedCount > 0) {
    console.log(`[Survey.deleteOne] 级联删除了 ${result.deletedCount} 条 submissions`);
  }
});

// pre('remove') 已废弃，用 pre('deleteOne', { document: true })
// Survey.findOne({_id}).remove() 或 survey.deleteOne() 都会触发这个 hook

module.exports = mongoose.model('Survey', surveySchema);

/**
 * 题库题（Question）—— 第二阶段新增集合
 *
 * 设计要点：
 * 1. 版本链：root_id 串起 v1 → v2 → v3；parent_id 指向上游版本；
 * 2. 追加式：任何修改都生成新文档，旧版本文档永不 UPDATE / DELETE；
 * 3. 只存题面语义（type/title/options/validation），
 *    order / required / jump_rules 属于问卷上下文，不进题库；
 * 4. {root_id, version} 唯一索引用于并发防重。
 */
const mongoose = require('mongoose');

// ── 选项子文档（与 surveys 内嵌题保持一致的结构）──
const optionSchema = new mongoose.Schema({
  label: { type: String, required: true },
  value: { type: String, required: true },
}, { _id: true });

// ── 题库题 ──
const questionSchema = new mongoose.Schema(
  {
    creator_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, '创建者不能为空'],
    },
    // 版本链根节点；首个版本的 root_id 等于自身 _id
    root_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: [true, 'root_id 不能为空'],
    },
    // 上一版本；根版本为 null
    parent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      default: null,
    },
    version: {
      type: Number,
      required: true,
      min: [1, 'version 从 1 开始'],
      default: 1,
    },
    type: {
      type: String,
      required: true,
      enum: ['single_choice', 'multiple_choice', 'text', 'number'],
    },
    title: {
      type: String,
      required: [true, '题干不能为空'],
      trim: true,
      maxlength: [200, '题干最多 200 字符'],
    },
    options: [optionSchema],
    validation: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    // 公开给所有登录用户
    is_shared: {
      type: Boolean,
      required: true,
      default: false,
    },
    // 定向共享：共享不授予编辑权，仅授予读 + 使用
    shared_with: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'User',
      default: [],
    },
    // 软归档；不做物理删除，保证版本链完整
    archived_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    // 关闭 Mongoose 默认的 __v，避免与业务字段 version 混淆
    versionKey: false,
  }
);

// ── 索引 ──
// 版本链防重：并发创建新版本时，重复 (root_id, version) 会抛 E11000
questionSchema.index({ root_id: 1, version: 1 }, { unique: true });
// "我的题库"列表
questionSchema.index({ creator_id: 1, updated_at: -1 });
// 共享筛选
questionSchema.index({ is_shared: 1 });
questionSchema.index({ shared_with: 1 });

module.exports = mongoose.model('Question', questionSchema);

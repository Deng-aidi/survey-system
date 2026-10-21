const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, '用户名不能为空'],
      unique: true,
      trim: true,
      minlength: [2, '用户名至少 2 个字符'],
      maxlength: [32, '用户名最多 32 个字符'],
    },
    password: {
      type: String,
      required: [true, '密码不能为空'],
      // Schema 层只做基础长度约束，**不做明文复杂度正则**
      // 原因：bcrypt 哈希后是 $2a$... 格式，包含特殊字符，
      // 如果在这里加 /^[A-Za-z\d]+$/ 之类的正则，
      // 哈希后的密码会永远通不过校验（经验教训 423631）
      minlength: [6, '密码至少 6 个字符（哈希后会更长）'],
      // maxlength 设 72：bcrypt 只取前 72 字节，避免无意义的超长输入
      maxlength: [72, '原始密码最多 72 个字符'],
      select: false, // 默认查询不返回密码
    },
    created_at: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  {
    versionKey: false, // 用户模型不需要乐观锁
    toJSON: {
      transform(doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── pre('save') hook：自动哈希密码 ──
// 纯 async 写法，Mongoose 会自动捕获异常并传给 next
// 只在 password 被修改时执行，避免对已哈希值重复哈希
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  // 防御：如果已经是 bcrypt 哈希（以 $2a$ 或 $2b$ 或 $2y$ 开头），跳过
  if (typeof this.password === 'string' && this.password.startsWith('$2')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// ── 实例方法：验证密码 ──
userSchema.methods.comparePassword = async function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── 索引 ──
// username 唯一索引（Schema 已设置 unique: true，Mongoose 会自动建）

module.exports = mongoose.model('User', userSchema);

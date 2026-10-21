const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authenticate = require('../middleware/auth');

const router = express.Router();

/**
 * @route  POST /api/auth/register
 * @desc   新用户注册
 * @access Public
 */
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    // ── 格式校验（路由层做，Mongoose ValidationError 兜底）──
    if (!username || typeof username !== 'string') {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: 'username 必填且必须是字符串',
      });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: 'password 必填且必须是字符串',
      });
    }

    // ── 明文密码复杂度校验（必须在哈希前做）──
    if (password.length < 6) {
      return res.status(400).json({
        code: 'INVALID_PASSWORD',
        message: '密码至少 6 个字符',
      });
    }
    if (password.length > 72) {
      return res.status(400).json({
        code: 'INVALID_PASSWORD',
        message: '原始密码最多 72 个字符',
      });
    }

    // ── 创建用户 ──
    // password 此时是明文，pre('save') hook 会自动哈希
    const user = new User({ username, password });
    await user.save();

    // toJSON transform 自动剔除 password
    res.status(201).json({
      _id: user._id,
      username: user.username,
      created_at: user.created_at,
    });
  } catch (err) {
    // Mongoose 唯一索引冲突 → 409（只判断 code===11000，不过度依赖 keyPattern）
    if (err.code === 11000) {
      return res.status(409).json({
        code: 'DUPLICATE_USERNAME',
        message: '用户名已存在，请换一个',
      });
    }

    // Mongoose ValidationError → 400
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: Object.values(err.errors)
          .map((e) => e.message)
          .join('; '),
      });
    }

    // 其他未知错误
    console.error('[register] unexpected error:', err);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请稍后重试',
    });
  }
});

/**
 * @route  POST /api/auth/login
 * @desc   用户登录，返回 JWT
 * @access Public
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        code: 'MALFORMED_REQUEST',
        message: 'username 和 password 均必填',
      });
    }

    // password 默认 select: false，必须显式 +password 才能查出来
    const user = await User.findOne({ username }).select('+password');

    if (!user) {
      // 统一模糊错误，不暴露"用户不存在"还是"密码错"（轻微安全考虑）
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: '用户名或密码错误',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: '用户名或密码错误',
      });
    }

    // ── 签发 JWT ──
    const token = jwt.sign(
      { _id: user._id.toString(), username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.status(200).json({
      token,
      user: {
        _id: user._id,
        username: user.username,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('[login] unexpected error:', err);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请稍后重试',
    });
  }
});

/**
 * @route  GET /api/auth/me
 * @desc   获取当前登录用户信息
 * @access Private（需 JWT）
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    // req.user 是 auth 中间件解密 JWT 后挂的 { _id, username }
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        code: 'USER_NOT_FOUND',
        message: '用户不存在',
      });
    }

    // toJSON transform 自动剔除 password
    res.status(200).json(user);
  } catch (err) {
    console.error('[me] unexpected error:', err);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请稍后重试',
    });
  }
});

module.exports = router;

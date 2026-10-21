const jwt = require('jsonwebtoken');

/**
 * JWT 验证中间件
 * 从 Authorization: Bearer <token> 里取出 token，验签后挂载到 req.user
 */
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      code: 'MISSING_TOKEN',
      message: '缺少 Authorization: Bearer <token> 头',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded 结构：{ _id: '...', username: '...', iat: ..., exp: ... }
    req.user = { _id: decoded._id, username: decoded.username };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        code: 'TOKEN_EXPIRED',
        message: '登录已过期，请重新登录',
      });
    }
    return res.status(401).json({
      code: 'INVALID_TOKEN',
      message: 'token 无效',
    });
  }
}

module.exports = authenticate;

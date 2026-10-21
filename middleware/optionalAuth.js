const jwt = require('jsonwebtoken');

/**
 * 可选鉴权中间件（填写端专用）
 * 有 Authorization: Bearer <token> 就验签并挂载 req.user；
 * 没有该头则直接放行（按匿名处理），不返回 401。
 *
 * 注意：token 无效/过期时也按匿名放行，不在这里报错。
 * 问卷是否允许匿名由路由层的 allow_anonymous 判断决定。
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // 与 authenticate 保持一致：decoded._id 是字符串
    req.user = { _id: decoded._id, username: decoded.username };
  } catch (err) {
    // 可选鉴权：验签失败不阻断，按未登录处理
  }

  next();
}

module.exports = optionalAuth;

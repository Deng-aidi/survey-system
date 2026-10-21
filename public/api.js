// 统一 API 封装：同源请求 /api/**，自动携带 JWT
// 用法：API.get/post/patch/del(path, body?)，抛出的 Error 带 code/message/errors/status
(function () {
  const TOKEN_KEY = 'token';
  const USERNAME_KEY = 'username';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function setAuth(token, username) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USERNAME_KEY, username);
  }

  function getUsername() {
    return localStorage.getItem(USERNAME_KEY) || '';
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
  }

  async function request(path, options) {
    options = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(path, Object.assign({}, options, { headers: headers }));

    // 401：清登录态并跳回登录页
    if (res.status === 401) {
      clearAuth();
      window.location.href = 'index.html';
      const err401 = new Error('未登录或登录已过期');
      err401.code = 'UNAUTHORIZED';
      err401.status = 401;
      throw err401;
    }

    let data = null;
    if (res.status !== 204) {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
    }

    if (!res.ok) {
      const err = new Error((data && data.message) || '请求失败（' + res.status + '）');
      err.code = (data && data.code) || 'UNKNOWN';
      err.errors = (data && data.errors) || null;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toBody(body) {
    return body === undefined ? undefined : JSON.stringify(body);
  }

  window.API = {
    getToken: getToken,
    setAuth: setAuth,
    getUsername: getUsername,
    clearAuth: clearAuth,
    request: request,
    get: function (path) { return request(path, { method: 'GET' }); },
    post: function (path, body) { return request(path, { method: 'POST', body: toBody(body) }); },
    patch: function (path, body) { return request(path, { method: 'PATCH', body: toBody(body) }); },
    del: function (path) { return request(path, { method: 'DELETE' }); },
  };
})();

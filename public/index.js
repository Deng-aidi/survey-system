// 登录/注册页：tab 切换 + 提交
(function () {
  // 已登录直接进列表页
  if (API.getToken()) {
    window.location.href = 'surveys.html';
    return;
  }

  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const formLogin = document.getElementById('form-login');
  const formRegister = document.getElementById('form-register');
  const msg = document.getElementById('msg');

  function showMsg(text, ok) {
    msg.textContent = text;
    msg.className = 'msg ' + (ok ? 'ok' : 'error');
  }

  function switchTab(toLogin) {
    tabLogin.classList.toggle('active', toLogin);
    tabRegister.classList.toggle('active', !toLogin);
    formLogin.classList.toggle('hidden', !toLogin);
    formRegister.classList.toggle('hidden', toLogin);
    showMsg('', true);
  }

  tabLogin.addEventListener('click', function () { switchTab(true); });
  tabRegister.addEventListener('click', function () { switchTab(false); });

  formLogin.addEventListener('submit', async function (e) {
    e.preventDefault();
    showMsg('', true);
    try {
      const data = await API.post('/api/auth/login', {
        username: document.getElementById('login-username').value.trim(),
        password: document.getElementById('login-password').value,
      });
      // 登录成功：存 token + username，跳列表页
      API.setAuth(data.token, data.user.username);
      window.location.href = 'surveys.html';
    } catch (err) {
      if (err.status !== 401) showMsg(err.message || '登录失败');
    }
  });

  formRegister.addEventListener('submit', async function (e) {
    e.preventDefault();
    showMsg('', true);
    try {
      await API.post('/api/auth/register', {
        username: document.getElementById('reg-username').value.trim(),
        password: document.getElementById('reg-password').value,
      });
      // 注册成功：提示并切回登录 tab
      showMsg('注册成功，请登录', true);
      switchTab(true);
    } catch (err) {
      showMsg(err.message || '注册失败');
    }
  });
})();

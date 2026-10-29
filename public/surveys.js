// 我的问卷列表页：加载列表 + 创建问卷 + 行内操作
(function () {
  // 未登录直接回登录页
  if (!API.getToken()) {
    window.location.href = 'index.html';
    return;
  }

  const STATUS_TEXT = { draft: '草稿', open: '已发布', closed: '已关闭' };

  const listEl = document.getElementById('survey-list');
  const msg = document.getElementById('msg');

  document.getElementById('who').textContent = '当前用户：' + API.getUsername();

  document.getElementById('btn-logout').addEventListener('click', function () {
    API.clearAuth();
    window.location.href = 'index.html';
  });

  function showMsg(text, ok) {
    msg.textContent = text;
    msg.className = 'msg ' + (ok ? 'ok' : 'error');
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('zh-CN');
  }

  function makeButton(text, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function appendCell(tr, text) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  async function copyLink(survey) {
    const link = window.location.origin + '/fill.html?token=' + survey.url_token;
    try {
      await navigator.clipboard.writeText(link);
      showMsg('已复制：' + link, true);
    } catch (e) {
      // clipboard API 失败时退化为手动复制
      window.prompt('复制失败，请手动复制：', link);
    }
  }

  async function loadList() {
    const surveys = await API.get('/api/surveys');
    listEl.innerHTML = '';

    if (!surveys.length) {
      const tr = document.createElement('tr');
      const td = appendCell(tr, '还没有问卷，先创建一个吧');
      td.colSpan = 5;
      listEl.appendChild(tr);
      return;
    }

    for (const s of surveys) {
      const tr = document.createElement('tr');
      appendCell(tr, s.title);
      const statusTd = document.createElement('td');
      const statusBadge = document.createElement('span');
      statusBadge.className = 'status-badge ' + (s.status || 'draft');
      statusBadge.textContent = STATUS_TEXT[s.status] || s.status;
      statusTd.appendChild(statusBadge);
      tr.appendChild(statusTd);
      appendCell(tr, String(s.question_count));
      appendCell(tr, fmtTime(s.created_at));

      const tdOps = document.createElement('td');
      tdOps.appendChild(makeButton('编辑', function () {
        window.location.href = 'edit.html?surveyId=' + s._id;
      }));
      tdOps.appendChild(makeButton('统计', function () {
        window.location.href = 'stats.html?surveyId=' + s._id;
      }));
      tdOps.appendChild(makeButton('复制链接', function () { copyLink(s); }));
      tr.appendChild(tdOps);

      listEl.appendChild(tr);
    }
  }

  document.getElementById('form-create').addEventListener('submit', async function (e) {
    e.preventDefault();
    showMsg('', true);
    try {
      await API.post('/api/surveys', {
        title: document.getElementById('c-title').value.trim(),
        description: document.getElementById('c-desc').value,
        allow_anonymous: document.getElementById('c-anon').checked,
      });
      showMsg('创建成功', true);
      e.target.reset();
      await loadList();
    } catch (err) {
      showMsg(err.message || '创建失败');
    }
  });

  loadList().catch(function (err) {
    if (err.status !== 401) showMsg(err.message || '加载失败');
  });
})();

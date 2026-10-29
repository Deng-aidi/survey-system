// 题库管理页：创建题目、列表、生成新版本、共享设置、版本历史与恢复
// 依赖 api.js（自动携带 JWT）
(function () {
  if (!API.getToken()) {
    window.location.href = 'index.html';
    return;
  }

  var TYPE_LABEL = {
    single_choice: '单选',
    multiple_choice: '多选',
    text: '文本',
    number: '数字',
  };

  // mode: 'mine' = GET /api/questions；'shared' = GET /api/questions/shared
  var state = {
    mode: 'mine',
    editingId: null,
    sharingId: null,
    versionsQuestionId: null,
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    return new Date(iso).toLocaleString('zh-CN');
  }

  var msg = $('msg');
  function showMsg(text, isError) {
    msg.textContent = text || '';
    msg.className = 'msg ' + (isError ? 'error' : 'ok');
  }

  $('who').textContent = '当前用户：' + API.getUsername();
  $('btn-logout').addEventListener('click', function () {
    API.clearAuth();
    window.location.href = 'index.html';
  });

  // ─────────────────────────────────────────────
  // 列表
  // ─────────────────────────────────────────────
  var listEl = $('question-list');
  var btnShared = $('btn-shared');

  function textCell(tr, text) {
    var td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function actionButton(text, handler) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', handler);
    return btn;
  }

  async function loadList() {
    try {
      var items = state.mode === 'shared'
        ? await API.get('/api/questions/shared')
        : await API.get('/api/questions');
      renderList(items);
    } catch (err) {
      showMsg(err.message || '加载题库失败', true);
    }
  }

  function renderList(items) {
    listEl.innerHTML = '';

    if (!items.length) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.innerHTML = state.mode === 'shared'
        ? '<div class="empty-state">还没有人共享题目给你<div class="empty-guide">同事把题设为公开或定向共享给你后，会出现在这里</div></div>'
        : '<div class="empty-state">题库还是空的<div class="empty-guide">先创建一道题，之后可跨问卷复用、生成版本并追踪引用</div></div>';
      emptyRow.appendChild(emptyCell);
      listEl.appendChild(emptyRow);
      return;
    }

    items.forEach(function (q) {
      var tr = document.createElement('tr');
      textCell(tr, q.title);
      textCell(tr, TYPE_LABEL[q.type] || q.type);
      textCell(tr, 'v' + q.version);

      var ops = document.createElement('td');
      if (state.mode === 'mine') {
        ops.appendChild(actionButton('编辑并生成新版本', function () { openEditor(q); }));
        ops.appendChild(actionButton('共享设置', function () { openSharing(q); }));
        ops.appendChild(actionButton('查看版本历史', function () { openVersions(q); }));
        ops.appendChild(actionButton('跨卷统计', function () { openStats(q); }));

        // 引用追踪徽章：被多少份问卷使用（仅自己的题可调用 usages）
        var badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'usage-badge';
        badge.textContent = '被 ? 份问卷使用';
        badge.title = '点击查看哪些问卷引用了这道题';
        badge.addEventListener('click', function () { openUsages(q); });
        ops.appendChild(badge);
        loadUsageCount(q._id, badge);
      } else {
        ops.textContent = '创建者：' + q.creator_id;
      }
      tr.appendChild(ops);
      listEl.appendChild(tr);
    });
  }

  btnShared.addEventListener('click', function () {
    state.mode = state.mode === 'mine' ? 'shared' : 'mine';
    btnShared.textContent = state.mode === 'mine' ? '可见共享题' : '返回我的题库';
    showMsg('', true);
    loadList();
  });

  // ─────────────────────────────────────────────
  // 创建 / 编辑（生成新版本）
  // ─────────────────────────────────────────────
  var editor = $('editor');
  var editorTitle = $('editor-title');
  var qType = $('q-type');
  var qTitle = $('q-title');
  var optionsEl = $('q-options');

  function addOptionRow(label, value) {
    var row = document.createElement('div');
    row.className = 'option-row';

    var labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'opt-label';
    labelInput.placeholder = '展示文本 label';
    labelInput.value = label || '';

    var valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.className = 'opt-value';
    valueInput.placeholder = '统计值 value';
    valueInput.value = value || '';

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'opt-del secondary outline';
    del.textContent = '删除';
    del.addEventListener('click', function () { row.remove(); });

    row.appendChild(labelInput);
    row.appendChild(valueInput);
    row.appendChild(del);
    optionsEl.appendChild(row);
  }

  function collectOptions() {
    var rows = optionsEl.querySelectorAll('.option-row');
    var options = [];
    rows.forEach(function (row) {
      var label = row.querySelector('.opt-label').value.trim();
      var value = row.querySelector('.opt-value').value.trim();
      if (label && value) options.push({ label: label, value: value });
    });
    return options;
  }

  function setNum(obj, key, raw) {
    if (raw !== '') obj[key] = Number(raw);
  }

  function clearValidationInputs() {
    ['q-min-choices', 'q-max-choices', 'q-min-length', 'q-max-length', 'q-min', 'q-max'].forEach(function (id) {
      $(id).value = '';
    });
    $('q-integer').checked = false;
  }

  function fillValidation(v) {
    clearValidationInputs();
    v = v || {};
    ['min_choices', 'max_choices', 'min_length', 'max_length', 'min', 'max'].forEach(function (key) {
      var id = 'q-' + key.replace(/_/g, '-');
      if (v[key] !== undefined && v[key] !== null) $(id).value = v[key];
    });
    $('q-integer').checked = !!v.integer;
  }

  function collectValidation(type) {
    var v = {};
    if (type === 'multiple_choice') {
      setNum(v, 'min_choices', $('q-min-choices').value);
      setNum(v, 'max_choices', $('q-max-choices').value);
    } else if (type === 'text') {
      setNum(v, 'min_length', $('q-min-length').value);
      setNum(v, 'max_length', $('q-max-length').value);
    } else if (type === 'number') {
      setNum(v, 'min', $('q-min').value);
      setNum(v, 'max', $('q-max').value);
      if ($('q-integer').checked) v.integer = true;
    }
    return v;
  }

  function onTypeChange() {
    var t = qType.value;
    var isChoice = t === 'single_choice' || t === 'multiple_choice';
    $('q-fields-choice').classList.toggle('hidden', !isChoice);
    $('q-fields-multiple').classList.toggle('hidden', t !== 'multiple_choice');
    $('q-fields-text').classList.toggle('hidden', t !== 'text');
    $('q-fields-number').classList.toggle('hidden', t !== 'number');
  }

  function openEditor(q) {
    state.editingId = q ? q._id : null;
    editorTitle.textContent = q ? '编辑题目（保存后生成新版本）' : '创建新题';

    qType.value = q ? q.type : 'single_choice';
    qTitle.value = q ? q.title : '';

    optionsEl.innerHTML = '';
    var sourceOptions = q && q.options && q.options.length ? q.options : [null, null];
    sourceOptions.forEach(function (o) {
      addOptionRow(o ? o.label : '', o ? o.value : '');
    });

    fillValidation(q ? q.validation : {});
    onTypeChange();

    editor.classList.remove('hidden');
    editor.scrollIntoView({ behavior: 'smooth' });
  }

  function closeEditor() {
    state.editingId = null;
    editor.classList.add('hidden');
    optionsEl.innerHTML = '';
    qTitle.value = '';
    clearValidationInputs();
  }

  $('btn-new').addEventListener('click', function () { openEditor(null); });
  $('btn-cancel-edit').addEventListener('click', closeEditor);
  qType.addEventListener('change', onTypeChange);
  // 「添加选项」按钮：此前漏绑事件，点击无任何反应
  $('q-add-option').addEventListener('click', function () { addOptionRow(); });

  $('form-question').addEventListener('submit', async function (e) {
    e.preventDefault();

    var type = qType.value;
    var title = qTitle.value.trim();
    if (!title) {
      showMsg('题干必填', true);
      return;
    }

    var body = { type: type, title: title };

    if (type === 'single_choice' || type === 'multiple_choice') {
      body.options = collectOptions();
      if (body.options.length === 0) {
        showMsg('选择题至少需要一个完整选项（label + value）', true);
        return;
      }
    } else {
      body.options = [];
    }
    body.validation = collectValidation(type);

    try {
      if (state.editingId) {
        // 追加式版本链：基于被编辑版本生成新版本
        await API.post('/api/questions/' + state.editingId + '/versions', body);
        showMsg('已生成新版本');
      } else {
        await API.post('/api/questions', body);
        showMsg('题目已创建');
      }
      closeEditor();
      await loadList();
    } catch (err) {
      showMsg(err.message || '保存失败', true);
    }
  });

  // ─────────────────────────────────────────────
  // 共享设置
  // ─────────────────────────────────────────────
  var dlgSharing = $('dlg-sharing');

  function openSharing(q) {
    state.sharingId = q._id;
    $('sh-public').checked = !!q.is_shared;
    $('sh-users').value = (q.shared_with || []).join(' ');
    $('sharing-msg').textContent = '';
    $('sharing-msg').className = 'msg';
    dlgSharing.showModal();
  }

  $('form-sharing').addEventListener('submit', async function (e) {
    e.preventDefault();

    var raw = $('sh-users').value.trim();
    var ids = raw ? raw.split(/[\s,，]+/).filter(function (s) { return s.length > 0; }) : [];

    try {
      await API.patch('/api/questions/' + state.sharingId + '/sharing', {
        is_shared: $('sh-public').checked,
        shared_with: ids,
      });
      dlgSharing.close();
      showMsg('共享设置已保存');
      await loadList();
    } catch (err) {
      $('sharing-msg').textContent = err.message || '保存失败';
      $('sharing-msg').className = 'msg error';
    }
  });

  // ─────────────────────────────────────────────
  // 版本历史 / 恢复
  // ─────────────────────────────────────────────
  var dlgVersions = $('dlg-versions');
  var versionsList = $('versions-list');

  function renderVersions(chain) {
    if (!chain.length) {
      versionsList.innerHTML = '<p>暂无版本记录</p>';
      return;
    }
    var latest = chain.reduce(function (max, v) { return v.version > max ? v.version : max; }, 0);

    // parent_id -> version，用于展示“当下这版是从哪一版改来的”
    var versionById = {};
    chain.forEach(function (v) { versionById[String(v._id)] = v.version; });

    versionsList.innerHTML = '<div class="version-timeline">' + chain.map(function (v) {
      var isCurrent = v.version === latest;
      var parentVersion = v.parent_id ? versionById[String(v.parent_id)] : null;
      var origin = parentVersion ? ' <span class="version-origin">(源自 v' + parentVersion + ')</span>' : '';
      // 恢复旧版本 = 以旧内容生成一个新的链尾版本，历史不可篡改
      var restore = !isCurrent
        ? '<button type="button" data-restore="' + v._id + '"' +
          ' title="恢复不会覆盖当前版本，只会基于该旧版内容生成一个新版本（版本号为当前链上最大版本 +1）">基于此旧版生成新版</button>'
        : '<span class="meta">当前版本</span>';
      return '<div class="version-item' + (isCurrent ? ' current' : '') + '">' +
        '<div><strong>v' + v.version + '</strong> ' + esc(v.title) + origin +
        '<div class="version-meta">' + fmtTime(v.created_at) + '</div></div>' +
        restore +
        '</div>';
    }).join('') + '</div>';
  }

  async function refreshVersions(questionId) {
    try {
      var chain = await API.get('/api/questions/' + questionId + '/versions');
      // 接口返回升序；展示时按 v1 → v2 → v3 时间线
      renderVersions(chain);
    } catch (err) {
      $('versions-msg').textContent = err.message || '加载版本历史失败';
      $('versions-msg').className = 'msg error';
    }
  }

  function openVersions(q) {
    state.versionsQuestionId = q._id;
    versionsList.innerHTML = '';
    $('versions-msg').textContent = '';
    $('versions-msg').className = 'msg';
    dlgVersions.showModal();
    refreshVersions(q._id);
  }

  versionsList.addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-restore]');
    if (!btn) return;

    try {
      // 对旧版本 id 调用 restore：内容取该版本，parent 指向当前链尾
      await API.post('/api/questions/' + btn.getAttribute('data-restore') + '/restore');
      showMsg('已按该版本内容生成新版本');
      await loadList();
      await refreshVersions(state.versionsQuestionId);
    } catch (err) {
      $('versions-msg').textContent = err.message || '恢复失败';
      $('versions-msg').className = 'msg error';
    }
  });

  // ─────────────────────────────────────────────
  // 引用追踪：徽章计数 + 弹窗列表
  // ─────────────────────────────────────────────
  var dlgUsages = $('dlg-usages');
  var usagesBody = $('usages-body');
  var STATUS_BADGE = { draft: 'draft', open: 'open', closed: 'closed' };
  var STATUS_TEXT = { draft: '草稿', open: '已发布', closed: '已关闭' };

  async function loadUsageCount(questionId, badge) {
    try {
      var usages = await API.get('/api/questions/' + questionId + '/usages');
      badge.textContent = '被 ' + usages.length + ' 份问卷使用';
    } catch (err) {
      badge.textContent = '使用情况未知';
      badge.title = err.message || '加载失败';
    }
  }

  async function openUsages(q) {
    usagesBody.innerHTML = '<p class="hint">加载中…</p>';
    dlgUsages.showModal();
    try {
      var usages = await API.get('/api/questions/' + q._id + '/usages');
      if (!usages.length) {
        usagesBody.innerHTML = '<div class="empty-state">还没有问卷引用这道题<div class="empty-guide">在问卷编辑页点“从题库添加”即可生成快照引用</div></div>';
        return;
      }
      usagesBody.innerHTML = '<table class="striped"><thead><tr><th>问卷</th><th>状态</th><th>引用版本</th></tr></thead><tbody>' +
        usages.map(function (u) {
          var cls = STATUS_BADGE[u.status] || 'draft';
          return '<tr><td>' + esc(u.title) + '</td>' +
            '<td><span class="status-badge ' + cls + '">' + (STATUS_TEXT[u.status] || u.status) + '</span></td>' +
            '<td>v' + u.source_version + '</td></tr>';
        }).join('') + '</tbody></table>';
    } catch (err) {
      dlgUsages.close();
      alert(err.message || '加载引用情况失败');
    }
  }

  // ─────────────────────────────────────────────
  // 跨卷统计弹窗（仅创建者可调用 stats）
  // ─────────────────────────────────────────────
  var dlgStats = $('dlg-stats');
  var statsBody = $('stats-body');

  function renderAggregate(agg, type) {
    var html = '<p>有效答卷数：<strong>' + agg.answer_count + '</strong></p>';

    if (type === 'single_choice' || type === 'multiple_choice') {
      var counts = agg.option_counts || [];
      var max = counts.reduce(function (m, o) { return Math.max(m, o.count); }, 0);
      html += counts.map(function (o) {
        var pct = max > 0 ? Math.round((o.count / max) * 100) : 0;
        return '<div class="opt-row">' +
          '<span class="opt-label" title="' + esc(o.option_label) + '">' + esc(o.option_label) + '</span>' +
          '<div class="bar-wrap"><div class="bar bar-primary" style="width:' + pct + '%"></div></div>' +
          '<span class="opt-count">' + o.count + '</span></div>';
      }).join('');
      return html;
    }

    if (type === 'number') {
      var s = agg.stats || {};
      var fmt = function (n) { return n === null || n === undefined ? '-' : (Math.round(n * 100) / 100); };
      html += '<div class="num-stats">' +
        '<div class="num-item"><strong>' + fmt(s.avg) + '</strong><span>平均值</span></div>' +
        '<div class="num-item"><strong>' + fmt(s.min) + '</strong><span>最小值</span></div>' +
        '<div class="num-item"><strong>' + fmt(s.max) + '</strong><span>最大值</span></div>' +
        '</div>';
      if (agg.all_values && agg.all_values.length) {
        html += '<p class="meta">数值明细（最多展示 100 条）：' + agg.all_values.join('、') + '</p>';
      }
      return html;
    }

    // text
    if (agg.all_values && agg.all_values.length) {
      html += '<p class="meta">全部回答（最多展示 100 条）：</p><ul class="values">' +
        agg.all_values.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  async function openStats(q) {
    statsBody.innerHTML = '<p class="hint">加载中…</p>';
    dlgStats.showModal();
    try {
      var data = await API.get('/api/questions/' + q._id + '/stats?includeVersions=true&limit=100');
      var html = '';

      if (data.included_versions && data.included_versions.length > 1) {
        html += '<p class="callout callout-info">已包含全部版本（v' + data.included_versions.join('、v') + '）</p>';
      }

      // 按问卷拆分
      if (data.surveys && data.surveys.length) {
        html += '<h3>按问卷拆分</h3><table class="striped"><thead><tr><th>问卷</th><th>引用版本</th><th>有效答卷数</th></tr></thead><tbody>' +
          data.surveys.map(function (s) {
            var verText = s.source_versions && s.source_versions.length > 1
              ? 'v' + s.source_versions.join('、v')
              : 'v' + s.source_version;
            return '<tr><td>' + esc(s.title) + '</td><td>' + verText + '</td><td>' + s.answer_count + '</td></tr>';
          }).join('') + '</tbody></table>';
      } else {
        html += '<div class="empty-state">还没有你的问卷引用这道题</div>';
      }

      // 结构分组：多组时循环渲染卡片；单组直接渲染汇总
      var groups = (data.aggregate && data.aggregate.by_schema_group) || [];
      if (groups.length > 1) {
        html += '<h3>汇总</h3>';
        html += groups.map(function (g) {
          return '<div class="callout callout-info">' +
            '<strong>代表版本 v' + g.representative_version + '</strong>' +
            '<div class="meta">相同结构的题目已合并（结构不同则分组独立统计，避免本地改写污染统计）</div>' +
            renderAggregate(g.aggregate, q.type) + '</div>';
        }).join('');
      } else {
        html += '<h3>汇总</h3>' + renderAggregate(data.aggregate, q.type);
      }

      if (data.excluded_surveys_count > 0) {
        html += '<p class="callout callout-warning">出于隐私保护，已剔除 ' + data.excluded_surveys_count + ' 份他人创建的问卷（含匿名问卷，不计入统计）</p>';
      }

      statsBody.innerHTML = html;
    } catch (err) {
      dlgStats.close();
      alert(err.message || '加载跨卷统计失败');
    }
  }

  // dialog 关闭按钮
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (btn) {
    btn.addEventListener('click', function () {
      var dlg = btn.closest('dialog');
      if (dlg) dlg.close();
    });
  });

  // ── 初始化 ──
  loadList();
})();

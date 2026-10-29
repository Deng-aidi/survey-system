// 问卷编辑器：加载问卷、按题型添加题目、配置跳转规则、发布
(function () {
  var surveyId = new URLSearchParams(location.search).get('surveyId');
  var survey = null;

  var TYPE_LABEL = {
    single_choice: '单选',
    multiple_choice: '多选',
    text: '文本',
    number: '数字',
  };
  var STATUS_LABEL = { draft: '草稿', open: '已发布', closed: '已关闭' };
  // 按题型限制可选 operator（与后端 jumpResolver 对齐）
  var OPERATORS_BY_TYPE = {
    single_choice: [['equals', '等于'], ['includes', '包含']],
    multiple_choice: [['includes', '包含'], ['equals', '等于']],
    text: [['equals', '等于']],
    number: [['gte', '≥ 大于等于'], ['lte', '≤ 小于等于'], ['eq', '= 等于'], ['between', '介于区间']],
  };
  var OP_LABEL = { equals: '=', includes: '包含', gte: '≥', lte: '≤', eq: '=', between: '介于' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function showMsg(text, isError) {
    var el = $('msg');
    el.textContent = text || '';
    el.className = 'msg ' + (isError ? 'error' : 'ok');
  }

  // ── 加载与整体渲染 ──
  async function load() {
    if (!surveyId) {
      showMsg('链接缺少 surveyId 参数', true);
      return;
    }
    try {
      survey = await API.get('/api/surveys/' + surveyId);
      render();
    } catch (err) {
      showMsg(err.message || '加载失败', true);
    }
  }

  function isReadOnly() {
    return !!(survey.published_at || survey.status !== 'draft');
  }

  // ISO → datetime-local 输入框格式（YYYY-MM-DDTHH:mm），按本地时区取字段
  // 不能用 toISOString()，那是 UTC，会差 8 小时
  function isoToLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function render() {
    $('survey-info').style.display = '';
    $('e-title').textContent = survey.title;
    $('e-status').textContent = STATUS_LABEL[survey.status] || survey.status;
    $('e-deadline').value = isoToLocalInput(survey.deadline);
    $('publish-errors').innerHTML = '';

    var readOnly = isReadOnly();
    $('readonly-tip').style.display = readOnly ? '' : 'none';
    $('publish-callout').style.display = readOnly ? '' : 'none';
    $('btn-publish').style.display = readOnly ? 'none' : '';
    $('btn-from-library').style.display = readOnly ? 'none' : '';
    $('form-add').style.display = readOnly ? 'none' : '';
    document.querySelector('h2').style.display = readOnly ? 'none' : '';
    document.querySelectorAll('#survey-info input, #survey-info select, #survey-info textarea, #btn-save-settings')
      .forEach(function (el) { el.disabled = readOnly; });

    var sorted = survey.questions.slice().sort(function (a, b) { return a.order - b.order; });
    $('question-list').innerHTML = sorted.length
      ? sorted.map(function (q, idx) { return questionHtml(q, idx, sorted, readOnly); }).join('')
      : '<p>还没有题目，先在上方创建一道，或者从题库直接选择吧！</p>';

    annotateSourceVersions();
  }

  // 快照题的来源标注；题库已有更新版本时提示（仅展示，不自动同步）
  function annotateSourceVersions() {
    survey.questions.filter(function (q) { return q.source_question_id; }).forEach(async function (q) {
      var el = document.getElementById('src-' + q._id);
      if (!el) return;
      try {
        var chain = await API.get('/api/questions/' + q.source_question_id + '/versions');
        var latest = chain.reduce(function (max, v) { return v.version > max ? v.version : max; }, 0);
        if (latest > q.source_version) {
          el.innerHTML = '[来自题库 v' + q.source_version + '；题库已有 v' + latest + '，建议新建问卷使用新版本]' +
            '<a href="question-bank.html">去题库查看新版本</a>';
          el.classList.add('outdated');
        }
      } catch (err) {
        // 无权查看版本链时保留基础标注
      }
    });
  }

  // ── 从题库加入问卷 ──
  var dlgLibrary = $('dlg-library');
  var libraryList = $('library-list');
  var libraryMsg = $('library-msg');

  function renderLibrary(items, currentUserId) {
    libraryList.innerHTML = '';

    if (!items.length) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 4;
      emptyCell.innerHTML = '<div class="empty-state">题库为空<div class="empty-guide">还没有题目，先去题库创建一道题，之后可跨问卷复用</div></div>';
      emptyRow.appendChild(emptyCell);
      libraryList.appendChild(emptyRow);
      return;
    }

    items.forEach(function (q) {
      var tr = document.createElement('tr');

      var titleCell = document.createElement('td');
      // 同一 root 的不同版本都会出现在列表里，标出版本号才能明确选哪一版
      titleCell.textContent = q.title + '（v' + q.version + '）';

      var typeCell = document.createElement('td');
      typeCell.textContent = TYPE_LABEL[q.type] || q.type;

      var sourceCell = document.createElement('td');
      // 取不到当前用户信息时只影响“来源”标注，不影响列表与加入
      sourceCell.textContent = !currentUserId
        ? '—'
        : (String(q.creator_id) === String(currentUserId) ? '我的' : '共享');

      var opCell = document.createElement('td');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '加入';
      btn.addEventListener('click', async function () {
        try {
          await API.post('/api/surveys/' + surveyId + '/questions/from-library', {
            question_id: q._id,
            required: false,
          });
          dlgLibrary.close();
          await load();
          showMsg('已从题库添加');
        } catch (err) {
          libraryMsg.textContent = err.message || '添加失败';
          libraryMsg.className = 'msg error';
        }
      });
      opCell.appendChild(btn);

      tr.appendChild(titleCell);
      tr.appendChild(typeCell);
      tr.appendChild(sourceCell);
      tr.appendChild(opCell);
      libraryList.appendChild(tr);
    });
  }

  $('btn-from-library').addEventListener('click', async function () {
    libraryMsg.textContent = '';
    libraryMsg.className = 'msg';
    libraryList.innerHTML = '';
    dlgLibrary.showModal();

    // ① 题库列表是主数据，先取；失败才真正无法继续
    var items;
    try {
      items = await API.get('/api/questions?includeShared=true');
    } catch (err) {
      libraryMsg.textContent = '加载题库失败：' + (err.message || '未知错误');
      libraryMsg.className = 'msg error';
      return;
    }

    // ② 当前用户 ID 只用于标注“我的/共享”，单独容错，不能拖垮整个弹窗
    var currentUserId = null;
    try {
      var me = await API.get('/api/auth/me');
      currentUserId = me._id;
    } catch (err) {
      if (err.status === 404 || err.code === 'USER_NOT_FOUND') {
        API.clearAuth();
        libraryMsg.innerHTML = '当前登录账号已不存在（可能被删除或数据库被重置），题库列表已加载，但无法加入。请 <a href="index.html">重新登录或注册</a> 后再试。';
        libraryMsg.className = 'msg error';
        return;
      }
      if (err.status === 401) {
        libraryMsg.innerHTML = '登录状态已过期，请 <a href="index.html">重新登录</a> 后再试。';
        libraryMsg.className = 'msg error';
        return;
      }
      libraryMsg.textContent = '暂时无法确认当前账号身份，来源列显示为“—”，仍可尝试加入：' + (err.message || '');
      libraryMsg.className = 'msg';
    }
    renderLibrary(items, currentUserId);
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (btn) {
    btn.addEventListener('click', function () {
      var dlg = btn.closest('dialog');
      if (dlg) dlg.close();
    });
  });

  function questionHtml(q, idx, sorted, readOnly) {
    var html = '<div class="q-card">';
    html += '<h3>第 ' + (idx + 1) + ' 题：' + esc(q.title) + (q.required ? ' <span style="color:#c00">*</span>' : '') + '</h3>';
    html += '<div class="q-meta">题型：' + (TYPE_LABEL[q.type] || q.type) + '</div>';
    if (q.source_question_id) {
      html += '<div class="q-source" id="src-' + q._id + '">[来自题库 v' +
        (q.source_version == null ? '?' : q.source_version) + ']</div>';
    }

    if (q.options && q.options.length) {
      html += '<div class="q-options">选项：' + q.options.map(function (o) {
        return esc(o.label) + '(' + esc(o.value) + ')';
      }).join('、') + '</div>';
    }

    // 删除本题（仅草稿阶段可用；发布后由 structureLock 锁定）
    if (!readOnly) {
      html += '<button type="button" data-action="del-question" data-qid="' + q._id + '"' +
        ' title="删除这道题；指向它的跳转规则会一并清除，不可撤销">删除本题</button>';
    }

    // 已配置的跳转规则
    if (q.jump_rules && q.jump_rules.length) {
      html += '<ul class="jump-rules">' + q.jump_rules.map(function (r, i) {
        var del = readOnly ? '' :
          ' <button type="button" data-action="del-rule" data-qid="' + q._id + '" data-idx="' + i + '">删除</button>';
        return '<li>' + esc(ruleText(r)) + del + '</li>';
      }).join('') + '</ul>';
    }

    // 配置跳转
    if (!readOnly) {
      html += '<button type="button" data-action="toggle-jump" data-qid="' + q._id + '">配置跳转</button>';
      html += '<div class="jump-form" id="jf-' + q._id + '" style="display:none">';
      html += '<p class="hint" style="width:100%">当本题答案满足【操作符】+【值】时，跳至【目标题】。问卷发布后跳转规则不可修改。</p>';

      var ops = OPERATORS_BY_TYPE[q.type] || [];
      html += '<select id="jop-' + q._id + '" title="操作符：答案与比较值的比较方式，如“等于”“包含”“≥”">' + ops.map(function (p) {
        return '<option value="' + p[0] + '">' + p[1] + '</option>';
      }).join('') + '</select>';

      html += '<input id="jval-' + q._id + '" type="text" placeholder="比较值（介于：小,大）" title="值：与答案比较的目标值；“介于”需填两个数字，用逗号分隔，如 18,30">';

      html += '<select id="jtarget-' + q._id + '" title="目标题：命中规则后要跳转到的题目；选择“结束”则直接交卷"><option value="">结束</option>';
      sorted.forEach(function (other, oidx) {
        if (other._id === q._id) return;
        html += '<option value="' + other._id + '">第 ' + (oidx + 1) + ' 题：' + esc(other.title) + '</option>';
      });
      html += '</select>';

      html += '<button type="button" data-action="add-rule" data-qid="' + q._id + '">添加规则</button>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function ruleText(r) {
    var c = r.condition || {};
    var v = Array.isArray(c.value) ? c.value.join(' ~ ') : String(c.value);
    var target = (r.targetQuestionId === null || r.targetQuestionId === undefined)
      ? '结束'
      : '「' + questionTitle(r.targetQuestionId) + '」';
    return '当答案 ' + (OP_LABEL[c.operator] || c.operator) + ' ' + v + ' → ' + target;
  }

  function questionTitle(qid) {
    var q = survey.questions.find(function (x) { return x._id.toString() === qid.toString(); });
    return q ? q.title : qid;
  }

  // ── 题目列表内的点击事件（配置跳转 / 添加规则 / 删除规则）──
  $('question-list').addEventListener('click', async function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var qid = btn.getAttribute('data-qid');

    if (action === 'toggle-jump') {
      var panel = $('jf-' + qid);
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      return;
    }

    var q = survey.questions.find(function (x) { return x._id.toString() === qid; });
    if (!q) return;

    if (action === 'del-question') {
      if (!confirm('确定删除「' + q.title + '」吗？指向它的跳转规则会一并清除，此操作不可撤销。')) return;
      btn.disabled = true;
      try {
        survey = await API.del('/api/surveys/' + surveyId + '/questions/' + qid);
        render();
        showMsg('已删除题目');
      } catch (err) {
        btn.disabled = false;
        showMsg(err.message || '删除失败', true);
      }
      return;
    }

    if (action === 'add-rule') {
      var rule = buildRule(q, qid);
      if (!rule) return; // buildRule 已提示
      await saveRules(qid, (q.jump_rules || []).concat([rule]));
    } else if (action === 'del-rule') {
      var idx = Number(btn.getAttribute('data-idx'));
      var rules = (q.jump_rules || []).slice();
      rules.splice(idx, 1);
      await saveRules(qid, rules);
    }
  });

  // 按题型解析跳转规则的 value；非法输入返回 null
  function buildRule(q, qid) {
    var operator = $('jop-' + qid).value;
    var raw = $('jval-' + qid).value.trim();
    var value;

    if (operator === 'between') {
      var parts = raw.split(/[,，]/).map(function (s) { return Number(s.trim()); });
      if (parts.length !== 2 || parts.some(function (n) { return !isFinite(n); })) {
        showMsg('介于区间需要两个数字，用逗号分隔，如：18,30', true);
        return null;
      }
      value = parts;
    } else if (q.type === 'number') {
      if (raw === '' || !isFinite(Number(raw))) {
        showMsg('数字题的比较值必须是数字', true);
        return null;
      }
      value = Number(raw);
    } else {
      if (raw === '') {
        showMsg('比较值不能为空', true);
        return null;
      }
      value = raw;
    }

    var targetRaw = $('jtarget-' + qid).value;
    return {
      condition: { operator: operator, value: value },
      targetQuestionId: targetRaw === '' ? null : targetRaw,
    };
  }

  async function saveRules(qid, rules) {
    try {
      survey = await API.patch('/api/surveys/' + surveyId + '/questions/' + qid + '/jump_rules', { jump_rules: rules });
      render();
      showMsg('跳转规则已保存');
    } catch (err) {
      showMsg(err.message || '保存失败', true);
    }
  }

  // ── 添加题目表单：按题型动态显示字段 ──
  function onTypeChange() {
    var t = $('a-type').value;
    $('a-fields-choice').style.display = (t === 'single_choice' || t === 'multiple_choice') ? '' : 'none';
    $('a-fields-multiple').style.display = t === 'multiple_choice' ? '' : 'none';
    $('a-fields-text').style.display = t === 'text' ? '' : 'none';
    $('a-fields-number').style.display = t === 'number' ? '' : 'none';
  }

  function addOptionRow(label, value) {
    var row = document.createElement('div');
    row.className = 'option-row';
    row.innerHTML =
      '<input type="text" class="opt-label" placeholder="选项文本 label">' +
      '<input type="text" class="opt-value" placeholder="选项值 value">' +
      '<button type="button" class="opt-del">删除</button>';
    row.querySelector('.opt-label').value = label || '';
    row.querySelector('.opt-value').value = value || '';
    $('a-options').appendChild(row);
  }

  $('a-options').addEventListener('click', function (e) {
    if (e.target.classList.contains('opt-del')) {
      e.target.closest('.option-row').remove();
    }
  });
  $('a-add-option').addEventListener('click', function () { addOptionRow(); });
  $('a-type').addEventListener('change', onTypeChange);

  function collectOptions() {
    var rows = document.querySelectorAll('#a-options .option-row');
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

  $('form-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var type = $('a-type').value;
    var title = $('a-title').value.trim();
    if (!title) {
      showMsg('题目标题必填', true);
      return;
    }

    var body = { type: type, title: title, required: $('a-required').checked };

    if (type === 'single_choice' || type === 'multiple_choice') {
      body.options = collectOptions();
      if (body.options.length === 0) {
        showMsg('选项题型至少需要一个完整选项（label + value）', true);
        return;
      }
    }

    var validation = {};
    if (type === 'multiple_choice') {
      setNum(validation, 'min_choices', $('a-min-choices').value);
      setNum(validation, 'max_choices', $('a-max-choices').value);
    } else if (type === 'text') {
      setNum(validation, 'min_length', $('a-min-length').value);
      setNum(validation, 'max_length', $('a-max-length').value);
    } else if (type === 'number') {
      setNum(validation, 'min', $('a-min').value);
      setNum(validation, 'max', $('a-max').value);
      if ($('a-integer').checked) validation.integer = true;
    }
    if (Object.keys(validation).length > 0) body.validation = validation;

    try {
      survey = await API.post('/api/surveys/' + surveyId + '/questions', body);
      resetForm();
      render();
      showMsg('题目已添加');
    } catch (err) {
      showMsg(err.message || '添加失败', true);
    }
  });

  function resetForm() {
    $('a-title').value = '';
    $('a-required').checked = false;
    ['a-min-choices', 'a-max-choices', 'a-min-length', 'a-max-length', 'a-min', 'a-max'].forEach(function (id) {
      $(id).value = '';
    });
    $('a-integer').checked = false;
    $('a-options').innerHTML = '';
    addOptionRow();
    addOptionRow();
  }

  // ── 保存设置（截止时间；open 状态也允许修改，便于提前结束）──
  $('btn-save-settings').addEventListener('click', async function () {
    var raw = $('e-deadline').value; // '' 或 'YYYY-MM-DDTHH:mm'（本地时间）
    // new Date(raw) 按本地时区解析；空值传 null 清除截止时间
    var deadline = raw === '' ? null : new Date(raw).toISOString();
    try {
      survey = await API.patch('/api/surveys/' + surveyId, { deadline: deadline });
      showMsg('设置已保存');
    } catch (err) {
      showMsg(err.message || '保存失败', true);
    }
  });

  // ── 发布 ──
  $('btn-publish').addEventListener('click', async function () {
    if (!confirm('发布后将锁定题目结构，不可增删题目或修改跳转，但可修改截止时间与说明。是否确认发布？')) {
      return;
    }
    $('publish-errors').innerHTML = '';
    try {
      await API.patch('/api/surveys/' + surveyId + '/status', { status: 'open' });
      showMsg('发布成功');
      await load();
    } catch (err) {
      if (err.status === 422 && err.errors) {
        $('publish-errors').innerHTML = err.errors.map(function (e2) {
          var prefix = e2.question_id ? '题目「' + esc(questionTitle(e2.question_id)) + '」：' : '';
          return '<li>' + prefix + esc(e2.reason) + '</li>';
        }).join('');
        showMsg('发布校验未通过，请修正以下问题', true);
      } else {
        showMsg(err.message || '发布失败', true);
      }
    }
  });

  // ── 初始化 ──
  resetForm();
  onTypeChange();
  load();
})();

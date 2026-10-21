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
    return survey.status === 'open';
  }

  function render() {
    $('survey-info').style.display = '';
    $('e-title').textContent = survey.title;
    $('e-status').textContent = STATUS_LABEL[survey.status] || survey.status;
    $('publish-errors').innerHTML = '';

    var readOnly = isReadOnly();
    $('readonly-tip').style.display = readOnly ? '' : 'none';
    $('btn-publish').style.display = readOnly ? 'none' : '';
    $('form-add').style.display = readOnly ? 'none' : '';
    document.querySelector('h2').style.display = readOnly ? 'none' : '';

    var sorted = survey.questions.slice().sort(function (a, b) { return a.order - b.order; });
    $('question-list').innerHTML = sorted.length
      ? sorted.map(function (q, idx) { return questionHtml(q, idx, sorted, readOnly); }).join('')
      : '<p>暂无题目，请在下方添加。</p>';
  }

  function questionHtml(q, idx, sorted, readOnly) {
    var html = '<div class="q-card">';
    html += '<h3>第 ' + (idx + 1) + ' 题：' + esc(q.title) + (q.required ? ' <span style="color:#c00">*</span>' : '') + '</h3>';
    html += '<div class="q-meta">题型：' + (TYPE_LABEL[q.type] || q.type) + '</div>';

    if (q.options && q.options.length) {
      html += '<div class="q-options">选项：' + q.options.map(function (o) {
        return esc(o.label) + '(' + esc(o.value) + ')';
      }).join('、') + '</div>';
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

      var ops = OPERATORS_BY_TYPE[q.type] || [];
      html += '<select id="jop-' + q._id + '">' + ops.map(function (p) {
        return '<option value="' + p[0] + '">' + p[1] + '</option>';
      }).join('') + '</select>';

      html += '<input id="jval-' + q._id + '" type="text" placeholder="比较值（介于：小,大）">';

      html += '<select id="jtarget-' + q._id + '"><option value="">结束</option>';
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

  // ── 发布 ──
  $('btn-publish').addEventListener('click', async function () {
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

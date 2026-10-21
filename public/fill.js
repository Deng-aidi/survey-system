// 填写页：F1 取问卷 → 逐题 F2 校验并依赖后端 next_question_id 前进 → F3 提交
// 前端不解释任何跳转规则；401 是业务态（仅限登录用户），用 skip401Redirect 关闭自动跳转
(function () {
  var token = new URLSearchParams(location.search).get('token');
  var NO_REDIRECT = { skip401Redirect: true };

  var survey = null;
  var sorted = [];        // 按 order 排序的题目
  var answers = [];       // [{ question_id, answer }]，仅存校验通过的
  var currentQid = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function showView(name) {
    ['view-loading', 'view-error', 'view-survey', 'view-success'].forEach(function (v) {
      $(v).style.display = v === name ? '' : 'none';
    });
  }

  function showError(text, withLoginLink) {
    $('error-text').textContent = text;
    $('error-login').style.display = withLoginLink ? '' : 'none';
    showView('view-error');
  }

  function showQuestionErrors(errs) {
    $('q-errors').textContent = (errs || []).map(function (e) { return e.reason; }).join('；');
  }

  // ── F1：取问卷 ──
  async function load() {
    if (!token) {
      showError('链接缺少 token 参数', false);
      return;
    }
    try {
      survey = await API.get('/api/surveys/by-token/' + token, NO_REDIRECT);
      if (!survey.questions || survey.questions.length === 0) {
        showError('该问卷还没有题目', false);
        return;
      }
      sorted = survey.questions.slice().sort(function (a, b) { return a.order - b.order; });
      currentQid = sorted[0]._id;
      renderShell();
      renderQuestion();
      showView('view-survey');
    } catch (err) {
      if (err.status === 401) {
        showError('请先登录后再填写该问卷', true);
      } else if (err.status === 403) {
        var map = {
          SURVEY_NOT_OPEN: '问卷未发布',
          SURVEY_CLOSED: '问卷已关闭',
          SURVEY_EXPIRED: '问卷已过期',
        };
        showError(map[err.code] || err.message, false);
      } else if (err.status === 404) {
        showError('问卷不存在', false);
      } else {
        showError(err.message || '加载失败', false);
      }
    }
  }

  function renderShell() {
    $('s-title').textContent = survey.title;
    $('s-desc').textContent = survey.description || '';
  }

  function currentQuestion() {
    return sorted.find(function (q) { return q._id.toString() === currentQid; });
  }

  // ── 渲染当前题 ──
  function renderQuestion() {
    var q = currentQuestion();
    if (!q) {
      showError('题目不存在', false);
      return;
    }
    showQuestionErrors([]);
    $('btn-submit').style.display = 'none';
    $('btn-next').style.display = '';

    var html = '<div class="q-block">';
    html += '<h3>第 ' + (answers.length + 1) + ' 题：' + esc(q.title) +
      (q.required ? ' <span style="color:#c00">*</span>' : '') + '</h3>';

    if (q.type === 'single_choice') {
      html += (q.options || []).map(function (o) {
        return '<label><input type="radio" name="ans" value="' + esc(o.value) + '"> ' + esc(o.label) + '</label>';
      }).join('');
    } else if (q.type === 'multiple_choice') {
      html += (q.options || []).map(function (o) {
        return '<label><input type="checkbox" name="ans" value="' + esc(o.value) + '"> ' + esc(o.label) + '</label>';
      }).join('');
    } else if (q.type === 'text') {
      html += '<textarea id="ans-text" placeholder="请输入"></textarea>';
    } else if (q.type === 'number') {
      html += '<input id="ans-number" type="number" step="any" placeholder="请输入数字">';
    }

    html += '</div>';
    $('q-body').innerHTML = html;
  }

  // 按题型收集答案，保证 answer 形态正确
  function collectAnswer(q) {
    if (q.type === 'single_choice') {
      var r = document.querySelector('input[name="ans"]:checked');
      return r ? r.value : null;
    }
    if (q.type === 'multiple_choice') {
      return Array.prototype.map.call(
        document.querySelectorAll('input[name="ans"]:checked'),
        function (el) { return el.value; }
      );
    }
    if (q.type === 'text') {
      return $('ans-text').value;
    }
    if (q.type === 'number') {
      var raw = $('ans-number').value;
      return raw === '' ? null : Number(raw);
    }
    return null;
  }

  // 空答案判定：null / undefined / 空字符串（含纯空格）/ 空数组
  // 空答案不入 answers，避免 F3 落库后污染统计（answer_count 虚高、单选出现 null 分组）
  function isAnswerEmpty(a) {
    return a === null || a === undefined ||
      (typeof a === 'string' && a.trim() === '') ||
      (Array.isArray(a) && a.length === 0);
  }

  // ── F2：下一题 ──
  $('btn-next').addEventListener('click', async function () {
    var q = currentQuestion();
    if (!q) return;
    var answer = collectAnswer(q);
    try {
      var res = await API.post(
        '/api/surveys/by-token/' + token + '/answers/validate',
        { question_id: q._id.toString(), answer: answer },
        NO_REDIRECT
      );

      if (!res.valid) {
        showQuestionErrors(res.errors);
        return;
      }

      showQuestionErrors([]);
      // 空答案只前进不记录；required 题空答案在 F2 就 valid=false，走不到这里
      if (!isAnswerEmpty(answer)) {
        answers.push({ question_id: q._id.toString(), answer: answer });
      }

      if (res.next_question_id === null || res.next_question_id === undefined) {
        // 后端判定已到末尾 → 显示提交
        $('q-body').innerHTML =
          '<div class="q-block"><h3>已完成全部题目</h3><p>共作答 ' + answers.length + ' 题，点击下方按钮提交。</p></div>';
        $('btn-next').style.display = 'none';
        $('btn-submit').style.display = '';
      } else {
        currentQid = res.next_question_id;
        renderQuestion();
      }
    } catch (err) {
      showError(err.message || '校验请求失败', false);
    }
  });

  // ── F3：提交 ──
  $('btn-submit').addEventListener('click', async function () {
    try {
      var res = await API.post(
        '/api/surveys/by-token/' + token + '/submissions',
        { answers: answers, expected_version: survey.__v },
        NO_REDIRECT
      );
      $('sub-id').textContent = res.submission_id;
      showView('view-success');
    } catch (err) {
      if (err.status === 409) {
        showError('问卷已更新，请刷新重填', false);
      } else if (err.errors && err.errors.length) {
        // 400 FINAL_VALIDATION_FAILED：后端二次校验未过，逐条展示
        showQuestionErrors(err.errors);
      } else {
        showError(err.message || '提交失败', false);
      }
    }
  });

  load();
})();

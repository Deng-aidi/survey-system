// 统计页：GET /api/surveys/:id/stats，按题型渲染
(function () {
  var surveyId = new URLSearchParams(location.search).get('surveyId');

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function showMsg(text) {
    $('msg').textContent = text || '';
    $('msg').className = 'msg error';
  }

  async function load() {
    if (!surveyId) {
      showMsg('链接缺少 surveyId 参数');
      return;
    }
    try {
      var data = await API.get('/api/surveys/' + surveyId + '/stats');
      $('survey-title').textContent = data.survey_title;
      $('total-submissions').textContent = data.total_submissions;
      render(data);
    } catch (err) {
      showMsg(err.message || '加载失败');
    }
  }

  function render(data) {
    var html = '';
    data.questions.forEach(function (q, idx) {
      html += '<div class="q-block">';
      html += '<h3>第 ' + (idx + 1) + ' 题：' + esc(q.question_title) + '</h3>';
      html += '<div class="meta">题型：' + typeLabel(q.question_type) + '，作答 ' + q.answer_count + ' 人';
      if (q.answer_count !== data.total_submissions) {
        html += '（该题作答 ' + q.answer_count + ' 人）';
      }
      html += '</div>';

      if (q.question_type === 'single_choice' || q.question_type === 'multiple_choice') {
        html += renderChoice(q);
      } else if (q.question_type === 'number') {
        html += renderNumber(q);
      } else if (q.question_type === 'text') {
        html += renderText(q);
      }
      html += '</div>';
    });
    $('stats-body').innerHTML = html || '<p>暂无题目。</p>';
  }

  function typeLabel(t) {
    return { single_choice: '单选', multiple_choice: '多选', text: '文本', number: '数字' }[t] || t;
  }

  function renderChoice(q) {
    var max = 1;
    q.option_counts.forEach(function (o) { if (o.count > max) max = o.count; });
    var html = '';
    q.option_counts.forEach(function (o) {
      var pct = Math.round((o.count / max) * 100);
      html += '<div class="opt-row">' +
        '<div class="opt-label">' + esc(o.option_label) + '</div>' +
        '<div class="bar-wrap"><div class="bar" style="width:' + pct + '%"></div></div>' +
        '<div class="opt-count">' + o.count + '</div>' +
        '</div>';
    });
    return html;
  }

  function renderNumber(q) {
    var s = q.stats || {};
    var html = '<p>平均值：' + fmt(s.avg) + '，最小值：' + fmt(s.min) + '，最大值：' + fmt(s.max) + '</p>';
    if (q.all_values && q.all_values.length) {
      html += '<div class="meta">全部数值：</div><ul class="values">' +
        q.all_values.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>';
    }
    return html;
  }

  function renderText(q) {
    if (!q.all_values || !q.all_values.length) return '<p class="meta">暂无文本答案。</p>';
    return '<ul class="values">' +
      q.all_values.map(function (v) { return '<li>' + esc(v) + '</li>'; }).join('') + '</ul>';
  }

  function fmt(n) {
    if (n === null || n === undefined) return '-';
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  load();
})();

// 面板渲染逻辑（在 webview 里跑，只能通过 postMessage 跟扩展通信）
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const content = $('content');
  const statusEl = $('status');
  const btnAi = $('btn-ai');
  const toneRange = $('tone-range');
  const toneName = $('tone-name');
  const toneFace = $('tone-face');

  // 设置面板（右上角齿轮）
  const btnSettings = $('btn-settings');
  const settingsPanel = $('settings');
  const setTemp = $('set-temp');
  const setTempVal = $('set-temp-val');
  const setMax = $('set-max');
  const setMaxVal = $('set-max-val');

  // 兜底文案：正常以扩展推来的 label 为准，扩展没给时也得有字显示
  const TONE_LABELS = ['夸夸型', '温和顾问', '耿直同事', '毒舌但有用', '赛博阎王'];
  // 情绪强度：微笑 → 中性 → 发怒，和五档一一对应
  const TONE_FACES = ['😊', '🙂', '😐', '😠', '🤬'];
  // 滑杆的填充色也跟着走：绿 → 蓝 → 灰 → 橙 → 红，光看颜色就知道火力调到哪了
  const TONE_COLORS = [
    'var(--vscode-charts-green, #3fb950)',
    'var(--vscode-charts-blue, #3794ff)',
    'var(--vscode-descriptionForeground, #999)',
    'var(--vscode-charts-orange, #d18616)',
    'var(--vscode-errorForeground, #f14c4c)'
  ];

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // ===== 等待动画：吃豆人吃豆（张嘴 + 呼吸缩放）+ 循环文案 =====
  const loader = $('loader');
  const loaderText = $('loader-text');
  const snackCanvas = $('snack');
  const timeEl = $('loader-time');
  const stageEl = $('loader-stage');

  // 与 prompt 里的四步流程呼应，让等待有「在干什么」的实感
  const LOADER_WORDS = [
    '正在还原这次想做什么…',
    '正在对照实现…',
    '正在翻遗漏的分支…',
    '正在查前后口径是否一致…',
    '正在翻有没有反着写的分支…',
    '正在找复制粘贴的痕迹…',
    '正在算这段以后谁来接手…',
    '正在掂量严重程度…',
    '正在挑措辞…',
    '正在算分…'
  ];

  let snackRaf = 0;
  let wordTimer = 0;
  let wordIdx = 0;

  /** 一只朝右的吃豆人：嘴张开角随 mouth 变化，半径由调用方乘好缩放 */
  function drawPacman(ctx, x, y, r, mouth, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, mouth, Math.PI * 2 - mouth);
    ctx.closePath();
    ctx.fill();

    // 眼睛：挖成透明，露出面板底色
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x + r * 0.12, y - r * 0.48, Math.max(1, r * 0.15), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function startSnack() {
    if (!snackCanvas || snackRaf) return;
    const ctx = snackCanvas.getContext('2d');
    const W = snackCanvas.width;
    const H = snackCanvas.height;
    const color = (getComputedStyle(document.body).color || '#999').trim();
    const BASE_Y = H / 2;
    const PAC_X = 26;
    const GAP = 22;

    // 豆子只存 x：整排左移，进嘴（PAC_X）就吃掉，右边补齐，所以永远吃不完
    let dots = [];
    for (let x = PAC_X + GAP; x < W; x += GAP) dots.push(x);

    let last = performance.now();
    let t = 0;

    function frame(now) {
      const dt = Math.min(48, now - last) / 16.67;   // 归一化到 60fps，切后台回来不会瞬移
      last = now;
      t += dt;
      const speed = 1.6 * dt;

      for (let i = 0; i < dots.length; i++) dots[i] -= speed;
      while (dots.length && dots[0] <= PAC_X) dots.shift();
      let tail = dots.length ? dots[dots.length - 1] : PAC_X;
      while (tail < W) { tail += GAP; dots.push(tail); }

      ctx.clearRect(0, 0, W, H);

      // 豆子：越靠近嘴越小越淡，吃掉的过程不至于「啪」一下消失
      ctx.fillStyle = color;
      for (const d of dots) {
        const near = d - PAC_X;
        ctx.globalAlpha = near < 26 ? Math.max(0.12, near / 26) : 0.5;
        ctx.beginPath();
        ctx.arc(d, BASE_Y, near < 10 ? 1 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 张嘴和缩放用两个不同周期，看起来不呆板
      const mouth = 0.08 + (Math.sin(t * 0.3) * 0.5 + 0.5) * 0.6;
      const scale = 1 + Math.sin(t * 0.09) * 0.12;
      drawPacman(ctx, PAC_X, BASE_Y, 9 * scale, mouth, color);

      snackRaf = requestAnimationFrame(frame);
    }
    snackRaf = requestAnimationFrame(frame);
  }

  function stopSnack() {
    if (snackRaf) cancelAnimationFrame(snackRaf);
    snackRaf = 0;
    if (snackCanvas) {
      snackCanvas.getContext('2d').clearRect(0, 0, snackCanvas.width, snackCanvas.height);
    }
  }

  function nextWord() {
    if (!loaderText) return;
    loaderText.textContent = LOADER_WORDS[wordIdx % LOADER_WORDS.length];
    wordIdx++;
    // 淡入：重置动画再触发一次
    loaderText.style.opacity = '0';
    requestAnimationFrame(() => { loaderText.style.opacity = '1'; });
  }

  // 计时用扩展侧给的起点（busy.at），而不是面板收到消息的时刻：
  // 这样即使 postMessage 有延迟，秒数也和扩展里真实的耗时对得上。
  let startedAt = 0;
  let timeTimer = 0;

  function fmtSec(ms) {
    return (ms / 1000).toFixed(1) + 's';
  }

  function tickTime() {
    if (timeEl) timeEl.textContent = startedAt ? fmtSec(Date.now() - startedAt) : '0.0s';
  }

  function startLoader(at) {
    if (!loader) return;
    loader.classList.remove('hide');
    wordIdx = 0;
    nextWord();
    if (wordTimer) clearInterval(wordTimer);
    wordTimer = setInterval(nextWord, 1800);
    startedAt = at || Date.now();
    if (timeTimer) clearInterval(timeTimer);
    tickTime();
    timeTimer = setInterval(tickTime, 100);
    startSnack();
  }

  function stopLoader() {
    if (!loader) return;
    loader.classList.add('hide');
    if (wordTimer) clearInterval(wordTimer);
    wordTimer = 0;
    if (timeTimer) clearInterval(timeTimer);
    timeTimer = 0;
    startedAt = 0;
    if (stageEl) { stageEl.textContent = ''; stageEl.title = ''; }
    stopSnack();
  }

  // ===== AI 锐评：固定版式（顺序、标题、分节都不随模型输出变化） =====
  const LEVEL_CN = { P0: '致命', P1: '严重', P2: '结构', P3: '细节' };
  const CONF_CN = { high: '高', medium: '中', low: '低' };

  function section(title, cls, body) {
    return '<section class="rv-sec ' + (cls || '') + '"><h3>' + esc(title) + '</h3>' + body + '</section>';
  }

  function renderReview(rv, model) {
    if (!rv || !rv.requirement) return;
    const findings = rv.findings || [];
    // 没问题时不再摆「问题（0）」「先做这一件」这类空栏目：
    // 简单改动只留 理解 / 总评 / 顺嘴一提，把版面让给那句闲聊
    const noIssues = findings.length === 0;
    const p = [];

    p.push('<div class="rv">');
    p.push('<div class="rv-head">AI 锐评 <span class="rv-model">' + esc(model || '') + '</span></div>');

    // 一 · 需求还原
    let reqHtml = '<p class="rv-sum">' + esc(rv.requirement.summary || '（模型没有给出明确结论）') + '</p>';
    if (rv.requirement.evidence && rv.requirement.evidence.length) {
      reqHtml += '<ul class="rv-ev">' + rv.requirement.evidence.map(function (e) {
        return '<li>' + esc(e) + '</li>';
      }).join('') + '</ul>';
    }
    // 把握很足（confidence=high）、或者本来就没问题时，不摆「推断可能出错」：
    // 这两种情况下的 risk 基本是为了填栏目硬写的一句免责话
    if (rv.requirement.risk && !noIssues && rv.requirement.confidence !== 'high') {
      reqHtml += '<div class="rv-risk"><b>推断可能出错的地方</b>' + esc(rv.requirement.risk) + '</div>';
    }
    reqHtml += '<div class="rv-conf">置信度 ' + esc(CONF_CN[rv.requirement.confidence] || rv.requirement.confidence || '—') + '</div>';
    p.push(section('一 · 我理解的需求', 'rv-req', reqHtml));

    // 二 · 总评
    let vHtml = '<div class="rv-verdict-row">';
    vHtml += '<div class="rv-score">' + (rv.verdict.score || 0) + '<small>/100</small></div>';
    vHtml += '<div class="rv-verdict-text">';
    if (rv.verdict.oneLine) vHtml += '<p class="rv-oneline">' + esc(rv.verdict.oneLine) + '</p>';
    if (rv.verdict.tone) vHtml += '<p class="rv-tone">' + esc(rv.verdict.tone) + '</p>';
    vHtml += '</div></div>';
    p.push(section('二 · 总评', 'rv-verdict', vHtml));

    if (noIssues) {
      // 没问题时：顺嘴一提上移到第三节当主体，问题和下一步直接不出现
      if (rv.aside) {
        p.push(section('三 · 顺嘴一提', 'rv-aside-sec', '<p class="rv-aside">' + esc(rv.aside) + '</p>'));
      }
      if (rv.strengths && rv.strengths.length) {
        p.push(section('四 · 做得对的', 'rv-good', '<ul class="rv-good-list">' +
          rv.strengths.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'));
      }
    } else {
      // 三 · 问题
      const items = findings.map(function (f) {
        let h = '<div class="rv-item ' + f.level + '">';
        h += '<div class="rv-item-head"><span class="badge">' + f.level + '</span>' +
          '<span class="rv-item-title">' + esc(f.title) + '</span>' +
          '<span class="rv-item-lv">' + esc(LEVEL_CN[f.level] || '') + '</span></div>';
        if (f.location) h += '<a class="rv-loc" data-file="' + esc(String(f.location).split(':')[0]) +
          '" data-line="' + esc(String(f.location).split(':')[1] || '') + '">' + esc(f.location) + '</a>';
        if (f.what) h += '<div class="rv-row"><b>现象</b>' + esc(f.what) + '</div>';
        if (f.why) h += '<div class="rv-row"><b>为什么</b>' + esc(f.why) + '</div>';
        if (f.fix) h += '<div class="rv-row rv-fix"><b>改法</b>' + esc(f.fix) + '</div>';
        h += '</div>';
        return h;
      }).join('');
      p.push(section('三 · 问题（' + findings.length + '）', 'rv-findings', items));

      // 四 · 亮点
      if (rv.strengths && rv.strengths.length) {
        p.push(section('四 · 做得对的', 'rv-good', '<ul class="rv-good-list">' +
          rv.strengths.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>'));
      }

      // 五 · 下一步
      if (rv.nextStep) {
        p.push(section('五 · 先做这一件', 'rv-next', '<p>' + esc(rv.nextStep) + '</p>'));
      }

      // 六 · 顺嘴一提：全篇唯一允许口语的地方，档位差异主要靠它和总评体现
      if (rv.aside) {
        p.push(section('六 · 顺嘴一提', 'rv-aside-sec', '<p class="rv-aside">' + esc(rv.aside) + '</p>'));
      }
    }

    p.push('</div>');
    content.innerHTML = p.join('');
  }

  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.id === 'btn-ai') { statusEl.textContent = '收集上下文中…'; vscode.postMessage({ type: 'aiReview' }); return; }
    if (t.classList && t.classList.contains('rv-loc')) {
      vscode.postMessage({ type: 'open', file: t.dataset.file, line: Number(t.dataset.line) });
    }
  });

  // 滑杆：拖动时只更新档位名（本地即时反馈），松手才写配置，免得一次拖动发十几条消息
  function paintTone(idx) {
    const i = Math.min(TONE_LABELS.length, Math.max(1, idx || 3));
    if (toneRange) {
      toneRange.style.setProperty('--pct', ((i - 1) / (TONE_LABELS.length - 1) * 100) + '%');
      toneRange.style.setProperty('--tone-color', TONE_COLORS[i - 1] || TONE_COLORS[2]);
    }
    if (toneName) toneName.textContent = TONE_LABELS[i - 1] || '';
    if (toneFace) {
      toneFace.title = '第 ' + i + ' 档 · ' + (TONE_LABELS[i - 1] || '');
      const face = TONE_FACES[i - 1] || TONE_FACES[2];
      // 只在真的换档时弹一下，拖动过程中同一个档反复触发会抖
      if (toneFace.textContent !== face) {
        toneFace.textContent = face;
        toneFace.classList.remove('pop');
        void toneFace.offsetWidth;   // 强制重排，让动画能重播
        toneFace.classList.add('pop');
      }
    }
  }

  if (toneRange) {
    toneRange.addEventListener('input', function () {
      paintTone(Number(toneRange.value));
    });
    toneRange.addEventListener('change', function () {
      vscode.postMessage({ type: 'setTone', value: Number(toneRange.value) });
    });
  }

  // ===== 设置面板：右上角齿轮展开，里面放评审参数滑杆 =====
  function paintRange(el) {
    if (!el) return;
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 1;
    const v = Number(el.value);
    el.style.setProperty('--pct', (max > min ? ((v - min) / (max - min) * 100) : 0) + '%');
  }

  function fmtTemp(v) {
    return Number(v).toFixed(2);
  }

  function toggleSettings(open) {
    if (!settingsPanel || !btnSettings) return;
    const next = typeof open === 'boolean' ? open : settingsPanel.classList.contains('hide');
    settingsPanel.classList.toggle('hide', !next);
    btnSettings.classList.toggle('active', next);
    btnSettings.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) vscode.postMessage({ type: 'getSettings' });   // 展开时拉一次，别显示过期值
  }

  if (btnSettings) {
    btnSettings.addEventListener('click', function () { toggleSettings(); });
  }

  if (setTemp) {
    setTemp.addEventListener('input', function () {
      if (setTempVal) setTempVal.textContent = fmtTemp(setTemp.value);
      paintRange(setTemp);
    });
    setTemp.addEventListener('change', function () {
      vscode.postMessage({ type: 'setSetting', key: 'temperature', value: Number(setTemp.value) });
    });
  }

  if (setMax) {
    setMax.addEventListener('input', function () {
      if (setMaxVal) setMaxVal.textContent = String(Math.round(Number(setMax.value)));
      paintRange(setMax);
    });
    setMax.addEventListener('change', function () {
      vscode.postMessage({ type: 'setSetting', key: 'maxFindings', value: Math.round(Number(setMax.value)) });
    });
  }

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    if (!m) return;
    if (m.type === 'status') { statusEl.textContent = m.text || ''; }
    else if (m.type === 'busy') {
      // 评审期间按钮置灰：防重复点击，也让「已经在跑」这件事有个明确的表现
      if (btnAi) btnAi.disabled = !!m.on;
      if (m.on) startLoader(m.at); else stopLoader();
    }
    else if (m.type === 'stage') {
      // 真实动作：取代轮播文案旁边的空白，慢的时候能直接看出卡在 git 还是模型
      if (stageEl) {
        stageEl.textContent = m.text || '';
        stageEl.title = m.text || '';
      }
      tickTime();
    }
    else if (m.type === 'review') { statusEl.textContent = ''; stopLoader(); renderReview(m.review, m.model); }
    else if (m.type === 'tone') {
      const idx = Number(m.index) || 3;
      if (toneRange) toneRange.value = String(idx);
      paintTone(idx);
      if (toneName && m.label) toneName.textContent = m.label;
    }
    else if (m.type === 'settings') {
      if (setTemp) {
        setTemp.value = String(m.temperature);
        if (setTempVal) setTempVal.textContent = fmtTemp(m.temperature);
        paintRange(setTemp);
      }
      if (setMax) {
        setMax.value = String(m.maxFindings);
        if (setMaxVal) setMaxVal.textContent = String(m.maxFindings);
        paintRange(setMax);
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

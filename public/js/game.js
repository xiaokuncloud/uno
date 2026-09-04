/**
 * game.js — 双人 UNO 前端逻辑
 * 支持两种模式：
 *   mode=solo   单机（本地对局 + AI 对手）
 *   mode=create 联机-创建房间（等待对方加入后开局）
 *   mode=join   联机-加入房间
 */
(function () {
  'use strict';

  // ---------- 解析参数 ----------
  const params = new URLSearchParams(location.search);
  const MODE = params.get('mode') || 'solo';
  // 昵称优先级：URL 参数 > 本机已保存 > 随机默认
  const MY_NAME = params.get('name')
    || localStorage.getItem('uno_player_name')
    || ('玩家' + Math.floor(10 + Math.random() * 89));
  localStorage.setItem('uno_player_name', MY_NAME); // 自动持久化

  const S = {
    mode: MODE,
    name: MY_NAME,
    selfIndex: 0,
    ws: null,
    roomId: null,
    solo: null,        // 单机对局对象
    pendingDraw: false, // 单机：我刚抽牌，可结束回合
    aiAction: null,    // 单机：AI 的上一动作（play/draw），用于动画
    unoPrompted: false, // 是否已提示过喊 UNO
    leaveTimer: null,   // 联机：对方离开后的跳首页定时器
    log: [],            // 对局日志（本局发生了什么）
    _lastDetailLogged: '', // 联机：上次已记录的事件，避免重复
    ui: null,          // 当前 UI 快照（联机来自服务器，单机本地生成）
    lastHand: null,    // 最近一次渲染的手牌（供提示高亮）
    hintOn: false      // 提示模式：可出牌高亮
  };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const modeBadge = $('mode-badge');
  const lobbyBox = $('lobby-box');
  const lobbyText = $('lobby-text');
  const lobbyTip = $('lobby-tip');
  const btnStart = $('btn-start');
  const gameBox = $('game-box');

  // ---------- 卡片绘制 ----------
  function cardClass(card) {
    if (!card) return 'c-wild';
    return 'c-' + (card.color || 'wild');
  }
  function cardFace(card) {
    const v = card.value;
    if (v === 'wild') return 'W';
    if (v === '+4') return '+4';
    if (v === '+2') return '+2';
    if (v === 'skip') return 'S';
    if (v === 'reverse') return 'R';
    return String(v);
  }
  // 真实 UNO 素材图（CC0 公有领域，来源：Wikimedia Commons "UNO cards deck.svg"）
  const CARD_IMG_KEY = { '+2': '2p', 'reverse': 'rev', 'skip': 'skip', 'wild': 'wild', '+4': 'p4' };
  function cardImg(card) {
    if (card.value === '+4') return 'p4.webp';
    if (card.color === 'wild') return 'wild.webp';
    const v = CARD_IMG_KEY[card.value] || card.value;
    return `${card.color}_${v}.webp`;
  }
  const COLOR_HEX = { red: '#e63946', blue: '#1d7fd6', green: '#2a9d4f', yellow: '#e6a700' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  }
  // 事件提示 + 当前颜色（颜色词着色）
  function colorInfoHTML(lastDetail, colorName, colorKey) {
    let s = esc(lastDetail);
    if (colorName && colorKey) {
      s += ' · 当前颜色：<span style="color:' + (COLOR_HEX[colorKey] || '#222') + ';font-weight:800">' + colorName + '</span>';
    }
    return s;
  }
  function cardHTML(card, opts = {}) {
    const cls = ['uno-card'];
    if (opts.faceDown) {
      cls.push('face-down');
      return `<div class="${cls.join(' ')}"><img src="/assets/cards/back.webp?v=18" alt=""></div>`;
    }
    cls.push(cardClass(card));
    if (opts.highlight) cls.push('highlight');
    if (opts.disabled) cls.push('disabled');
    return `<div class="${cls.join(' ')}"><img src="/assets/cards/${cardImg(card)}?v=18" alt=""></div>`;
  }

  // ---------- 卡牌预加载 ----------
  function preloadCards() {
    const files = ['back.webp', 'wild.webp', 'p4.webp'];
    ['red', 'blue', 'green', 'yellow'].forEach((c) => {
      for (let v = 0; v <= 9; v++) files.push(c + '_' + v + '.png');
      files.push(c + '_2p.webp', c + '_rev.webp', c + '_skip.webp');
    });
    files.forEach((f) => { const im = new Image(); im.src = '/assets/cards/' + f + '?v=18'; });
  }

  // ---------- 对局日志 ----------
  function addLog(text, kind) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    S.log.push({ time: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), text, kind: kind || '' });
    if (S.log.length > 300) S.log.shift();
  }
  function renderLog() {
    const box = $('log-list');
    if (!box) return;
    box.innerHTML = '';
    if (!S.log.length) {
      box.innerHTML = '<div class="log-empty">还没有对局记录</div>';
      return;
    }
    S.log.forEach((e) => {
      const row = el('div', { class: 'log-row' + (e.kind ? ' log-' + e.kind : '') });
      const tm = el('span', { class: 'log-time' });
      tm.textContent = e.time;
      const tx = el('span', { class: 'log-text' });
      tx.textContent = e.text;
      row.appendChild(tm);
      row.appendChild(tx);
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
  }
  function openLog() { renderLog(); $('log-modal').classList.remove('hidden'); }
  function closeLog() { $('log-modal').classList.add('hidden'); }
  function openHelp() { $('help-modal').classList.remove('hidden'); }
  function closeHelp() { $('help-modal').classList.add('hidden'); }

  // ---------- 弹窗 ----------
  const colorModal = $('color-modal');
  const resultModal = $('result-modal');
  let _colorCb = null;
  // ---------- 提示按钮：高亮可出牌 ----------
  function toggleHint() {
    S.hintOn = !S.hintOn;
    const b = $('btn-hint');
    if (b) b.classList.toggle('active', S.hintOn);
    applyHandHint();
  }
  function applyHandHint() {
    const handEl = $('my-hand');
    const ui = S.ui;
    if (!handEl || !ui || !S.lastHand) return;
    const myTurn = ui.currentTurn === S.selfIndex;
    Array.from(handEl.children).forEach((wrap, i) => {
      const card = S.lastHand[i];
      const c = wrap.querySelector('.uno-card');
      if (!card || !c) return;
      const can = ui.phase === 'playing' && myTurn && UnoCore.canPlay(card, ui.discardTop, ui.chosenColor);
      c.classList.toggle('highlight', S.hintOn && can);
      c.classList.toggle('disabled', S.hintOn && !can);
    });
  }
  function showColorPicker(cb) {
    _colorCb = cb;
    colorModal.classList.remove('hidden');
    const box = $('color-pick');
    box.innerHTML = '';
    const COLORS_MAP = { red: '#e63946', blue: '#1d7fd6', green: '#2a9d4f', yellow: '#f4b400' };
    UnoCore.COLORS.forEach((c) => {
      const wrap = document.createElement('div');
      wrap.className = 'color-item';
      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.style.background = COLORS_MAP[c];
      const label = document.createElement('span');
      label.className = 'color-label';
      label.textContent = UnoCore.COLOR_NAMES[c];
      wrap.appendChild(dot);
      wrap.appendChild(label);
      wrap.onclick = () => { _colorCb = null; colorModal.classList.add('hidden'); cb(c); };
      box.appendChild(wrap);
    });
    // 禁止：不出这张牌
    const no = document.createElement('div');
    no.className = 'color-item no-color';
    no.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#e63946" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5" y1="5" x2="19" y2="19"/></svg>';
    no.title = '不出这张牌';
    no.onclick = () => { _colorCb = null; colorModal.classList.add('hidden'); cb(null); };
    box.appendChild(no);
  }
  function cancelColorPick() {
    colorModal.classList.add('hidden');
    if (_colorCb) _colorCb(null);
    _colorCb = null;
  }
  window.cancelColorPick = cancelColorPick;
  window.toggleHint = toggleHint;
  function hideColorPicker() { _colorCb = null; colorModal.classList.add('hidden'); }
  // ---------- +4 质疑弹窗 ----------
  let _challengeCb = null;
  function showChallengeModal(text, hint, cb) {
    const modal = $('challenge-modal');
    $('challenge-text').textContent = text;
    $('challenge-hint').textContent = hint || '';
    _challengeCb = cb;
    modal.classList.remove('hidden');
  }
  function doChallenge(decision) {
    $('challenge-modal').classList.add('hidden');
    const cb = _challengeCb;
    _challengeCb = null;
    if (cb) cb(decision);
  }
  // ---------- 3D 动画 ----------
  /** 出牌：把点击的牌"飞"向台面顶牌 */
  function animatePlay(fromEl, cb) {
    const clone = fromEl.cloneNode(true);
    const from = fromEl.getBoundingClientRect();
    const toEl = $('table-card');
    if (!toEl) { if (cb) cb(); return; }
    const to = toEl.getBoundingClientRect();
    Object.assign(clone.style, {
      position: 'fixed', zIndex: 300, margin: '0', pointerEvents: 'none',
      left: from.left + 'px', top: from.top + 'px',
      width: from.width + 'px', height: from.height + 'px',
      transition: 'all .42s cubic-bezier(.25,1.2,.35,1)'
    });
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.left = (to.left + to.width / 2 - from.width / 2) + 'px';
      clone.style.top = (to.top + to.height / 2 - from.height / 2) + 'px';
      clone.style.width = to.width + 'px';
      clone.style.height = to.height + 'px';
      clone.style.transform = 'rotateZ(540deg) scale(.9)';
    });
    setTimeout(() => { clone.remove(); if (cb) cb(); }, 450);
  }
  /** 摸牌：从台面抽牌堆"飞"一张牌到手牌区 */
  function animateDraw(cb) {
    const fromEl = $('table-card');
    const toEl = $('my-hand');
    if (!fromEl || !toEl) { if (cb) cb(); return; }
    const from = fromEl.getBoundingClientRect();
    const to = toEl.getBoundingClientRect();
    const w = Math.min(84, from.width), h = w * 1.5;
    const clone = document.createElement('div');
    clone.className = 'uno-card face-down';
    Object.assign(clone.style, {
      position: 'fixed', zIndex: 300, pointerEvents: 'none', margin: '0',
      left: from.left + 'px', top: from.top + 'px',
      width: from.width + 'px', height: from.height + 'px',
      transition: 'all .4s cubic-bezier(.25,1.2,.35,1)'
    });
    document.body.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.left = (to.right - w) + 'px';
      clone.style.top = (to.bottom - h) + 'px';
      clone.style.width = w + 'px';
      clone.style.height = h + 'px';
      clone.style.transform = 'rotateZ(-8deg)';
    });
    setTimeout(() => { clone.remove(); if (cb) cb(); }, 420);
  }
  function showResult(title, text) {
    $('result-title').textContent = title;
    $('result-text').textContent = text;
    resultModal.classList.remove('hidden');
  }
  function hideResult() { resultModal.classList.add('hidden'); }

  // ---------- 聊天 ----------
  function appendChat(name, text, cls) {
    const log = $('chat-log');
    const div = document.createElement('div');
    div.innerHTML = `<span class="${cls || 'sys'}">${esc(name)}：</span>${esc(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 40) log.removeChild(log.firstChild);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  // ---------- Toast 轻提示（替代原生 alert） ----------
  let _toastTimer;
  function toast(msg) {
    const el = $('toast');
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.classList.add('hidden'), 260);
    }, 2400);
  }
  function sendChat(text) {
    if (typeof text !== 'string') {
      text = $('chat-input').value;
      $('chat-input').value = '';
    }
    if (!text.trim()) return;
    if (S.mode === 'solo') {
      appendChat(S.name, text.trim(), 'me');
      setTimeout(() => appendChat('AI', '（我是 AI，只能看到你发的话~）', 'other'), 400);
    } else {
      sendWs({ action: 'chat', text: text.trim() });
    }
  }

  // ---------- WebSocket ----------
  function sendWs(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
  }
  function connectOnline() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    S.ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(S.roomId || 'lobby')}`);
    S.ws.onopen = () => {
      // 优先重连上次对局（localStorage 存有房间号，且当前未显式 join 其它房间）
      const savedRoom = localStorage.getItem('uno_room_id');
      const savedIdx = localStorage.getItem('uno_self_index');
      const isJoinWithRoom = S.mode === 'join' && params.get('room');
      if (savedRoom && !isJoinWithRoom) {
        S.reconnecting = true;
        S.roomId = savedRoom;
        S.mode = 'join';
        sendWs({ action: 'joinRoom', roomId: savedRoom, name: S.name, selfIndex: savedIdx != null ? Number(savedIdx) : undefined });
        return;
      }
      // create 与 join 统一走 joinRoom；若 join 刷新的是本机上次房间，带 selfIndex 精确重连防变房主
      const sameRoom = savedRoom === S.roomId && savedIdx != null;
      let rejoinIdx;
      if (sameRoom) {
        const idx = Number(savedIdx);
        // join 模式下 selfIndex=0 是共享 localStorage 的房主残留，忽略（防抢房主）；玩家2(1) 才精确重连
        rejoinIdx = (S.mode === 'join' && idx === 0) ? undefined : idx;
      }
      sendWs({ action: 'joinRoom', roomId: S.roomId, name: S.name, selfIndex: rejoinIdx });
    };
    S.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      handleOnlineMsg(m);
    };
    S.ws.onclose = () => {
      clearInterval(S._hb);
      if (S.mode !== 'solo') {
        appendChat('系统', '连接断开，正在尝试重连…', 'sys');
        if (S._reconnTimer) clearTimeout(S._reconnTimer);
        if ((S._reconnCount || 0) < 4) {
          S._reconnCount = (S._reconnCount || 0) + 1;
          S._reconnTimer = setTimeout(() => connectOnline(), 1600);
        } else {
          toast('重连失败，请刷新页面');
        }
      }
    };
    S.ws.onerror = () => toast('无法连接服务器，请刷新重试');
    // 心跳：每 15s 发一条消息，防止 CF 空闲回收 WebSocket 导致房主“悄悄离线”
    clearInterval(S._hb);
    S._hb = setInterval(() => {
      if (S.ws && S.ws.readyState === WebSocket.OPEN) {
        S.ws.send(JSON.stringify({ action: 'ping', selfIndex: S.selfIndex }));
      }
    }, 15000);
  }

  function handleOnlineMsg(m) {
    switch (m.action) {
      case 'roomCreated':
        S.selfIndex = m.playerIndex;
        S.roomId = m.roomId;
        sendWs({ action: 'reg', selfIndex: S.selfIndex });
        localStorage.setItem('uno_room_id', m.roomId);
        localStorage.setItem('uno_self_index', String(m.playerIndex));
        modeBadge.textContent = '房间 ' + m.roomId;
        lobbyBox.classList.remove('hidden');
        lobbyText.textContent = '房间已创建，房间号 ' + m.roomId;
        lobbyTip.textContent = '点下方「复制分享链接」，发给对方点开即可直接加入';
        $('btn-share').classList.remove('hidden');
        break;
      case 'joined':
        S.selfIndex = m.playerIndex;
        if (m.playerNames && m.playerNames[m.playerIndex]) S.name = m.playerNames[m.playerIndex];
        sendWs({ action: 'reg', selfIndex: S.selfIndex });
        S.roomId = S.roomId || m.roomId || localStorage.getItem('uno_room_id') || '';
        localStorage.setItem('uno_room_id', S.roomId);
        localStorage.setItem('uno_self_index', String(m.playerIndex));
        lobbyBox.classList.remove('hidden');
        if (m.reconnected) {
          lobbyText.textContent = '已重连房间 ' + (S.roomId || '');
          lobbyTip.textContent = '对局已恢复，等待对方或继续游戏…';
          toast('重连成功，对局已恢复');
        } else {
          lobbyText.textContent = '已加入房间 ' + (S.roomId || '');
          lobbyTip.textContent = '等待房主开始游戏…';
        }
        break;
      case 'peerJoined':
        lobbyBox.classList.remove('hidden');
        lobbyText.textContent = (m.playerNames && m.playerNames[1]) + ' 已加入！';
        lobbyTip.textContent = '双方就绪，点击开始';
        btnStart.classList.remove('hidden');
        break;
      case 'error':
        if (S.reconnecting) {
          // 原房间已销毁或不可重连 → 清缓存，按当前模式重新创建/加入
          S.reconnecting = false;
          localStorage.removeItem('uno_room_id');
          if (S.mode === 'create') {
            S.roomId = String(Math.floor(100000 + Math.random() * 900000));
            localStorage.setItem('uno_room_id', S.roomId);
            sendWs({ action: 'joinRoom', roomId: S.roomId, name: S.name });
          } else { toast(m.msg + '，请重新创建房间'); location.href = '/'; }
          break;
        }
        toast(m.msg);
        break;
      case 'state':
        S.ui = m.game;
        lobbyBox.classList.add('hidden');
        gameBox.classList.remove('hidden');
        modeBadge.textContent = '房间 ' + (S.roomId || '');
        drawUI(S.ui);
        // 事件日志：记录服务端广播的对局事件
        if (m.game.lastDetail && m.game.lastDetail !== S._lastDetailLogged) {
          S._lastDetailLogged = m.game.lastDetail;
          addLog(m.game.lastDetail, 'sys');
        }
        // 定庄阶段：显示抽牌定庄弹窗
        if (S.ui.phase === 'drawing') showDealerModal(S.ui);
        else hideDealerModal();
        break;
      case 'chat':
        appendChat(m.name, m.text, m.name === S.name ? 'me' : 'other');
        break;
      case 'offerChallenge':
        showChallengeModal(
          m.byName + ' 打出 +4！',
          '质疑若成功，对方违规罚抽 4 张；若对方无牌可出，你抽 6 张',
          (decision) => sendWs({ action: 'challenge', decision })
        );
        break;
      case 'rematchNotice':
        hideResult();
        toast(m.byName + ' 发起再来一局，即将开始！');
        break;
      case 'peerLeft':
        appendChat('系统', m.name + ' 暂时离线，60 秒内可自动重连', 'sys');
        toast(m.name + ' 暂时离线，对方可在 60 秒内重连');
        break;
      case 'roomDestroyed':
        toast('房间已销毁，即将返回首页');
        localStorage.removeItem('uno_room_id');
        if (S.leaveTimer) clearTimeout(S.leaveTimer);
        setTimeout(() => { location.href = '/'; }, 800);
        break;
    }
  }

  function onlineStart() {
    sendWs({ action: 'startGame' });
  }

  // ---------- UI 渲染 ----------
  function drawUI(ui) {
    const self = ui.selfIndex;
    const opp = 1 - self;
    const myTurn = ui.phase === 'playing' && ui.currentTurn === self;
    const oppTurn = ui.phase === 'playing' && ui.currentTurn === opp;

    $('my-name').textContent = ui.playerNames[self] || '我';
    $('opp-name').textContent = ui.playerNames[opp] || '对手';
    modeBadge.textContent = S.mode === 'solo' ? '单机模式' : ('房间 ' + (S.roomId || ''));

    $('opp-turn').classList.toggle('hidden', !oppTurn);

    // 状态提示：显示在玩家昵称旁（"轮到你出牌"高亮）
    const myStatusEl = $('my-turn');
    if (ui.phase === 'ended') myStatusEl.textContent = (ui.winner === self ? '你赢了！' : 'AI 获胜');
    else if (ui.phase === 'drawing') myStatusEl.textContent = '抽牌定庄…';
    else myStatusEl.textContent = myTurn ? '轮到你出牌' : '等待对手…';
    myStatusEl.classList.toggle('on', !!myTurn);

    // 对手手牌（背面）
    const oppCards = $('opp-cards');
    oppCards.innerHTML = '';
    const n = ui.handCounts[opp] || 0;
    for (let i = 0; i < Math.min(n, 24); i++) {
      oppCards.appendChild(el('div', { class: 'mini-card' }));
    }
    $('opp-status').textContent = n + ' 张手牌' + (ui.uno[opp] ? ' · UNO已喊' : '');

    // 台面：顶牌 + 历史散落牌（随机铺在桌面）。增量渲染：牌面没变就不重建，防止每次 state 全量重画闪烁
    const stackEl = $('table-stack');
    const recent = (ui.recentDiscard && ui.recentDiscard.length) ? ui.recentDiscard : (ui.discardTop ? [ui.discardTop] : []);
    const stackFinger = JSON.stringify(recent);
    if (stackEl._finger !== stackFinger) {
      stackEl._finger = stackFinger;
      stackEl.innerHTML = '';
      if (recent.length) {
        const under = recent.slice(0, -1).slice(-4); // 顶牌之下最近 4 张
        under.forEach((c, i) => {
          const d = el('div', { class: 'scatter-card uno-card' });
          d.innerHTML = cardHTML(c);
          const rot = -24 + ((i * 13) % 48); // 随机角度
          const dx = (i % 2 ? 1 : -1) * (14 + (i % 3) * 16); // 左右错落
          const dy = ((i * 7) % 18) - 5;                     // 上下错落
          d.style.transform = 'rotate(' + rot + 'deg) translate(' + dx + 'px,' + dy + 'px)';
          d.style.zIndex = i;
          stackEl.appendChild(d);
        });
        const topCard = recent[recent.length - 1];
        const tc = el('div', { class: 'big-card uno-card', id: 'table-card' });
        tc.innerHTML = cardHTML(topCard);
        stackEl.appendChild(tc);
      }
    }

    // 台面信息
    const colorName = UnoCore.COLOR_NAMES[ui.chosenColor] || '';
    $('event-info').innerHTML = colorInfoHTML(ui.lastDetail, colorName, ui.chosenColor);
    $('deck-count').textContent = ui.drawPileCount != null ? '(' + ui.drawPileCount + ')' : '';

    // 手牌：增量渲染（牌面没变不重建，减少闪烁）
    const handEl = $('my-hand');
    const myHand = ui.selfHand || [];
    const handFinger = JSON.stringify(myHand);
    if (handEl._finger !== handFinger) {
      handEl._finger = handFinger;
      handEl.innerHTML = '';
      S.lastHand = myHand;
      myHand.forEach((card) => {
        const can = ui.phase === 'playing' && myTurn && UnoCore.canPlay(card, ui.discardTop, ui.chosenColor);
        const div = el('div', { class: 'card-wrap' });
        div.innerHTML = cardHTML(card, S.hintOn ? { highlight: can, disabled: !can } : {});
        div.querySelector('.uno-card').onclick = (e) => onCardClick(card, e);
        handEl.appendChild(div);
      });
    }

    // 按钮状态
    const needUno = (ui.phase === 'playing' && myHand.length === 1 && !ui.uno[self]);
    $('btn-uno').classList.toggle('hidden', !needUno);
    $('btn-uno').classList.toggle('pulse', needUno);
    if (needUno && !S.unoPrompted) {
      S.unoPrompted = true;
      toast('只剩一张牌！记得点 UNO');
    }
    if (!needUno) S.unoPrompted = false;
    $('btn-catch').classList.toggle('hidden', !(ui.phase === 'playing' && ui.handCounts[opp] === 1 && !ui.uno[opp]));
    $('btn-endturn').classList.toggle('hidden', !ui.pendingTurnEnd);
    $('btn-draw').classList.toggle('hidden', !(ui.phase === 'playing' && myTurn && !ui.pendingTurnEnd));
    $('btn-rematch').classList.toggle('hidden', !(ui.phase === 'ended' && S.mode === 'solo'));


    // 结算弹窗（联机：房主可选再来一局/离开，玩家2等待房主）
    if (ui.phase === 'ended' && S.mode !== 'solo') {
      const isHost = self === 0;
      $('btn-result-rematch').classList.toggle('hidden', !isHost);
      $('btn-result-home').classList.toggle('hidden', !isHost);
      $('btn-result-home').textContent = '离开房间';
      showResult(
        ui.winner === self ? '你赢啦！' : '对方获胜',
        isHost ? '本局已结束，是否再来一局？' : '等待房主选择再来一局或离开…'
      );
    } else if (ui.phase === 'ended' && S.mode === 'solo') {
      $('btn-result-rematch').classList.remove('hidden');
      $('btn-result-home').classList.remove('hidden');
      $('btn-result-home').textContent = '返回首页';
    } else if (ui.phase === 'playing') {
      hideResult();
    }
  }

  function el(tag, attrs) {
    const d = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => d.setAttribute(k, attrs[k]));
    return d;
  }

  // ---------- 玩家操作 ----------
  function onCardClick(card, ev) {
    const ui = S.ui;
    if (!ui || ui.phase !== 'playing') return;
    if (S.solo && S.solo.pendingChallenge) { flash('+4 质疑未决，请先处理'); return; }
    const myTurn = ui.currentTurn === ui.selfIndex;
    if (!myTurn) { flash('还没轮到你出牌'); return; }
    if (!UnoCore.canPlay(card, ui.discardTop, ui.chosenColor)) { flash('这张牌颜色或点数不匹配'); return; }
    const el = (ev && ev.currentTarget) || null;
    if (card.color === 'wild') {
      showColorPicker((color) => {
        hideColorPicker();
        if (!color) return; // 取消出牌
        if (el) animatePlay(el, () => doPlay(card, color));
        else doPlay(card, color);
      });
    } else {
      if (el) animatePlay(el, () => doPlay(card, null));
      else doPlay(card, null);
    }
  }
  function doPlay(card, chosenColor) {
    if (S.mode === 'solo') {
      soloPlay(0, card, chosenColor);
    } else {
      sendWs({ action: 'playCard', card, chosenColor });
    }
  }
  function doDraw() {
    if (S.mode === 'solo') {
      animateDraw(() => soloDraw(0));
    } else {
      // 先发请求再播动画（动画与网络并行，减少等待感）
      sendWs({ action: 'drawCard' });
      animateDraw(() => {});
    }
  }
  function doEndTurn() {
    if (S.mode === 'solo') {
      S.pendingDraw = false;
      S.solo.currentTurn = 1;
      addLog('你结束回合', 'sys');
      soloRender();
      setTimeout(soloAITurn, 700);
    } else {
      sendWs({ action: 'endTurn' });
    }
  }
  function doCallUno() {
    if (S.mode === 'solo') {
      if (S.solo.hands[0].length === 1) {
        S.solo.uno[0] = true;
        addLog('你喊了 UNO！', 'uno');
        soloRender();
      }
    } else sendWs({ action: 'callUno' });
  }
  function doCatchUno() {
    if (S.mode === 'solo') {
      const g = S.solo;
      if (g.hands[1].length === 1 && !g.uno[1]) {
        const d = UnoCore.drawCards(g.deck, g.discardPile, 2);
        g.hands[1].push(...d);
        g.uno[1] = true;
        addLog('你抓到 AI 没喊 UNO，AI 罚抽 2 张！', 'sys');
        appendChat('系统', '你抓到 AI 没喊 UNO，AI 罚抽 2 张！', 'sys');
        soloRender();
      }
    } else sendWs({ action: 'catchUno' });
  }
  function doRematch() {
    if (S.mode === 'solo') {
      hideResult();
      soloNewGame();
    } else {
      S.log.length = 0;
      sendWs({ action: 'rematch' });
    }
  }
  function goHome() {
    clearSoloState();
    if (S.mode !== 'solo' && S.roomId) {
      localStorage.removeItem('uno_room_id');
      sendWs({ action: 'leaveRoom', roomId: S.roomId });
      // 等 leaveRoom 送达服务器（对方收到“房主离开”提示）再跳转
      setTimeout(() => { location.href = '/'; }, 250);
      return;
    }
    location.href = '/';
  }
  // 复制文本（优先 Clipboard API，降级 execCommand）
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const el = document.createElement('textarea');
    el.value = t;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(el);
  }
  /** 分享：本地生成二维码 + 链接（对方扫码/点开自动加入本房间） */
  function shareRoom() {
    const link = location.origin + '/game.html?mode=join&room=' + S.roomId;
    S._shareLink = link;
    try {
      const qrLib = qrcode(0, 'M');
      qrLib.addData(link);
      qrLib.make();
      const cv = document.createElement('canvas');
      const size = qrLib.getModuleCount();
      const scale = Math.max(2, Math.floor(200 / size));
      const px = size * scale;
      cv.width = cv.height = px;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = '#1f2937';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (qrLib.isDark(r, c)) ctx.fillRect(c * scale, r * scale, scale, scale);
        }
      }
      const img = document.getElementById('share-qr');
      if (img) img.src = cv.toDataURL('image/png');
    } catch (e) {
      console.error('二维码生成失败', e);
      try { toast('二维码生成失败：' + (e && e.message || e)); } catch (e2) {}
    }
    const modal = $('share-modal');
    if (modal) modal.classList.remove('hidden');
  }
  function copyShareLink() {
    const link = S._shareLink || (location.origin + '/game.html?mode=join&room=' + S.roomId);
    copyText(link);
    toast('链接已复制，发给好友点开即可加入');
  }
  function closeShare() {
    const modal = $('share-modal');
    if (modal) modal.classList.add('hidden');
  }
  /** 复制 6 位房间号 */
  function copyRoom() {
    copyText(S.roomId || '');
    toast('房间号已复制：' + S.roomId);
  }

  // 顶部提示小闪（简单实现）
  let _flashTimer;
  function flash(msg) {
    $('event-info').textContent = msg;
    clearTimeout(_flashTimer);
    _flashTimer = setTimeout(() => {
      const ui = S.ui;
      if (ui) $('event-info').innerHTML = colorInfoHTML(ui.lastDetail, UnoCore.COLOR_NAMES[ui.chosenColor], ui.chosenColor);
    }, 1600);
  }

  // ---------- 定庄弹窗 ----------
  function showDealerModal(g) {
    const self = g.selfIndex || 0;
    const meCard = g.dealerCards ? g.dealerCards[self] : null;
    const oppCard = g.dealerCards ? g.dealerCards[1 - self] : null;
    const meName = (g.playerNames || [])[self] || '我';
    const oppName = (g.playerNames || [])[1 - self] || '对手';
    $('dealer-me-name').textContent = meName;
    $('dealer-opp-name').textContent = oppName;
    $('dealer-me-card').innerHTML = meCard ? cardHTML(meCard) : '';
    $('dealer-opp-card').innerHTML = oppCard ? cardHTML(oppCard) : '';
    const score = (c) => (c && typeof c.value === 'number' ? c.value : 0);
    $('dealer-me-score').textContent = '点数 ' + score(meCard);
    $('dealer-opp-score').textContent = '点数 ' + score(oppCard);
    const first = g.firstPlayer;
    $('dealer-result').textContent = first === self
      ? '你抽到更大的牌，由你先出牌！'
      : oppName + ' 抽到更大的牌，由对方先出牌';
    $('dealer-modal').classList.remove('hidden');
  }
  function hideDealerModal() {
    $('dealer-modal').classList.add('hidden');
  }
  /** 定庄完成，进入正式对局 */
  function doStartPlay() {
    if (S.mode === 'solo') {
      const g = S.solo;
      g.phase = 'playing';
      g._lastDetail = (g.currentTurn === 0 ? '你' : 'AI') + ' 先出牌！';
      addLog('定庄结果：' + (g.currentTurn === 0 ? '你' : 'AI') + ' 先出牌', 'start');
      hideDealerModal();
      soloRender();
      if (g.currentTurn === 1) setTimeout(soloAITurn, (g.hands[0].length === 1 && !g.uno[0]) ? 3000 : 800);
    } else {
      sendWs({ action: 'startPlay' });
    }
  }
  // ---------- 单机模式 ----------
  function soloNewGame() {
    clearSoloState();
    S.solo = UnoCore.createGame([S.name, 'AI']);
    S.log.length = 0;
    addLog('新对局开始，抽牌定庄…', 'start');
    // 抽牌定庄：决定玩家与 AI 谁先手
    const deal = UnoCore.decideDealer(S.solo.deck, S.solo.discardPile);
    S.solo.dealerCards = deal.cards;
    S.solo.firstPlayer = deal.firstIndex;
    S.solo.currentTurn = deal.firstIndex;
    S.solo.phase = 'drawing';
    S.solo.deck.push(...deal.cards);
    S.pendingDraw = false;
    lobbyBox.classList.add('hidden');
    gameBox.classList.remove('hidden');
    soloRender();
    showDealerModal(S.solo);
  }
  function soloUI() {
    const g = S.solo;
    return {
      selfIndex: 0,
      playerNames: [S.name, 'AI'],
      handCounts: [g.hands[0].length, g.hands[1].length],
      selfHand: g.hands[0],
      discardTop: g.discardPile[g.discardPile.length - 1],
      recentDiscard: g.discardPile.slice(-6),
      chosenColor: g.chosenColor,
      currentTurn: g.currentTurn,
      phase: g.phase,
      winner: g.winner,
      uno: g.uno,
      drawPileCount: g.deck.length,
      lastDetail: g._lastDetail || '',
      pendingTurnEnd: S.pendingDraw && g.currentTurn === 0
    };
  }
  // 统一渲染入口：同步 S.ui 并刷新 DOM
  function soloRender() {
    S.ui = soloUI();
    drawUI(S.ui);
    aiActionFx();
    saveSoloState();
  }
  // ---------- 单机对局持久化：离开页面/刷新后自动恢复 ----------
  const SOLO_KEY = 'uno_solo_state_v1';
  function saveSoloState() {
    if (S.mode !== 'solo' || !S.solo) return;
    try {
      localStorage.setItem(SOLO_KEY, JSON.stringify({
        solo: S.solo, log: S.log, pendingDraw: S.pendingDraw, name: S.name
      }));
    } catch (e) { /* 存储不可用时静默 */ }
  }
  function clearSoloState() { try { localStorage.removeItem(SOLO_KEY); } catch (e) {} }
  /** 尝试恢复上次未结束的单机对局；成功返回 true */
  function tryRestoreSolo() {
    let raw; try { raw = localStorage.getItem(SOLO_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const saved = JSON.parse(raw);
      if (!saved || !saved.solo) return false;
      if (saved.solo.phase === 'ended' || saved.solo.winner) { clearSoloState(); return false; }
      S.solo = saved.solo;
      S.log = saved.log || [];
      S.pendingDraw = saved.pendingDraw || false;
      if (saved.name) S.name = saved.name;
      // 刷新时若正处于 +4 质疑未决，按“未质疑”处理继续对局
      if (S.solo.pendingChallenge) {
        S.solo.pendingChallenge = null;
        addLog('（刷新恢复，未决质疑已跳过）', 'sys');
      }
      return true;
    } catch (e) { clearSoloState(); return false; }
  }
  /** AI 出牌/抽牌动画：从 AI 区域或牌堆飞向目标 */
  function aiActionFx() {
    const act = S.aiAction;
    if (!act) return;
    S.aiAction = null;
    const toEl = $('table-card');
    if (!toEl) return;
    const to = toEl.getBoundingClientRect();
    if (act.type === 'play') {
      const w = 70, h = 107;
      const clone = document.createElement('div');
      clone.className = 'uno-card';
      clone.innerHTML = `<img src="/assets/cards/${cardImg(act.card)}?v=14" alt="">`;
      Object.assign(clone.style, {
        position: 'fixed', zIndex: 300, pointerEvents: 'none', margin: '0',
        left: (to.left + to.width / 2 - w / 2) + 'px',
        top: (to.top - 190) + 'px',
        width: w + 'px', height: h + 'px',
        transform: 'rotateZ(-18deg) scale(.55)',
        opacity: 0,
        transition: 'all .45s cubic-bezier(.2,1.15,.35,1)'
      });
      document.body.appendChild(clone);
      requestAnimationFrame(() => {
        clone.style.left = (to.left + to.width / 2 - w / 2) + 'px';
        clone.style.top = (to.top + to.height / 2 - h / 2) + 'px';
        clone.style.transform = 'rotateZ(0deg) scale(1)';
        clone.style.opacity = 1;
      });
      setTimeout(() => clone.remove(), 480);
    } else if (act.type === 'draw') {
      const w = 46, h = 70;
      const clone = document.createElement('div');
      clone.className = 'uno-card face-down';
      clone.innerHTML = '<img src="/assets/cards/back.webp?v=18" alt="">';
      const oppEl = document.querySelector('.opp-cards');
      const endX = oppEl ? (oppEl.getBoundingClientRect().right - w) : (to.left + 60);
      Object.assign(clone.style, {
        position: 'fixed', zIndex: 300, pointerEvents: 'none', margin: '0',
        left: (to.left + to.width / 2 - w / 2) + 'px',
        top: (to.top + to.height / 2 - h / 2) + 'px',
        width: w + 'px', height: h + 'px',
        transform: 'rotateZ(0)',
        opacity: 0,
        transition: 'all .4s cubic-bezier(.2,1.1,.35,1)'
      });
      document.body.appendChild(clone);
      requestAnimationFrame(() => {
        clone.style.left = endX + 'px';
        clone.style.top = '120px';
        clone.style.transform = 'rotateZ(8deg)';
        clone.style.opacity = 1;
      });
      setTimeout(() => clone.remove(), 430);
    }
  }
  function soloPlay(idx, card, chosenColor) {
    const g = S.solo;
    const hand = g.hands[idx];
    const i = hand.findIndex((c) => c.color === card.color && c.value === card.value);
    if (i < 0) return;
    const played = hand.splice(i, 1)[0];
    g.discardPile.push(played);
    g.prevChosen = g.chosenColor; // 记录出牌前当前颜色（+4 质疑判定用）
    g.chosenColor = played.color === 'wild' ? chosenColor : played.color;
    S.pendingDraw = false;
    if (idx === 1) S.aiAction = { type: 'play', card: played }; // 记录 AI 出牌，用于动画
    soloAfterPlay(idx, played);
  }
  function soloAfterPlay(idx, played) {
    const g = S.solo;
    const opp = 1 - idx;
    if (g.hands[idx].length === 0) {
      g.phase = 'ended';
      g.winner = idx;
      g.uno[idx] = true;
      g._lastDetail = (idx === 0 ? '你' : 'AI') + ' 手牌清空，获胜！';
      addLog((idx === 0 ? '你' : 'AI') + ' 手牌清空，本局获胜！', 'win');
      soloRender();
      if (idx === 0) showResult('你赢啦！', '手牌清空，AI 甘拜下风！');
      return;
    }
    if (g.hands[idx].length === 1) g.uno[idx] = (idx === 1); // AI 自动喊 UNO；玩家需手动喊（有高亮提示）

    const t = UnoCore.effectType(played);
    const me = idx === 0 ? '你' : 'AI';
    const foe = idx === 0 ? 'AI' : '你';
    let detail = me + ' 打出' + UnoCore.cardLabel(played);
    if (t === '+2') {
      const d = UnoCore.drawCards(g.deck, g.discardPile, 2);
      g.hands[opp].push(...d);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      detail = me + ' 打出+2，' + foe + ' 抽 2 张并跳过！';
    } else if (t === '+4') {
      // +4 质疑：对手可选质疑。判定 = 出牌方打 +4 前手中是否有可出之牌
      const beforeTop = g.discardPile[g.discardPile.length - 2];
      const effColor = beforeTop && beforeTop.color === 'wild'
        ? (g.prevChosen != null ? g.prevChosen : 'red')
        : (beforeTop ? beforeTop.color : null);
      const hasPlayable = g.hands[idx].some((c) => UnoCore.canPlay(c, beforeTop, effColor));
      g.pendingChallenge = { target: idx, challenger: opp, hasPlayable };
      g._lastDetail = me + ' 打出+4！' + foe + ' 可以选择质疑';
      addLog(me + ' 打出+4（选色），' + foe + ' 可选择质疑', 'play');
      soloRender();
      if (opp === 0) {
        // AI 出+4，玩家选择
        showChallengeModal(
          'AI 打出 +4！',
          hasPlayable ? 'AI 手中疑似有可出之牌，要质疑吗？' : 'AI 看起来无牌可出，质疑有风险',
          (decision) => resolveSoloChallenge(decision)
        );
      } else {
        // 玩家出+4，AI 决定：玩家若违规（有可出牌）大概率质疑
        const aiDecision = hasPlayable && Math.random() < 0.9;
        setTimeout(() => resolveSoloChallenge(aiDecision), 700);
      }
      return;
    } else if (t === 'skip' || t === 'reverse') {
      detail = me + ' 打出' + UnoCore.cardLabel(played) + '，' + foe + ' 被跳过！';
    }
    const skips = UnoCore.skipsOpponent(played);
    if (!skips) g.currentTurn = opp;
    g._lastDetail = detail;
    addLog(detail, 'play');
    soloRender();
    if (g.phase === 'playing' && g.currentTurn === 1) {
      // 玩家刚出牌剩 1 张时，给足喊 UNO 的窗口再让 AI 行动
      const playerOneLeft = (idx === 0 && g.hands[0].length === 1 && !g.uno[0]);
      setTimeout(soloAITurn, playerOneLeft ? 3000 : 850);
    }
  }
  /** 单机 +4 质疑结算 */
  function resolveSoloChallenge(decision) {
    const g = S.solo;
    if (!g || !g.pendingChallenge) return;
    const pc = g.pendingChallenge;
    g.pendingChallenge = null;
    const target = pc.target, opp = pc.challenger;
    const nm = (i) => (i === 0 ? '你' : 'AI');
    if (!decision) {
      const d = UnoCore.drawCards(g.deck, g.discardPile, 4);
      g.hands[opp].push(...d);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      g.currentTurn = target;
      g._lastDetail = nm(target) + ' 打出+4，' + nm(opp) + ' 未质疑，抽 4 张并跳过！';
    } else if (pc.hasPlayable) {
      const d = UnoCore.drawCards(g.deck, g.discardPile, 4);
      g.hands[target].push(...d);
      if (g.hands[target].length > 1) g.uno[target] = false;
      g.currentTurn = opp;
      g._lastDetail = nm(opp) + ' 质疑成功！' + nm(target) + ' 违规出+4，罚抽 4 张！';
    } else {
      const d = UnoCore.drawCards(g.deck, g.discardPile, 6);
      g.hands[opp].push(...d);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      g.currentTurn = target;
      g._lastDetail = nm(opp) + ' 质疑失败！抽 6 张并跳过！';
    }
    addLog(g._lastDetail, 'sys');
    soloRender();
    if (g.phase === 'playing' && g.currentTurn === 1) setTimeout(soloAITurn, (g.hands[0].length === 1 && !g.uno[0]) ? 3000 : 850);
  }
  function soloDraw(idx) {
    const g = S.solo;
    if (!g) return;
    if (g.pendingChallenge) { flash('+4 质疑未决，请先处理'); return; }
    const drawn = UnoCore.drawCards(g.deck, g.discardPile, 1);
    if (!drawn.length) { flash('牌堆已空'); return; }
    g.hands[idx].push(...drawn);
    if (g.hands[idx].length > 1) g.uno[idx] = false; // 抽牌后不再剩 1 张，重置 UNO 状态
    S.pendingDraw = true;
    const hasMove = g.hands[idx].some((c) => UnoCore.canPlay(c, g.discardPile[g.discardPile.length - 1], g.chosenColor));
    g._lastDetail = '你抽了 1 张牌' + (hasMove ? '（可出牌或结束回合）' : '（无可出之牌，请结束回合）');
    addLog('你抽了 1 张牌：' + UnoCore.cardLabel(drawn[0]), 'draw');
    soloRender();
  }
  function soloAITurn() {
    const g = S.solo;
    if (!g || g.phase !== 'playing' || g.currentTurn !== 1) return;
    // 抓玩家 UNO
    if (g.hands[0].length === 1 && !g.uno[0] && Math.random() < 0.6) {
      const d = UnoCore.drawCards(g.deck, g.discardPile, 2);
      g.hands[0].push(...d);
      g.uno[0] = true;
      addLog('AI 抓到你没喊 UNO，你罚抽 2 张！', 'sys');
      appendChat('系统', 'AI 抓到你没喊 UNO，你罚抽 2 张！', 'sys');
    }
    const top = g.discardPile[g.discardPile.length - 1];
    let card = UnoCore.aiChooseCard(g.hands[1], top, g.chosenColor);
    if (card) {
      const color = card.color === 'wild' ? UnoCore.aiChooseColor(g.hands[1]) : null;
      soloPlay(1, card, color);
      return;
    }
    // 抽牌后尝试出
    const drawn = UnoCore.drawCards(g.deck, g.discardPile, 1);
    if (drawn.length) {
      S.aiAction = { type: 'draw' }; // AI 抽牌动画
      g.hands[1].push(drawn[0]);
      addLog('AI 抽了 1 张牌', 'draw');
      const top2 = g.discardPile[g.discardPile.length - 1];
      const card2 = UnoCore.aiChooseCard(g.hands[1], top2, g.chosenColor);
      if (card2) {
        const color2 = card2.color === 'wild' ? UnoCore.aiChooseColor(g.hands[1]) : null;
        soloPlay(1, card2, color2);
        return;
      }
    }
    g.currentTurn = 0;
    g._lastDetail = 'AI 无牌可出，结束回合';
    addLog('AI 无牌可出，结束回合', 'sys');
    soloRender();
  }

  // ---------- 启动 ----------
  // 暴露给内联 onclick 的全局函数
  window.doDraw = doDraw;
  window.doEndTurn = doEndTurn;
  window.doCallUno = doCallUno;
  window.doCatchUno = doCatchUno;
  window.doRematch = doRematch;
  window.goHome = goHome;
  window.copyRoom = copyRoom;
  window.shareRoom = shareRoom;
  window.copyShareLink = copyShareLink;
  window.closeShare = closeShare;
  window.sendChat = sendChat;
  window.onlineStart = onlineStart;
  window.doStartPlay = doStartPlay;
  window.doChallenge = doChallenge;
  window.showChallengeModal = showChallengeModal;
  window.openHelp = openHelp;
  window.closeHelp = closeHelp;
  window.openLog = openLog;
  window.closeLog = closeLog;

  preloadCards(); // 预加载全部卡牌素材，避免出牌时临时加载卡顿

  if (MODE === 'solo') {
    modeBadge.textContent = '单机模式';
    if (tryRestoreSolo()) {
      // 恢复上次未结束的单机对局
      lobbyBox.classList.add('hidden');
      gameBox.classList.remove('hidden');
      soloRender();
      if (S.solo.phase === 'drawing') {
        showDealerModal(S.solo);
      } else if (S.solo.phase === 'playing' && S.solo.currentTurn === 1) {
        addLog('（继续上次对局）', 'sys');
        setTimeout(soloAITurn, 800);
      } else {
        addLog('（继续上次对局）', 'sys');
      }
    } else {
      soloNewGame();
    }
  } else {
    S.roomId = params.get('room');
    if (!S.roomId) {
      // Cloudflare DO 版：房间号由前端生成（每个房号=一个 Durable Object）
      S.roomId = String(Math.floor(100000 + Math.random() * 900000));
      localStorage.setItem('uno_room_id', S.roomId);
    }
    connectOnline();
  }

  // 将按钮事件挂到 window
  $('btn-start').onclick = onlineStart;
  $('btn-draw').onclick = doDraw;
  $('btn-uno').onclick = doCallUno;
  $('btn-catch').onclick = doCatchUno;
  $('btn-endturn').onclick = doEndTurn;
  $('btn-rematch').onclick = doRematch;
})();

// ===== 背景音乐：状态记忆 + 自动补播（除非手动关闭） =====
(function () {
  var bgm = document.getElementById('bgm');
  var btn = document.getElementById('bgm-toggle');
  if (!bgm || !btn) return;
  var KEY = 'uno_bgm_off';
  var on = localStorage.getItem(KEY) !== '1';
  function playTry() {
    if (!bgm.getAttribute('src')) bgm.setAttribute('src', '/assets/bgm.mp3?v=18');
    var p = bgm.play(); if (p && p.catch) p.catch(function(){});
  }
  function apply() {
    btn.classList.toggle('off', !on);
    if (on) playTry(); else bgm.pause();
  }
  btn.addEventListener('click', function () {
    on = !on;
    localStorage.setItem(KEY, on ? '0' : '1');
    apply();
  });
  document.addEventListener('pointerdown', function first() {
    if (on) playTry();
    document.removeEventListener('pointerdown', first);
  });
  setInterval(function () {
    if (on && bgm.paused) playTry();
  }, 3000);
  apply();
})();

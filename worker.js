/**
 * worker.js — 双人 UNO Cloudflare Worker + Durable Objects 版（v2：DO 状态持久化）
 *
 * 部署：wrangler deploy（配合 wrangler.toml + public/ 静态资产 + DO 绑定）
 *
 * v2 修复：Durable Object 空闲会被冻结、内存态会丢（房间消失→好友加入变新房主）。
 * 现在房间状态用 state.storage 持久化 + setAlarm 控制销毁，断线重连/好友加入跨冻结期也可靠。
 *
 * 架构：
 *   - 静态前端（public/）→ Workers Static Assets 自动托管
 *   - /ws?room=xxxx 的 WebSocket 请求 → 路由到 Durable Object（每房间一个实例）
 */

/* =====================================================================
 *  uno-core（内联，纯逻辑，浏览器/Worker 通用）
 * ===================================================================== */
const COLORS = ['red', 'blue', 'green', 'yellow'];
const COLOR_NAMES = { red: '红', blue: '蓝', green: '绿', yellow: '黄' };

function buildDeck() {
  const deck = [];
  for (const c of COLORS) {
    deck.push({ color: c, value: 0 });
    for (let i = 1; i <= 9; i++) {
      deck.push({ color: c, value: i });
      deck.push({ color: c, value: i });
    }
    deck.push({ color: c, value: 'skip' });
    deck.push({ color: c, value: 'skip' });
    deck.push({ color: c, value: 'reverse' });
    deck.push({ color: c, value: 'reverse' });
    deck.push({ color: c, value: '+2' });
    deck.push({ color: c, value: '+2' });
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: '+4' });
  }
  return deck;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function deal(deck, n) {
  return deck.splice(0, n);
}
function drawFirstCard(deck) {
  let card;
  do {
    if (deck.length === 0) break;
    card = deck.shift();
    if (card.color === 'wild') {
      deck.push(card);
      card = null;
    }
  } while (!card);
  return card;
}
function sameFace(a, b) {
  return a.value === b.value;
}
function canPlay(card, top, chosenColor) {
  if (!top) return true;
  const topColor = top.color === 'wild' ? chosenColor : top.color;
  if (card.color === 'wild') return true;
  if (card.color === topColor) return true;
  if (sameFace(card, top)) return true;
  return false;
}
function effectType(card) {
  if (card.color === 'wild') {
    return card.value === '+4' ? '+4' : 'wild';
  }
  switch (card.value) {
    case 'skip': return 'skip';
    case 'reverse': return 'reverse';
    case '+2': return '+2';
    default: return 'number';
  }
}
function skipsOpponent(card) {
  const t = effectType(card);
  return t === 'skip' || t === 'reverse' || t === '+2' || t === '+4';
}
function drawCards(deck, discardPile, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (deck.length === 0) {
      if (discardPile.length <= 1) break;
      const top = discardPile.pop();
      deck.push(...shuffle(discardPile));
      discardPile.length = 0;
      discardPile.push(top);
    }
    if (deck.length === 0) break;
    drawn.push(deck.pop());
  }
  return drawn;
}
function aiChooseCard(hand, top, chosenColor) {
  const playable = hand.filter((c) => canPlay(c, top, chosenColor));
  if (playable.length === 0) return null;
  const rank = { number: 0, '+2': 1, skip: 1, reverse: 1, wild: 2, '+4': 3 };
  playable.sort((a, b) => rank[effectType(a)] - rank[effectType(b)]);
  return playable[0];
}
function aiChooseColor(hand) {
  const count = {};
  for (const c of COLORS) count[c] = 0;
  for (const card of hand) {
    if (card.color !== 'wild') count[card.color] = (count[card.color] || 0) + 1;
  }
  let best = COLORS[0];
  for (const c of COLORS) {
    if (count[c] > count[best]) best = c;
  }
  return best;
}
function cardLabel(card) {
  const col = card.color === 'wild' ? '' : COLOR_NAMES[card.color];
  const val = card.value === 'wild' ? '变色' : card.value === '+4' ? '+4' : card.value === '+2' ? '+2' : card.value === 'skip' ? '跳过' : card.value === 'reverse' ? '反转' : card.value;
  return col + ' ' + val;
}
function decideDealer(deck, discardPile) {
  const score = (c) => (c && typeof c.value === 'number' ? c.value : 0);
  let cards = null;
  let firstIndex = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const a = drawCards(deck, discardPile, 1)[0];
    const b = drawCards(deck, discardPile, 1)[0];
    if (!a || !b) break;
    cards = [a, b];
    const sa = score(a), sb = score(b);
    if (sa !== sb) { firstIndex = sa > sb ? 0 : 1; break; }
  }
  if (!cards) {
    cards = [{ color: 'red', value: 1 }, { color: 'blue', value: 0 }];
    firstIndex = 0;
  }
  return { cards, firstIndex };
}
function createGame(players) {
  const deck = shuffle(buildDeck());
  const hands = players.map(() => deal(deck, 7));
  const top = drawFirstCard(deck);
  const chosenColor = top.color === 'wild' ? 'red' : top.color;
  return {
    players,
    hands,
    deck,
    discardPile: [top],
    chosenColor,
    currentTurn: Math.floor(Math.random() * players.length),
    phase: 'playing',
    winner: null,
    uno: players.map(() => false),
    history: [],
    drawPileCount: deck.length,
    discardCount: 1
  };
}

/* =====================================================================
 *  Durable Object：一个房间 = 一个实例（状态持久化到 storage）
 * ===================================================================== */
export class UnoRoom {
  constructor(state, env) {
    this.state = state;
    this.players = [];            // 内存态：{ws, name, index, offline}
    this.game = null;
    this.pendingTurnEnd = null;
    this.lastEvent = null;
    this.lastDetail = null;
    this.lastPlay = null;
    this.pendingChallenge = null; // 内存态：{target, challenger, hasPlayable, timer}
  }

  /* ---- 持久化：storage 保存纯数据，恢复时 ws 重新绑定 ---- */
  async load() {
    // 内存态已有效（players 含活跃 ws 引用）→ 不覆盖
    if (this.players.length > 0 && this.players.some((p) => p && p.ws)) return;
    const saved = await this.state.storage.get('room');
    if (!saved) return;
    this.players = (saved.playersMeta || []).map((p) => ({ ...p, ws: null }));
    // DO 冻结恢复后 ws 引用丢失：用当前仍活跃的 WebSocket 重新绑定到槽位
    // （双人房间按加入顺序 accept，getWebSockets() 顺序与 players 索引一致）
    const socks = this.state.getWebSockets() || [];
    socks.forEach((s, i) => {
      if (this.players[i]) { this.players[i].ws = s; this.players[i].offline = false; }
    });
    this.game = saved.game || null;
    this.pendingTurnEnd = saved.pendingTurnEnd != null ? saved.pendingTurnEnd : null;
    this.lastEvent = saved.lastEvent || null;
    this.lastDetail = saved.lastDetail || null;
    this.lastPlay = saved.lastPlay || null;
    if (saved.pendingChallenge) {
      this.pendingChallenge = { ...saved.pendingChallenge, timer: null };
    }
  }
  async save() {
    const playersMeta = this.players.map((p) => ({ name: p.name, index: p.index, offline: !!p.offline }));
    await this.state.storage.put('room', {
      playersMeta,
      game: this.game,
      pendingTurnEnd: this.pendingTurnEnd,
      lastEvent: this.lastEvent,
      lastDetail: this.lastDetail,
      lastPlay: this.lastPlay,
      pendingChallenge: this.pendingChallenge ? { target: this.pendingChallenge.target, challenger: this.pendingChallenge.challenger, hasPlayable: this.pendingChallenge.hasPlayable } : null
    });
  }
  /* 没有任何在线的玩家时，6 小时后销毁房间（防房间堆积，短期好友可随时加入）
     alarm 持久化：实例冻结也会触发；玩家重新进入会 deleteAlarm 取消 */
  async scheduleDestroy() {
    await this.state.storage.setAlarm(Date.now() + 6 * 3600 * 1000);
  }
  async alarm() {
    // 还有在线玩家则不销毁
    const online = this.players.filter((p) => !p.offline && p.ws);
    if (online.length > 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.delete('room');
    this.players = [];
    this.game = null;
    this.pendingChallenge = null;
  }

  /* ---- WebSocket 接入 ---- */
  async fetch(request) {
    await this.load();
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('uno room', { status: 200 });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || !msg.action) return;
    if (msg.action === 'ping' || msg.action === 'reg') {
      // 客户端主动注册身份：即使 DO 冻结恢复后 ws 引用丢失，也能把活跃连接绑回自己的槽位
      if (msg.selfIndex != null && msg.selfIndex >= 0 && msg.selfIndex < 2 && this.players[msg.selfIndex]) {
        this.players[msg.selfIndex].ws = ws;
        this.players[msg.selfIndex].offline = false;
      }
      if (msg.action === 'ping') this.send(ws, { action: 'pong' });
      return;
    }
    // 懒绑定兜底：若当前 ws 未在 players 中（冻结恢复后），绑定到无 ws 的槽位
    if (this.indexOf(ws) < 0) {
      const freeIdx = this.players.findIndex((p) => p && !p.ws);
      if (freeIdx >= 0) {
        this.players[freeIdx].ws = ws;
        this.players[freeIdx].offline = false;
      }
    }
    try {
      await this.handleAction(ws, msg);
    } catch (e) {
      this.send(ws, { action: 'error', msg: '服务器处理异常' });
    }
    await this.save();
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.onClose(ws);
    await this.save();
    await this.scheduleDestroy();
  }

  /* ---- 工具 ---- */
  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
  broadcast(obj) {
    this.players.forEach((p) => {
      if (p && p.ws && !p.offline) {
        const msg = { ...obj };
        if (obj.action === 'state') msg.game = this.snapshotFor(p.index);
        this.send(p.ws, msg);
      }
    });
  }
  snapshotFor(selfIndex) {
    const g = this.game;
    if (!g) return null;
    const players = this.players;
    return {
      selfIndex,
      playerNames: players.map((p) => p.name),
      handCounts: g.hands.map((h) => h.length),
      selfHand: g.hands[selfIndex],
      discardTop: g.discardPile[g.discardPile.length - 1],
      recentDiscard: g.discardPile.slice(-6),
      chosenColor: g.chosenColor,
      currentTurn: g.currentTurn,
      phase: g.phase,
      dealerCards: g.dealerCards,
      firstPlayer: g.firstPlayer,
      winner: g.winner,
      uno: g.uno,
      drawPileCount: g.deck.length,
      lastEvent: this.lastEvent,
      lastDetail: this.lastDetail,
      lastPlay: this.lastPlay,
      pendingTurnEnd: this.pendingTurnEnd === selfIndex
    };
  }
  pushState(event, detail, lastPlay) {
    this.lastEvent = event;
    this.lastDetail = detail;
    if (lastPlay) this.lastPlay = lastPlay;
    this.broadcast({ action: 'state' });
  }
  indexOf(ws) {
    return this.players.findIndex((p) => p.ws === ws);
  }

  /* ---- 游戏流程 ---- */
  startGame() {
    this.game = createGame(this.players.map((p) => p.name));
    this.pendingTurnEnd = null;
    this.lastPlay = null;
    this.pendingChallenge = null;
    if (this.game.discardPile[0].color === 'wild') {
      this.game.chosenColor = COLORS[0];
    }
    const deal = decideDealer(this.game.deck, this.game.discardPile);
    this.game.dealerCards = deal.cards;
    this.game.firstPlayer = deal.firstIndex;
    this.game.currentTurn = deal.firstIndex;
    this.game.phase = 'drawing';
    this.game.deck.push(...deal.cards);
    this.pushState('drawing', '抽牌定庄，数字大者先出牌');
  }
  afterPlay(playerIndex, playedCard) {
    const g = this.game;
    const player = this.players[playerIndex];
    const opp = 1 - playerIndex;
    if (g.hands[playerIndex].length === 0) {
      g.phase = 'ended';
      g.winner = playerIndex;
      g.uno[playerIndex] = true;
      this.pushState('win', `${player.name} 手牌清空，本局获胜！`);
      return;
    }
    if (g.hands[playerIndex].length === 1) g.uno[playerIndex] = false;
    const t = effectType(playedCard);
    let detail = `${player.name} 打出${cardLabel(playedCard)}`;
    if (t === '+2') {
      const drawn = drawCards(g.deck, g.discardPile, 2);
      g.hands[opp].push(...drawn);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      detail = `${player.name} 打出+2，${this.players[opp].name} 抽 2 张并跳过！`;
    } else if (t === '+4') {
      const beforeTop = g.discardPile[g.discardPile.length - 2];
      const effColor = beforeTop && beforeTop.color === 'wild'
        ? (g.prevChosen != null ? g.prevChosen : 'red')
        : (beforeTop ? beforeTop.color : null);
      const hasPlayable = g.hands[playerIndex].some((c) => canPlay(c, beforeTop, effColor));
      const pc = { target: playerIndex, challenger: opp, hasPlayable, timer: null };
      if (this.state.getWebSockets().length > 0) {
        pc.timer = setTimeout(() => { this.resolveChallenge(false); }, 20000);
      }
      this.pendingChallenge = pc;
      this.lastEvent = 'challenge';
      this.lastDetail = `${player.name} 打出+4！${this.players[opp].name} 可选择质疑`;
      this.lastPlay = { name: player.name, card: playedCard };
      this.broadcast({ action: 'state' });
      const oppWs = this.players[opp].ws;
      if (oppWs && !this.players[opp].offline) this.send(oppWs, { action: 'offerChallenge', byName: player.name });
      return;
    } else if (t === 'skip' || t === 'reverse') {
      detail = `${player.name} 打出${cardLabel(playedCard)}，${this.players[opp].name} 被跳过！`;
    }
    const skips = skipsOpponent(playedCard);
    if (!skips) g.currentTurn = opp;
    this.pushState(t, detail, { name: player.name, card: playedCard });
  }
  resolveChallenge(decision) {
    if (!this.pendingChallenge) return;
    const pc = this.pendingChallenge;
    this.pendingChallenge = null;
    if (pc.timer) { clearTimeout(pc.timer); pc.timer = null; }
    const g = this.game;
    if (!g || g.phase !== 'playing') return;
    const target = pc.target, opp = pc.challenger;
    const tp = this.players[target], op = this.players[opp];
    if (!decision) {
      const drawn = drawCards(g.deck, g.discardPile, 4);
      g.hands[opp].push(...drawn);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      g.currentTurn = target;
      this.pushState('+4', `${op.name} 未质疑，${tp.name} 的+4 生效，${op.name} 抽 4 张并跳过！`, this.lastPlay);
    } else if (pc.hasPlayable) {
      const drawn = drawCards(g.deck, g.discardPile, 4);
      g.hands[target].push(...drawn);
      if (g.hands[target].length > 1) g.uno[target] = false;
      g.currentTurn = opp;
      this.pushState('+4', `${op.name} 质疑成功！${tp.name} 违规出+4，罚抽 4 张！`, this.lastPlay);
    } else {
      const drawn = drawCards(g.deck, g.discardPile, 6);
      g.hands[opp].push(...drawn);
      if (g.hands[opp].length > 1) g.uno[opp] = false;
      g.currentTurn = target;
      this.pushState('+4', `${op.name} 质疑失败！${tp.name} 并无牌可出，${op.name} 抽 6 张并跳过！`, this.lastPlay);
    }
  }

  /* ---- 消息分发 ---- */
  async handleAction(ws, msg) {
    const selfIndex = this.indexOf(ws);
    switch (msg.action) {
      // 房间内第一个 joinRoom = 房主；第二个 = 玩家2；同昵称离线槽位 = 断线重连
      case 'joinRoom': {
        try { await this.state.storage.deleteAlarm(); } catch (e) {} // 有人进房，取消销毁
        const roomId = String(msg.roomId || '');
        let joinName = String(msg.name || '').slice(0, 12);
        // 1) 优先按 selfIndex 精确重连（防止刷新时撞名匹配到房主槽位）
        if (msg.selfIndex != null && msg.selfIndex >= 0 && msg.selfIndex < 2) {
          const slotP = this.players[msg.selfIndex];
          if (slotP && slotP.offline) {
            slotP.ws = ws;
            slotP.offline = false;
            slotP.name = joinName || slotP.name;
            if (this.pendingChallenge) {
              const pc = this.pendingChallenge;
              const op = this.players[pc.opp];
              if (op && op.ws && !op.offline) this.send(op.ws, { action: 'offerChallenge', byName: this.players[pc.target].name });
            }
            if (this.game) {
              this.pushState('rejoin', `${this.players[slotP.index].name} 重新连接`);
            } else {
              this.send(ws, { action: 'joined', playerIndex: slotP.index, playerNames: this.players.map((p) => p.name), reconnected: true });
              const other = this.players.find((p) => !p.offline && p.ws !== ws);
              if (other) this.send(other.ws, { action: 'peerJoined', playerNames: this.players.map((p) => p.name) });
            }
            return;
          }
        }
        // 2) 按名字找离线槽位（兼容旧逻辑）
        const slot = this.players.findIndex((p) => p.offline && p.name === joinName);
        if (slot >= 0) {
          this.players[slot].ws = ws;
          this.players[slot].offline = false;
          if (this.pendingChallenge) {
            const pc = this.pendingChallenge;
            const op = this.players[pc.opp];
            if (op && op.ws && !op.offline) this.send(op.ws, { action: 'offerChallenge', byName: this.players[pc.target].name });
          }
          if (this.game) {
            this.pushState('rejoin', `${this.players[slot].name} 重新连接`);
          } else {
            this.send(ws, { action: 'joined', playerIndex: slot, playerNames: this.players.map((p) => p.name), reconnected: true });
            const other = this.players.find((p) => !p.offline && p.ws !== ws);
            if (other) this.send(other.ws, { action: 'peerJoined', playerNames: this.players.map((p) => p.name) });
          }
          return;
        }
        if (this.players.length >= 2) { this.send(ws, { action: 'error', msg: '房间已满（仅支持双人）' }); return; }
        if (this.game) { this.send(ws, { action: 'error', msg: '游戏已开始，无法中途加入' }); return; }
        if (this.players.length === 0) {
          this.players.push({ ws, name: joinName || '玩家1', index: 0, offline: false });
          this.send(ws, { action: 'roomCreated', roomId, playerIndex: 0 });
        } else {
          // 玩家2 加入时若与房主撞名，自动加序号，避免刷新重连匹配错位
          if (joinName === this.players[0].name) joinName = joinName + '2';
          this.players.push({ ws, name: joinName || '玩家2', index: 1, offline: false });
          this.send(ws, { action: 'joined', playerIndex: 1, playerNames: this.players.map((p) => p.name) });
          const host = this.players[0];
          if (host && host.ws && !host.offline) this.send(host.ws, { action: 'peerJoined', playerNames: this.players.map((p) => p.name) });
        }
        break;
      }
      // 主动离开：立即销毁房间
      case 'leaveRoom': {
        const other = this.players.find((p) => p.ws !== ws && !p.offline);
        if (other && other.ws) {
          this.send(other.ws, { action: 'roomDestroyed' });
          try { other.ws.close(); } catch (e) {}
        }
        if (this.pendingChallenge && this.pendingChallenge.timer) { clearTimeout(this.pendingChallenge.timer); }
        await this.state.storage.deleteAlarm();
        await this.state.storage.delete('room');
        this.players = [];
        this.game = null;
        this.pendingChallenge = null;
        break;
      }
      // 开始游戏
      case 'startGame': {
        if (!this.game) {
          if (this.players.length < 2) { this.send(ws, { action: 'error', msg: '需要两位玩家都加入后才能开始' }); return; }
          this.startGame();
        } else {
          this.send(ws, { action: 'error', msg: '游戏已在进行中' });
        }
        break;
      }
      // 定庄完成
      case 'startPlay': {
        if (!this.game) return;
        if (this.game.phase !== 'drawing') { this.send(ws, { action: 'error', msg: '当前不是定庄阶段' }); return; }
        this.game.phase = 'playing';
        this.pushState('start', `${this.players[this.game.firstPlayer].name} 抽到更大的牌，先出牌！`);
        break;
      }
      // 出牌
      case 'playCard': {
        if (!this.game) return;
        const g = this.game;
        if (g.phase !== 'playing') { this.send(ws, { action: 'error', msg: '游戏未在进行' }); return; }
        if (g.currentTurn !== selfIndex) { this.send(ws, { action: 'error', msg: '还没轮到你出牌' }); return; }
        const card = msg.card;
        if (!card) return;
        const hand = g.hands[selfIndex];
        const idx = hand.findIndex((c) => c.color === card.color && c.value === card.value);
        if (idx < 0) { this.send(ws, { action: 'error', msg: '你手里没有这张牌' }); return; }
        const top = g.discardPile[g.discardPile.length - 1];
        if (!canPlay(hand[idx], top, g.chosenColor)) {
          this.send(ws, { action: 'error', msg: '这张牌不能出，颜色或点数不匹配' });
          return;
        }
        if (card.color === 'wild' && !msg.chosenColor) {
          this.send(ws, { action: 'error', msg: '请选择颜色' });
          return;
        }
        const played = hand.splice(idx, 1)[0];
        g.discardPile.push(played);
        g.prevChosen = g.chosenColor;
        g.chosenColor = played.color === 'wild' ? msg.chosenColor : played.color;
        this.pendingTurnEnd = null;
        if (g.hands[selfIndex].length === 1) g.uno[selfIndex] = false;
        this.afterPlay(selfIndex, played);
        break;
      }
      // 抽牌
      case 'drawCard': {
        if (!this.game) return;
        const g = this.game;
        if (g.phase !== 'playing') return;
        if (g.currentTurn !== selfIndex) { this.send(ws, { action: 'error', msg: '还没轮到你抽牌' }); return; }
        const drawn = drawCards(g.deck, g.discardPile, 1);
        if (drawn.length === 0) { this.send(ws, { action: 'error', msg: '牌堆已空，且无法重置' }); return; }
        g.hands[selfIndex].push(drawn[0]);
        this.pendingTurnEnd = selfIndex;
        const hasMove = g.hands[selfIndex].some((c) => canPlay(c, g.discardPile[g.discardPile.length - 1], g.chosenColor));
        this.pushState('draw', `你抽了 1 张牌${hasMove ? '（有牌可出，可出牌或结束回合）' : '（无可出之牌，请结束回合）'}`, null);
        break;
      }
      // 结束回合
      case 'endTurn': {
        if (!this.game) return;
        const g = this.game;
        if (this.pendingTurnEnd !== selfIndex) { this.send(ws, { action: 'error', msg: '当前无需结束回合' }); return; }
        if (g.currentTurn !== selfIndex) { this.send(ws, { action: 'error', msg: '还没轮到你' }); return; }
        this.pendingTurnEnd = null;
        g.currentTurn = 1 - selfIndex;
        this.pushState('endturn', `${this.players[selfIndex].name} 结束回合`, null);
        break;
      }
      // +4 质疑
      case 'challenge': {
        if (!this.pendingChallenge) { this.send(ws, { action: 'error', msg: '当前没有可质疑的 +4' }); return; }
        if (this.pendingChallenge.challenger !== selfIndex) return;
        this.resolveChallenge(!!msg.decision);
        break;
      }
      // 喊 UNO
      case 'callUno': {
        if (!this.game) return;
        const g = this.game;
        if (g.hands[selfIndex].length !== 1) { this.send(ws, { action: 'error', msg: '手牌不是 1 张时无需喊 UNO' }); return; }
        g.uno[selfIndex] = true;
        this.pushState('uno', `${this.players[selfIndex].name} 喊了 UNO！`, null);
        break;
      }
      // 抓 UNO
      case 'catchUno': {
        if (!this.game) return;
        const g = this.game;
        const target = 1 - selfIndex;
        if (g.hands[target].length !== 1) { this.send(ws, { action: 'error', msg: '对方手牌不是 1 张，无法抓' }); return; }
        if (g.uno[target]) { this.send(ws, { action: 'error', msg: '对方已经喊过 UNO' }); return; }
        const drawn = drawCards(g.deck, g.discardPile, 2);
        g.hands[target].push(...drawn);
        g.uno[target] = true;
        this.pushState('catch', `${this.players[selfIndex].name} 抓到 ${this.players[target].name} 没喊 UNO，罚抽 2 张！`, null);
        break;
      }
      // 聊天
      case 'chat': {
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        const name = (selfIndex >= 0 && this.players[selfIndex]) ? this.players[selfIndex].name : '未知';
        this.broadcast({ action: 'chat', name, text: text.trim() });
        break;
      }
      // 再来一局
      case 'rematch': {
        if (this.game && this.game.phase !== 'ended') { this.send(ws, { action: 'error', msg: '本局还未结束' }); return; }
        this.startGame();
        break;
      }
    }
  }

  /* ---- 断线处理 ---- */
  onClose(ws) {
    const idx = this.indexOf(ws);
    if (idx < 0) return;
    const other = 1 - idx;
    if (this.players[other] && this.players[other].ws && !this.players[other].offline) {
      this.send(this.players[other].ws, { action: 'peerLeft', name: this.players[idx].name, destroyIn: 360, rejoinable: true });
    }
    this.players[idx].offline = true;
    if (this.pendingChallenge && this.pendingChallenge.challenger === idx) {
      // 质疑方离线：按不质疑处理，避免卡局
      this.resolveChallenge(false);
    }
  }
}

/* =====================================================================
 *  Worker 入口：静态资产 + /ws 路由到 DO
 * ===================================================================== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isWs = request.headers.get('Upgrade') === 'websocket' || url.pathname === '/ws';
    if (isWs) {
      const roomId = url.searchParams.get('room') || 'lobby';
      const id = env.UNO_ROOMS.idFromName(roomId);
      const stub = env.UNO_ROOMS.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

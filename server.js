/**
 * server.js — 双人 UNO 服务器
 * 职责：静态文件服务 + WebSocket 房间管理 + 联机权威游戏逻辑
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const Core = require('./public/js/uno-core.js');

const PORT = process.env.PORT || 8787;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 静态文件服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  // 防目录穿越
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => serveStatic(req, res));

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

/** 房间：{ id, players:[{ws,name,index}], game, lastDrawnBy, lastEvent, lastDetail } */
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function makeRoomId() {
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}

/** 生成"面向某个玩家"的状态快照（只含自己手牌，对手只给数量） */
function snapshotFor(room, selfIndex) {
  const g = room.game;
  if (!g) return null;
  const players = room.players;
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
    lastEvent: room.lastEvent,
    lastDetail: room.lastDetail,
    lastPlay: room.lastPlay,
    pendingTurnEnd: room.pendingTurnEnd === selfIndex
  };
}

function broadcast(room, obj) {
  room.players.forEach((p, i) => {
    const msg = { ...obj };
    if (obj.action === 'state') {
      msg.game = snapshotFor(room, i);
    }
    send(p.ws, msg);
  });
}

function roomLog(room) {
  return `[房间 ${room.id}]`;
}

/** 广播一次状态，并附带一条操作提示 */
function pushState(room, event, detail, lastPlay) {
  room.lastEvent = event;
  room.lastDetail = detail;
  if (lastPlay) room.lastPlay = lastPlay;
  broadcast(room, { action: 'state' });
}

function startGame(room) {
  room.game = Core.createGame(room.players.map((p) => p.name));
  room.pendingTurnEnd = null;
  room.lastPlay = null;
  room.pendingChallenge = null;
  // 若初始顶牌是 wild（正常不会，drawFirstCard 已过滤），兜底
  if (room.game.discardPile[0].color === 'wild') {
    room.game.chosenColor = Core.COLORS[0];
  }
  // 抽牌定庄：双方各抽一张坐庄牌，数字大者先出牌
  const deal = Core.decideDealer(room.game.deck, room.game.discardPile);
  room.game.dealerCards = deal.cards;
  room.game.firstPlayer = deal.firstIndex;
  room.game.currentTurn = deal.firstIndex;
  room.game.phase = 'drawing'; // 先进入定庄阶段
  room.game.deck.push(...deal.cards); // 坐庄牌放回牌堆
  pushState(room, 'drawing', '抽牌定庄，数字大者先出牌');
}

/** 结算出牌后的公共流程 */
function afterPlay(room, playerIndex, playedCard) {
  const g = room.game;
  const player = room.players[playerIndex];
  const opp = 1 - playerIndex;

  // 检查胜利
  if (g.hands[playerIndex].length === 0) {
    g.phase = 'ended';
    g.winner = playerIndex;
    g.uno[playerIndex] = true;
    pushState(room, 'win', `${player.name} 手牌清空，本局获胜！🎉`);
    return;
  }
  if (g.hands[playerIndex].length === 1) g.uno[playerIndex] = false;

  const t = Core.effectType(playedCard);
  let detail = `${player.name} 打出${Core.cardLabel(playedCard)}`;

  if (t === '+2') {
    const drawn = Core.drawCards(g.deck, g.discardPile, 2);
    g.hands[opp].push(...drawn);
    if (g.hands[opp].length > 1) g.uno[opp] = false;
    detail = `${player.name} 打出+2，${room.players[opp].name} 抽 2 张并跳过！`;
  } else if (t === '+4') {
    // 发起 +4 质疑：对手可选质疑。判定依据 = 出牌方打 +4 前手中是否有可出之牌
    const beforeTop = g.discardPile[g.discardPile.length - 2];
    const effColor = beforeTop && beforeTop.color === 'wild'
      ? (g.prevChosen != null ? g.prevChosen : 'red')
      : (beforeTop ? beforeTop.color : null);
    const hasPlayable = g.hands[playerIndex].some((c) => Core.canPlay(c, beforeTop, effColor));
    room.pendingChallenge = {
      target: playerIndex,
      challenger: opp,
      hasPlayable,
      timer: setTimeout(() => resolveChallenge(room, false), 20000) // 20s 未回复默认不质疑
    };
    room.lastEvent = 'challenge';
    room.lastDetail = `${player.name} 打出+4！${room.players[opp].name} 可选择质疑`;
    room.lastPlay = { name: player.name, card: playedCard };
    broadcast(room, { action: 'state' });
    send(room.players[opp].ws, { action: 'offerChallenge', byName: player.name });
    return;
  } else if (t === 'skip' || t === 'reverse') {
    detail = `${player.name} 打出${Core.cardLabel(playedCard)}，${room.players[opp].name} 被跳过！`;
  }

  const skips = Core.skipsOpponent(playedCard);
  if (!skips) g.currentTurn = opp;
  pushState(room, t, detail, { name: player.name, card: playedCard });
}

/** +4 质疑结算：decision = 对手是否质疑 */
function resolveChallenge(room, decision) {
  if (!room || !room.pendingChallenge) return;
  const pc = room.pendingChallenge;
  room.pendingChallenge = null;
  if (pc.timer) { clearTimeout(pc.timer); pc.timer = null; }
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const target = pc.target, opp = pc.challenger;
  const tp = room.players[target], op = room.players[opp];
  if (!decision) {
    const drawn = Core.drawCards(g.deck, g.discardPile, 4);
    g.hands[opp].push(...drawn);
    if (g.hands[opp].length > 1) g.uno[opp] = false;
    g.currentTurn = target;
    pushState(room, '+4', `${op.name} 未质疑，${tp.name} 的+4 生效，${op.name} 抽 4 张并跳过！`, room.lastPlay);
  } else if (pc.hasPlayable) {
    const drawn = Core.drawCards(g.deck, g.discardPile, 4);
    g.hands[target].push(...drawn);
    if (g.hands[target].length > 1) g.uno[target] = false;
    g.currentTurn = opp;
    pushState(room, '+4', `${op.name} 质疑成功！${tp.name} 违规出+4，罚抽 4 张！`, room.lastPlay);
  } else {
    const drawn = Core.drawCards(g.deck, g.discardPile, 6);
    g.hands[opp].push(...drawn);
    if (g.hands[opp].length > 1) g.uno[opp] = false;
    g.currentTurn = target;
    pushState(room, '+4', `${op.name} 质疑失败！${tp.name} 并无牌可出，${op.name} 抽 6 张并跳过！`, room.lastPlay);
  }
}

// ---------- WebSocket 消息处理 ----------
wss.on('connection', (ws) => {
  let room = null;
  let selfIndex = -1;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !msg.action) return;

    if (['playCard', 'drawCard', 'endTurn', 'callUno', 'catchUno', 'rematch', 'challenge'].includes(msg.action)) {
      console.log(`${roomLog(room)} RECV ${msg.action} from idx=${selfIndex}`);
    }

    switch (msg.action) {
      // ---- 创建房间 ----
      case 'createRoom': {
        if (room) return send(ws, { action: 'error', msg: '已在房间中' });
        const id = makeRoomId();
        room = { id, players: [], game: null, pendingTurnEnd: null, lastEvent: null, lastDetail: null, lastPlay: null };
        rooms.set(id, room);
        selfIndex = 0;
        room.players.push({ ws, name: String(msg.name || '玩家1').slice(0, 12), index: 0 });
        send(ws, { action: 'roomCreated', roomId: id, playerIndex: 0 });
        console.log(`${roomLog(room)} 创建，等待对手加入…`);
        break;
      }

      // ---- 加入房间（含断线重连）----
      case 'joinRoom': {
        if (room) return send(ws, { action: 'error', msg: '已在房间中' });
        const target = rooms.get(String(msg.roomId || ''));
        if (!target) {
          // 兼容 CF DO 版协议：前端已生成房号，第一个 joinRoom 即创建房间（=房主）
          const id = String(msg.roomId || '');
          const nr = { id, players: [], game: null, pendingTurnEnd: null, lastEvent: null, lastDetail: null, lastPlay: null };
          rooms.set(id, nr);
          room = nr;
          selfIndex = 0;
          room.players.push({ ws, name: String(msg.name || '玩家1').slice(0, 12), index: 0 });
          send(ws, { action: 'roomCreated', roomId: id, playerIndex: 0 });
          console.log(`[房间 ${id}] 创建（前端生成房号），等待对手加入…`);
          return;
        }
        const joinName = String(msg.name || '').slice(0, 12);
        // 断线重连：房间内存在"离线"槽位且昵称匹配 → 恢复该玩家
        const slot = target.players.findIndex((p) => p.offline && p.name === joinName);
        if (slot >= 0) {
          target.players[slot].ws = ws;
          target.players[slot].offline = false;
          if (target._destroyTimer) { clearTimeout(target._destroyTimer); target._destroyTimer = null; }
          room = target;
          selfIndex = slot;
          console.log(`${roomLog(room)} ${target.players[slot].name} 重连成功 (idx=${slot})`);
          if (target.game) {
            // 对局已开始：直接恢复，广播最新状态
            pushState(room, 'rejoin', `${target.players[slot].name} 重新连接`);
            // 若有未决 +4 质疑，重新通知相关玩家
            if (room.pendingChallenge) {
              const pc = room.pendingChallenge;
              const tp = room.players[pc.target], op = room.players[pc.opp];
              if (tp && tp.ws.readyState === 1) send(tp.ws, { action: 'offerChallenge', byName: op.name });
            }
          } else {
            send(ws, { action: 'joined', playerIndex: slot, playerNames: target.players.map((p) => p.name), reconnected: true });
            const other = target.players.find((p) => !p.offline && p.ws !== ws);
            if (other && other.ws.readyState === 1) send(other.ws, { action: 'peerJoined', playerNames: target.players.map((p) => p.name) });
          }
          return;
        }
        if (target.players.length >= 2) return send(ws, { action: 'error', msg: '房间已满（仅支持双人）' });
        if (target.game) return send(ws, { action: 'error', msg: '游戏已开始，无法中途加入' });
        room = target;
        selfIndex = 1;
        room.players.push({ ws, name: joinName || '玩家2', index: 1 });
        send(ws, { action: 'joined', playerIndex: 1, playerNames: room.players.map((p) => p.name) });
        // 通知房主
        send(room.players[0].ws, { action: 'peerJoined', playerNames: room.players.map((p) => p.name) });
        console.log(`${roomLog(room)} 第二位玩家 ${room.players[1].name} 加入，可以开始`);
        break;
      }

      // ---- 主动离开：立即销毁房间（保留原设计）----
      case 'leaveRoom': {
        if (!room) break;
        const other = room.players.find((p) => p.ws !== ws && !p.offline);
        if (other && other.ws.readyState === 1) {
          try { send(other.ws, { action: 'roomDestroyed' }); other.ws.close(); } catch (e) {}
        }
        if (room._destroyTimer) { clearTimeout(room._destroyTimer); room._destroyTimer = null; }
        if (room.pendingChallenge && room.pendingChallenge.timer) { clearTimeout(room.pendingChallenge.timer); }
        rooms.delete(room.id);
        console.log(`${roomLog(room)} 玩家主动离开，房间已销毁`);
        break;
      }

      // ---- 开始游戏 ----
      case 'startGame': {
        if (!room || !room.game) {
          if (room && room.players.length < 2) return send(ws, { action: 'error', msg: '需要两位玩家都加入后才能开始' });
        }
        if (!room || !room.game) {
          if (room) startGame(room);
        } else {
          return send(ws, { action: 'error', msg: '游戏已在进行中' });
        }
        break;
      }
      // ---- 定庄完成，开始正式对局 ----
      case 'startPlay': {
        if (!room || !room.game) return;
        if (room.game.phase !== 'drawing') return send(ws, { action: 'error', msg: '当前不是定庄阶段' });
        room.game.phase = 'playing';
        pushState(room, 'start', `${room.players[room.game.firstPlayer].name} 抽到更大的牌，先出牌！`);
        break;
      }

      // ---- 出牌 ----
      case 'playCard': {
        if (!room || !room.game) return;
        const g = room.game;
        if (g.phase !== 'playing') return send(ws, { action: 'error', msg: '游戏未在进行' });
        if (g.currentTurn !== selfIndex) return send(ws, { action: 'error', msg: '还没轮到你出牌' });
        const card = msg.card;
        if (!card) return;
        const hand = g.hands[selfIndex];
        const idx = hand.findIndex((c) => c.color === card.color && c.value === card.value);
        if (idx < 0) return send(ws, { action: 'error', msg: '你手里没有这张牌' });
        const top = g.discardPile[g.discardPile.length - 1];
        if (!Core.canPlay(hand[idx], top, g.chosenColor)) {
          return send(ws, { action: 'error', msg: '这张牌不能出，颜色或点数不匹配' });
        }
        if (card.color === 'wild' && !msg.chosenColor) {
          return send(ws, { action: 'error', msg: '请选择颜色' });
        }
        const played = hand.splice(idx, 1)[0];
        g.discardPile.push(played);
        g.prevChosen = g.chosenColor; // 记录出牌前当前颜色（+4 质疑判定用）
        g.chosenColor = played.color === 'wild' ? msg.chosenColor : played.color;
        room.pendingTurnEnd = null;
        // UNO：出牌后剩 1 张 → 标记未喊 UNO（等待喊牌或被抓）
        if (g.hands[selfIndex].length === 1) g.uno[selfIndex] = false;
        afterPlay(room, selfIndex, played);
        break;
      }

      // ---- 抽牌 ----
      case 'drawCard': {
        if (!room || !room.game) return;
        const g = room.game;
        if (g.phase !== 'playing') return;
        if (g.currentTurn !== selfIndex) return send(ws, { action: 'error', msg: '还没轮到你抽牌' });
        const drawn = Core.drawCards(g.deck, g.discardPile, 1);
        if (drawn.length === 0) return send(ws, { action: 'error', msg: '牌堆已空，且无法重置' });
        g.hands[selfIndex].push(drawn[0]);
        room.pendingTurnEnd = selfIndex; // 允许结束回合
        const hasMove = g.hands[selfIndex].some((c) => Core.canPlay(c, g.discardPile[g.discardPile.length - 1], g.chosenColor));
        pushState(room, 'draw', `你抽了 1 张牌${hasMove ? '（有牌可出，可出牌或结束回合）' : '（无可出之牌，请结束回合）'}`, null);
        break;
      }

      // ---- 结束回合（抽牌后选择不出） ----
      case 'endTurn': {
        console.log(`${roomLog(room)} endTurn from index=${selfIndex}, pending=${room.pendingTurnEnd}, turn=${room.game && room.game.currentTurn}`);
        if (!room || !room.game) return;
        const g = room.game;
        if (room.pendingTurnEnd !== selfIndex) return send(ws, { action: 'error', msg: '当前无需结束回合' });
        if (g.currentTurn !== selfIndex) return send(ws, { action: 'error', msg: '还没轮到你' });
        room.pendingTurnEnd = null;
        g.currentTurn = 1 - selfIndex;
        pushState(room, 'endturn', `${room.players[selfIndex].name} 结束回合`, null);
        break;
      }

      // ---- +4 质疑 ----
      case 'challenge': {
        if (!room || !room.pendingChallenge) return send(ws, { action: 'error', msg: '当前没有可质疑的 +4' });
        if (room.pendingChallenge.challenger !== selfIndex) return;
        resolveChallenge(room, !!msg.decision);
        break;
      }

      // ---- 喊 UNO ----
      case 'callUno': {
        if (!room || !room.game) return;
        const g = room.game;
        if (g.hands[selfIndex].length !== 1) return send(ws, { action: 'error', msg: '手牌不是 1 张时无需喊 UNO' });
        g.uno[selfIndex] = true;
        pushState(room, 'uno', `${room.players[selfIndex].name} 喊了 UNO！`, null);
        break;
      }

      // ---- 抓 UNO（对手没喊） ----
      case 'catchUno': {
        if (!room || !room.game) return;
        const g = room.game;
        const target = 1 - selfIndex;
        if (g.hands[target].length !== 1) return send(ws, { action: 'error', msg: '对方手牌不是 1 张，无法抓' });
        if (g.uno[target]) return send(ws, { action: 'error', msg: '对方已经喊过 UNO' });
        const drawn = Core.drawCards(g.deck, g.discardPile, 2);
        g.hands[target].push(...drawn);
        g.uno[target] = true;
        pushState(room, 'catch', `${room.players[selfIndex].name} 抓到 ${room.players[target].name} 没喊 UNO，罚抽 2 张！`, null);
        break;
      }

      // ---- 聊天 ----
      case 'chat': {
        if (!room) return;
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) return;
        broadcast(room, { action: 'chat', name: room.players[selfIndex].name, text: text.trim() });
        break;
      }

      // ---- 再来一局 ----
      case 'rematch': {
        if (!room) return;
        if (room.game && room.game.phase !== 'ended') return send(ws, { action: 'error', msg: '本局还未结束' });
        startGame(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const idx = room.players.findIndex((p) => p.ws === ws);
    if (idx >= 0) {
      const other = 1 - idx;
      if (room.players[other] && room.players[other].ws.readyState === 1) {
        send(room.players[other].ws, { action: 'peerLeft', name: room.players[idx].name, destroyIn: 60, rejoinable: true });
      }
      room.players[idx].offline = true;
      console.log(`${roomLog(room)} ${room.players[idx].name} 暂时离线，60 秒内可重连`);
    }
    if (!room._destroyTimer) {
      // 60 秒重连宽限期：期间同昵称可用房间号重连恢复对局
      room._destroyTimer = setTimeout(() => {
        const online = room.players.find((p) => !p.offline && p.ws && p.ws.readyState === 1);
        if (online) {
          try { send(online.ws, { action: 'roomDestroyed' }); online.ws.close(); } catch (e) {}
        }
        if (room.pendingChallenge && room.pendingChallenge.timer) { clearTimeout(room.pendingChallenge.timer); }
        rooms.delete(room.id);
        console.log(`${roomLog(room)} 60 秒未重连，房间已销毁`);
      }, 60000);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ✅ 双人 UNO 服务器已启动`);
  console.log(`  📍 本机访问: http://localhost:${PORT}`);
  console.log(`  🌍 局域网访问: http://<本机IP>:${PORT}`);
});

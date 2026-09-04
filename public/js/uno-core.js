/**
 * uno-core.js — 双人 UNO 共享核心逻辑
 * 同时支持 Node(CommonJS) 与浏览器(挂 window) 两种环境。
 * 服务器端用它做权威校验，前端用它渲染判断与单机 AI。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UnoCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLORS = ['red', 'blue', 'green', 'yellow'];
  const COLOR_NAMES = { red: '红', blue: '蓝', green: '绿', yellow: '黄' };

  /** 生成一副标准 108 张 UNO 牌组（未洗牌） */
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

  /** 初始 7 张手牌 */
  function deal(deck, n) {
    const hand = deck.splice(0, n);
    return hand;
  }

  /** 打出第一张顶牌（跳过 wild 类，保证开局可玩） */
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

  /** 两张牌是否"脸"相同（数字相同或功能符号相同） */
  function sameFace(a, b) {
    if (a.value === b.value) return true;
    // 数字 0-9 与符号永不相等
    return false;
  }

  /**
   * 判断 card 是否能打在 top 上。
   * chosenColor: 之前有人打 wild 时选定的当前有效颜色
   */
  function canPlay(card, top, chosenColor) {
    if (!top) return true; // 空顶牌任意出
    const topColor = top.color === 'wild' ? chosenColor : top.color;
    if (card.color === 'wild') return true; // wild 类永远能出
    if (card.color === topColor) return true;
    if (sameFace(card, top)) return true;
    return false;
  }

  /**
   * 返回一张牌打出的"效果类别"：
   * 'skip' | 'reverse' | '+2' | 'wild' | '+4' | 'number'
   */
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

  /**
   * 双人回合流转：返回是否"跳过下家"（即保持当前玩家继续）。
   * 双人下 reverse == skip；+2/+4 也跳过对手。
   */
  function skipsOpponent(card) {
    const t = effectType(card);
    return t === 'skip' || t === 'reverse' || t === '+2' || t === '+4';
  }

  /** 从牌堆抽 n 张（不足则把弃牌堆除顶牌外洗回牌堆） */
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

  /**
   * 单机 AI：从手牌中选择要出的牌。
   * 返回 null 表示没有能出的牌（需抽牌）。
   */
  function aiChooseCard(hand, top, chosenColor) {
    const playable = hand.filter((c) => canPlay(c, top, chosenColor));
    if (playable.length === 0) return null;
    // 优先出普通数字牌，其次 +2/跳过/反转，最后保留 wild
    const rank = { number: 0, '+2': 1, skip: 1, reverse: 1, wild: 2, '+4': 3 };
    playable.sort((a, b) => rank[effectType(a)] - rank[effectType(b)]);
    return playable[0];
  }

  /** AI 选 wild 牌颜色：优先手牌里最多的颜色 */
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

  /** 给前端用的牌展示文本 */
  function cardLabel(card) {
    const col = card.color === 'wild' ? '' : COLOR_NAMES[card.color];
    const val = card.value === 'wild' ? '变色' : card.value === '+4' ? '+4' : card.value === '+2' ? '+2' : card.value === 'skip' ? '跳过' : card.value === 'reverse' ? '反转' : card.value;
    return col + ' ' + val;
  }

  /**
   * 抽牌定庄：双方各抽 1 张坐庄牌，数字大者先出牌（功能牌/变色牌计 0）。
   * 平局则重抽，最多 5 次兜底。返回 { cards: [a, b], firstIndex }。
   */
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
  /** 新建一个对局状态（用于联机房间与单机本地） */
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
      phase: 'playing', // playing | waiting_uno | ended
      winner: null,
      // 记录每个玩家是否已喊 UNO
      uno: players.map(() => false),
      history: [],
      drawPileCount: deck.length,
      discardCount: 1
    };
  }

  return {
    COLORS,
    COLOR_NAMES,
    buildDeck,
    shuffle,
    deal,
    drawFirstCard,
    canPlay,
    effectType,
    skipsOpponent,
    drawCards,
    aiChooseCard,
    aiChooseColor,
    cardLabel,
    createGame,
    decideDealer,
    sameFace
  };
});

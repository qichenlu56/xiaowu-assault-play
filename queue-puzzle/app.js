(function () {
  "use strict";

  var PERIOD_MS = 60 * 1000;
  var LEVEL_MS = 2 * 60 * 1000;
  var FAST_LEVEL_MS = 20 * 1000;
  var SLOGAN = "每分钟赛点，第一名优先进门";
  var TEAM_MAX = 8;
  var TEAMS_KEY = "xw-queue-puzzle-open-teams-v1";
  var SEED_TEAMS = ["晚风里", "月亮船", "第二杯", "候场的人"];
  var BOT_POOL = ["晚风里", "月亮船", "第二杯", "候场的人", "小酒窝", "夜归人", "路边听歌", "干杯再走"];
  var DIRS = {
    up: { dr: -1, dc: 0 },
    down: { dr: 1, dc: 0 },
    left: { dr: 0, dc: -1 },
    right: { dr: 0, dc: 1 }
  };
  var DIR_LIST = ["up", "down", "left", "right"];
  var CHANNEL_NAME = "xw-queue-puzzle";
  var STORAGE_KEY = "xw-queue-puzzle-v1";

  var params = new URLSearchParams(location.search);
  var isScreen = params.has("screen");
  var startFast = params.has("fast");

  var app = document.getElementById("app");
  var flyLayer = document.getElementById("fly-layer");
  var channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;
  var audioCtx = null;
  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  }
  document.addEventListener("touchstart", unlockAudio, { once: true, passive: true });
  document.addEventListener("click", unlockAudio, { once: true });

  var state = null;
  var timerId = 0;
  var botId = 0;
  var toastTimer = 0;

  function banner() {
    return '<div class="sample-banner">样稿：其他队为模拟</div>';
  }

  function queueNo() {
    return 16 + Math.floor(Math.random() * 22);
  }

  function levelLength() {
    return state && state.fast ? FAST_LEVEL_MS : LEVEL_MS;
  }

  function armLevelTimer() {
    if (!state) return;
    state.levelEndsAt = Date.now() + levelLength();
  }

  function levelRemainMs() {
    if (!state || !state.levelEndsAt) return 0;
    return Math.max(0, state.levelEndsAt - Date.now());
  }

  function armSettleTimer() {
    if (!state) return;
    state.settleAt = Date.now() + PERIOD_MS;
  }

  function remainMs() {
    if (!state || !state.settleAt) return 0;
    return Math.max(0, state.settleAt - Date.now());
  }

  function normalizeTeamName(raw) {
    return String(raw || "").replace(/\s+/g, " ").trim().slice(0, TEAM_MAX);
  }

  function loadOpenTeams() {
    var list = SEED_TEAMS.slice();
    try {
      var raw = localStorage.getItem(TEAMS_KEY);
      var extra = raw ? JSON.parse(raw) : [];
      if (Array.isArray(extra)) {
        extra.forEach(function (n) {
          n = normalizeTeamName(n);
          if (n && list.indexOf(n) < 0) list.push(n);
        });
      }
    } catch (e) {}
    return list;
  }

  function rememberTeam(name) {
    name = normalizeTeamName(name);
    if (!name) return;
    var list = loadOpenTeams();
    if (list.indexOf(name) < 0) {
      list.push(name);
      try { localStorage.setItem(TEAMS_KEY, JSON.stringify(list)); } catch (e) {}
    }
  }

  function defaultTeams(playerTeam) {
    var player = { id: "player", name: playerTeam, score: 0, isPlayer: true };
    var pool = BOT_POOL.filter(function (n) { return n !== playerTeam; });
    var i, j, tmp;
    for (i = pool.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    var skills = [0.72, 0.66, 0.6];
    var bots = pool.slice(0, 3).map(function (name, idx) {
      return { id: "bot-" + idx, name: name, score: 0, isPlayer: false, skill: skills[idx] || 0.62 };
    });
    while (bots.length < 3) {
      bots.push({ id: "bot-" + bots.length, name: "路过的", score: 0, isPlayer: false, skill: 0.62 });
    }
    return [player].concat(bots);
  }

  function defaultState() {
    return {
      view: "join",
      playerName: "",
      teamName: "",
      queueNo: queueNo(),
      teams: [],
      level: 1,
      board: null,
      combo: 0,
      lastClearAt: 0,
      settleAt: 0,
      levelEndsAt: 0,
      lastSettle: null,
      fast: startFast,
      stuckHint: false,
      transitioning: false,
      toast: "",
      teamHint: ""
    };
  }

  function levelSpec(level) {
    var lv = Math.max(1, level);
    var size = 6;
    if (lv >= 3) size = 7;
    if (lv >= 5) size = 8;
    var cells = size * size;
    var blockers = 2;
    if (lv >= 2) blockers = 3;
    if (lv >= 3) blockers = 4;
    if (lv >= 4) blockers = 5;
    if (lv >= 6) blockers = 6;
    if (lv >= 8) blockers = 7;
    if (lv >= 11) blockers = 8;
    var density = 0.50 + Math.min(0.18, (lv - 1) * 0.03);
    var arrows = Math.round(cells * density) - blockers;
    arrows = Math.max(12, Math.min(cells - blockers - 2, arrows));
    var turns = 1;
    if (lv >= 2) turns = 2;
    if (lv >= 4) turns = 3;
    if (lv >= 6) turns = 4;
    if (lv >= 9) turns = 5;
    if (lv >= 12) turns = 6;
    turns = Math.min(turns, Math.max(1, arrows - 4));
    return { size: size, blockers: blockers, arrows: arrows, minMoves: 2, hintClearable: false, turns: turns };
  }

  function emptyBoard(size) {
    var cells = [];
    var i, r, c;
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        cells.push({ type: "empty", dir: null });
      }
    }
    return { size: size, cells: cells };
  }

  function at(board, r, c) {
    if (r < 0 || c < 0 || r >= board.size || c >= board.size) return null;
    return board.cells[r * board.size + c];
  }

  function isClearable(board, r, c) {
    var cell = at(board, r, c);
    if (!cell || cell.type !== "arrow") return false;
    var d = DIRS[cell.dir];
    var nr = r + d.dr;
    var nc = c + d.dc;
    while (nr >= 0 && nc >= 0 && nr < board.size && nc < board.size) {
      var next = at(board, nr, nc);
      if (!next || next.type !== "empty") return false;
      nr += d.dr;
      nc += d.dc;
    }
    return true;
  }

  function listClearable(board) {
    var out = [];
    var r, c;
    for (r = 0; r < board.size; r++) {
      for (c = 0; c < board.size; c++) {
        if (isClearable(board, r, c)) out.push({ r: r, c: c });
      }
    }
    return out;
  }

  function countArrows(board) {
    var n = 0;
    board.cells.forEach(function (cell) {
      if (cell.type === "arrow") n++;
    });
    return n;
  }

  function cloneBoard(board) {
    return { size: board.size, cells: board.cells.map(function (c) { return { type: c.type, dir: c.dir, turn: !!c.turn }; }) };
  }

  function rotateDir(dir) {
    return DIR_LIST[(DIR_LIST.indexOf(dir) + 1) % 4];
  }

  function rotateCell(board, r, c) {
    var cell = at(board, r, c);
    if (!cell || cell.type !== "arrow") return;
    cell.dir = rotateDir(cell.dir);
  }

  function boardKey(board) {
    return board.cells.map(function (c) {
      return c.type === "arrow" ? (c.dir + (c.turn ? "t" : "")) : (c.type === "block" ? "B" : ".");
    }).join("");
  }

  function isFullyClearable(board) {
    var visited = {};
    var nodes = 0;
    function rec(b, depth) {
      if (countArrows(b) === 0) return true;
      if (depth > 140 || nodes > 7000) return false;
      var key = boardKey(b);
      if (visited[key]) return false;
      visited[key] = true;
      nodes++;
      var moves = listClearable(b);
      var i, n, m, r, c, cell;
      if (moves.length) {
        for (i = 0; i < moves.length; i++) {
          n = cloneBoard(b);
          m = moves[i];
          n.cells[m.r * n.size + m.c] = { type: "empty", dir: null, turn: false };
          if (rec(n, depth + 1)) return true;
        }
        return false;
      }
      for (r = 0; r < b.size; r++) {
        for (c = 0; c < b.size; c++) {
          cell = at(b, r, c);
          if (cell && cell.type === "arrow" && cell.turn) {
            n = cloneBoard(b);
            rotateCell(n, r, c);
            if (rec(n, depth + 1)) return true;
          }
        }
      }
      return false;
    }
    return rec(cloneBoard(board), 0);
  }

  function pathIsOpen(board, r, c, dir) {
    var d = DIRS[dir];
    var nr = r + d.dr;
    var nc = c + d.dc;
    while (nr >= 0 && nc >= 0 && nr < board.size && nc < board.size) {
      var next = at(board, nr, nc);
      if (!next || next.type !== "empty") return false;
      nr += d.dr;
      nc += d.dc;
    }
    return true;
  }

  function applyTurns(board, turns) {
    var want = Math.max(0, turns || 0);
    if (!want) return isFullyClearable(board);
    var idxs = [];
    board.cells.forEach(function (cell, i) {
      if (cell.type === "arrow") idxs.push(i);
    });
    var i, j, tmp;
    for (i = idxs.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      tmp = idxs[i];
      idxs[i] = idxs[j];
      idxs[j] = tmp;
    }
    var added = 0;
    for (i = 0; i < idxs.length && added < want; i++) {
      var cell = board.cells[idxs[i]];
      cell.turn = true;
      cell.dir = rotateDir(cell.dir);
      added++;
    }
    if (isFullyClearable(board)) return true;
    // undo if this made it unsolvable
    for (i = 0; i < idxs.length && i < added; i++) {
      board.cells[idxs[i]].turn = false;
      board.cells[idxs[i]].dir = rotateDir(rotateDir(rotateDir(board.cells[idxs[i]].dir)));
    }
    return isFullyClearable(board);
  }

  function generateBoard(level) {
    var spec = levelSpec(level);
    var attempt, placed, guard, idx, r, c, dir, i, k, choices;
    for (attempt = 0; attempt < 80; attempt++) {
      var blockersWanted = spec.blockers;
      if (attempt > 40) blockersWanted = Math.max(0, spec.blockers - 1);
      if (attempt > 60) blockersWanted = Math.max(0, spec.blockers - 2);
      var board = emptyBoard(spec.size);
      placed = 0;
      guard = 0;
      while (placed < blockersWanted && guard < 300) {
        guard++;
        idx = Math.floor(Math.random() * board.cells.length);
        r = Math.floor(idx / spec.size);
        c = idx % spec.size;
        if (board.cells[idx].type !== "empty") continue;
        if ((r === 0 || r === spec.size - 1) && (c === 0 || c === spec.size - 1) && Math.random() < 0.7) continue;
        board.cells[idx] = { type: "block", dir: null };
        placed++;
      }
      placed = 0;
      guard = 0;
      while (placed < spec.arrows && guard < 1200) {
        guard++;
        choices = [];
        for (r = 0; r < spec.size; r++) {
          for (c = 0; c < spec.size; c++) {
            if (at(board, r, c).type !== "empty") continue;
            for (k = 0; k < 4; k++) {
              dir = DIR_LIST[k];
              if (pathIsOpen(board, r, c, dir)) choices.push({ r: r, c: c, dir: dir });
            }
          }
        }
        if (!choices.length) break;
        var pick = choices[Math.floor(Math.random() * choices.length)];
        board.cells[pick.r * spec.size + pick.c] = { type: "arrow", dir: pick.dir };
        placed++;
      }
      if (placed >= Math.max(spec.minMoves, Math.floor(spec.arrows * 0.8)) && listClearable(board).length >= 1 && applyTurns(board, spec.turns) && isFullyClearable(board)) {
        return board;
      }
    }
    var board = emptyBoard(spec.size);
    for (i = 0; i < spec.size; i++) {
      board.cells[i] = { type: "arrow", dir: "up" };
      board.cells[(spec.size - 1) * spec.size + i] = { type: "arrow", dir: "down" };
    }
    for (i = 1; i < spec.size - 1 && i <= spec.blockers; i++) {
      var mid = Math.floor(spec.size / 2) * spec.size + i;
      if (board.cells[mid].type === "empty") board.cells[mid] = { type: "block", dir: null };
    }
    return board;
  }

  function publish() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(publicState())); } catch (e) {}
    if (channel) {
      try { channel.postMessage(publicState()); } catch (e) {}
    }
  }

  function publicState() {
    return {
      view: state.view,
      playerName: state.playerName,
      teamName: state.teamName,
      queueNo: state.queueNo,
      teams: state.teams,
      level: state.level,
      settleAt: state.settleAt,
      levelEndsAt: state.levelEndsAt,
      lastSettle: state.lastSettle,
      fast: state.fast,
      now: Date.now(),
      arrowsLeft: state.board ? countArrows(state.board) : 0,
      size: state.board ? state.board.size : 0,
      blockers: state.board ? state.board.cells.filter(function (c) { return c.type === "block"; }).length : 0
    };
  }

  function loadPublished() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function formatTime(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
  }

  function sortedTeams() {
    return state.teams.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name, "zh");
    });
  }

  function playerTeam() {
    return state.teams.find(function (t) { return t.isPlayer; });
  }

  function addScore(n) {
    var t = playerTeam();
    if (t) t.score += n;
  }

  function startPlay(name, team, fast) {
    state.playerName = name;
    state.teamName = team;
    state.teams = defaultTeams(team);
    state.level = 1;
    state.board = generateBoard(1);
    state.combo = 0;
    state.stuckHint = false;
    state.transitioning = false;
    state.fast = !!fast || startFast;
    armSettleTimer();
    armLevelTimer();
    state.view = "play";
    startLoops();
    publish();
    render();
  }

  function pointsForClear() {
    return 1;
  }

  function tryClear(r, c, el) {
    if (!state || state.view !== "play" || !state.board || state.transitioning) return;
    var cell = at(state.board, r, c);
    if (!cell || cell.type !== "arrow") return;
    if (!isClearable(state.board, r, c)) {
      if (cell.turn) {
        rotateCell(state.board, r, c);
        state.stuckHint = listClearable(state.board).length === 0;
        publish();
        render();
      }
      return;
    }
    var dir = cell.dir;
    addScore(1);
    flyArrow(el, dir);
    state.board.cells[r * state.board.size + c] = { type: "empty", dir: null, turn: false };
    state.stuckHint = false;
    if (countArrows(state.board) === 0) {
      var finished = state.level;
      state.transitioning = true;
      showToast("第 " + finished + " 关过关");
      setTimeout(function () {
        if (!state || state.view !== "play") return;
        state.level = finished + 1;
        state.board = generateBoard(state.level);
        state.transitioning = false;
        state.stuckHint = listClearable(state.board).length === 0;
        armLevelTimer();
        publish();
        render();
      }, 700);
    } else if (listClearable(state.board).length === 0) {
      state.stuckHint = true;
    }
    publish();
    render();
  }

  function reshuffle() {
    if (!state || !state.board) return;
    var size = state.board.size;
    var blockers = [];
    var bag = [];
    state.board.cells.forEach(function (cell, i) {
      if (cell.type === "block") blockers.push(i);
      if (cell.type === "arrow") bag.push({ turn: !!cell.turn });
    });
    var attempt, board, placed, guard, idx, ok;
    for (attempt = 0; attempt < 40; attempt++) {
      board = emptyBoard(size);
      blockers.forEach(function (i) { board.cells[i] = { type: "block", dir: null }; });
      placed = 0;
      guard = 0;
      while (placed < bag.length && guard < 400) {
        guard++;
        idx = Math.floor(Math.random() * board.cells.length);
        if (board.cells[idx].type !== "empty") continue;
        board.cells[idx] = { type: "arrow", dir: DIR_LIST[Math.floor(Math.random() * 4)], turn: bag[placed].turn };
        placed++;
      }
      if (listClearable(board).length >= 1 && isFullyClearable(board)) { ok = true; break; }
    }
    if (!ok) {
      for (var c = 0; c < size; c++) {
        if (board.cells[c].type === "empty") {
          board.cells[c] = { type: "arrow", dir: "up", turn: false };
          break;
        }
      }
    }
    state.board = board;
    state.stuckHint = listClearable(board).length === 0;
    publish();
    render();
  }

  function flyArrow(fromEl, dir) {
    if (!fromEl || !flyLayer) return;
    var rect = fromEl.getBoundingClientRect();
    var ghost = document.createElement("div");
    ghost.className = "ghost-arrow";
    ghost.style.left = rect.left + "px";
    ghost.style.top = rect.top + "px";
    ghost.style.width = rect.width + "px";
    ghost.style.height = rect.height + "px";
    ghost.innerHTML = arrowSvg(dir);
    flyLayer.appendChild(ghost);
    var dist = 520;
    var x = 0, y = 0;
    if (dir === "up") y = -dist;
    if (dir === "down") y = dist;
    if (dir === "left") x = -dist;
    if (dir === "right") x = dist;
    requestAnimationFrame(function () {
      ghost.style.transform = "translate(" + x + "px," + y + "px)";
      ghost.style.opacity = "0";
    });
    setTimeout(function () { if (ghost.parentNode) ghost.parentNode.removeChild(ghost); }, 420);
  }

  function arrowSvg(dir, turn) {
    var mark = turn ? '<path fill="none" stroke="#9c2b1a" stroke-width="4" d="M46 40a14 14 0 1 1-8-18" /><path fill="#9c2b1a" d="M36 18l12 2-6 10z"/>' : "";
    return '<svg class="arrow-glyph ' + dir + (turn ? " is-turn" : "") + '" viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M32 6l16 22h-10v30h-12V28H16z"/>' + mark + "</svg>";
  }

  function jarSvg() {
    return '<svg class="jar" viewBox="0 0 64 64" aria-hidden="true">' +
      '<path fill="#6d2a16" d="M16 26c-5 8-5 18-1 26 4 9 13 12 17 12s13-3 17-12c4-8 4-18-1-26-5-6-22-6-32 0z"/>' +
      '<path fill="#9c2b1a" d="M24 10h16c3 0 5 3 5 6v7c0 3-5 7-13 7s-13-4-13-7v-7c0-3 2-6 5-6z"/>' +
      '<ellipse cx="32" cy="10" rx="9" ry="3.5" fill="#d4a05a"/>' +
      '<path fill="#e8c48a" opacity=".32" d="M24 32c2 8 2 16 1 22 5 2 10 2 14 0-1-6-1-14 1-22H24z"/>' +
      '</svg>';
  }

  function showToast(text, hold) {
    state.toast = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (state) state.toast = "";
      var el = document.querySelector(".toast");
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, hold || 900);
    var node = document.createElement("div");
    node.className = "toast";
    node.textContent = text;
    document.body.appendChild(node);
  }

  function restartLevel() {
    if (!state || state.view !== "play" || state.transitioning) return;
    state.combo = 0;
    state.board = generateBoard(state.level);
    state.stuckHint = listClearable(state.board).length === 0;
    armLevelTimer();
    showToast("时间到，重来本关", 1600);
    publish();
    render();
  }

  function doSettle() {
    if (!state || state.view === "settle") return;
    var list = sortedTeams();
    state.lastSettle = {
      teams: list.map(function (t) { return { name: t.name, score: t.score, isPlayer: t.isPlayer }; }),
      winner: list[0] ? list[0].name : "",
      playerWon: !!(list[0] && list[0].isPlayer)
    };
    state.view = "settle";
    publish();
    render();
  }

  function nextRound() {
    state.teams.forEach(function (t) { t.score = 0; });
    armSettleTimer();
    state.view = "play";
    if (!state.board || countArrows(state.board) === 0) {
      state.board = generateBoard(state.level || 1);
    }
    armLevelTimer();
    startLoops();
    publish();
    render();
  }

  function startLoops() {
    stopLoops();
    tick();
    botId = setInterval(botTick, 2200);
  }

  function stopLoops() {
    if (timerId) cancelAnimationFrame(timerId);
    timerId = 0;
    if (botId) clearInterval(botId);
    botId = 0;
  }

  function tick() {
    if (!state || (state.view !== "play" && !isScreen)) {
      if (isScreen) {
        updateClockOnly();
        timerId = requestAnimationFrame(tick);
      }
      return;
    }
    if (state.view === "play" && remainMs() <= 0 && state.settleAt) {
      doSettle();
      return;
    }
    if (state.view === "play" && !state.transitioning && state.levelEndsAt && levelRemainMs() <= 0) {
      restartLevel();
    }
    updateClockOnly();
    timerId = requestAnimationFrame(tick);
  }

  function updateClockOnly() {
    var ms = remainMs();
    document.querySelectorAll(".js-clock").forEach(function (el) {
      el.textContent = formatTime(ms);
      var wrap = el.closest(".clock, .screen-clock");
      if (wrap) wrap.classList.toggle("urgent", ms > 0 && ms <= 10000);
    });
    var lv = levelRemainMs();
    document.querySelectorAll(".js-level-clock").forEach(function (el) {
      el.textContent = formatTime(lv);
      var wrap = el.closest(".level-clock, .screen-level-clock");
      if (wrap) wrap.classList.toggle("urgent", lv > 0 && lv <= 10000);
    });
  }

  function botTick() {
    if (!state || state.view !== "play") return;
    state.teams.forEach(function (t) {
      if (t.isPlayer) return;
      // About 12–18 points a minute, in line with 1 point per arrow.
      if (Math.random() > 0.3 + (t.skill || 0.6) * 0.4) return;
      t.score += 1;
    });
    publish();
    // refresh scores without rebuilding the board mid-tap if possible
    refreshScores();
  }

  function refreshScores() {
    var box = document.getElementById("live-scores");
    if (box) box.innerHTML = miniBoard();
    var pill = document.getElementById("my-score");
    var me = playerTeam();
    if (pill && me) pill.textContent = String(me.score);
    if (isScreen) render();
  }

  /* ---------- views ---------- */

  function viewJoin() {
    var name = (state.playerName || "").trim();
    var team = state.teamName || "";
    return '<div class="phone-shell">' +
      '<div class="topbar"><div>' +
      '<div class="brand-kicker">大冰的小屋 · 烟台山分舵</div>' +
      '<h1 class="brand-title">消得多 先进门</h1>' +
      '<div class="brand-sub">' + SLOGAN + '</div>' +
      '</div><div class="queue-pill">今晚号码<strong>' + state.queueNo + ' 号</strong></div></div>' +
      banner() +
      '<section class="paper">' +
      '<h2>排队时一直能玩</h2>' +
      '<p class="muted">点一支箭，正前方没有挡住，它就会飞出棋盘。带转角记号的箭，要先点一下转到能飞出的方向。每飞出一支箭，本队得 1 分。每一关有 2 分钟，消完进入下一关；时间到了就重来本关，已经拿到的分还在。每 1 分钟一个赛点，分数最高的队优先进门，然后分数清零，再比一轮。</p>' +
      '<label class="field">怎么称呼<input id="name-input" type="text" maxlength="12" placeholder="例如：小刚" value="' + escapeHtml(name) + '" /></label>' +
      '<label class="field">给队伍起个名，或加入已有的队<input id="team-input" type="text" maxlength="' + TEAM_MAX + '" placeholder="最多 ' + TEAM_MAX + ' 个字" value="' + escapeHtml(team) + '" /></label>' +
      (state.teamHint ? '<p class="muted" id="team-hint" style="color:#9c2b1a;margin-top:6px;">' + escapeHtml(state.teamHint) + "</p>" : "") +
      '<div class="field">今晚已经有这些队，点一下就加入</div>' +
      '<div class="team-grid" id="team-grid">' +
      loadOpenTeams().map(function (t) {
        return '<button type="button" class="team-chip' + (t === team ? ' selected' : '') + '" data-team="' + escapeHtml(t) + '">' + t + '</button>';
      }).join("") +
      '</div>' +
      '<button type="button" class="btn-main" id="btn-join">开始消除</button>' +
      '<button type="button" class="btn-ghost" id="btn-fast">演示本关倒计时（20 秒）</button>' +
      '</section>' +
      '<p class="muted" style="color:#e8c48a;text-align:center;font-size:12px;">这是样稿，优先进门和券都不能当真办理。<br>门口大屏：同一网址后加 ?screen</p>' +
      '</div>';
  }

  function miniBoard() {
    var list = sortedTeams();
    return list.map(function (t, i) {
      var cls = t.isPlayer ? "is-me" : "";
      if (i === 0) cls += " lead";
      return '<div class="' + cls + '"><b>' + escapeHtml(t.name) + (t.isPlayer ? " · 本队" : "") + "</b>  " + t.score + "</div>";
    }).join("");
  }

  function viewPlay() {
    var board = state.board;
    var spec = levelSpec(state.level);
    var me = playerTeam();
    var ms = remainMs();
    var urgent = ms > 0 && ms <= 10000;
    var lvMs = levelRemainMs();
    var lvUrgent = lvMs > 0 && lvMs <= 10000;
    var cells = "";
    var r, c, cell, cls, inner, can;
    for (r = 0; r < board.size; r++) {
      for (c = 0; c < board.size; c++) {
        cell = at(board, r, c);
        can = cell.type === "arrow" && isClearable(board, r, c);
        cls = "cell " + cell.type;
        if (cell.turn) cls += " turn";
        if (can && spec.hintClearable) cls += " clearable";
        inner = "";
        if (cell.type === "arrow") inner = arrowSvg(cell.dir, cell.turn);
        if (cell.type === "block") inner = jarSvg();
        cells += '<button type="button" class="' + cls + '" data-r="' + r + '" data-c="' + c + '"' +
          (can ? ' data-clearable="1"' : "") +
          ' aria-label="' + (cell.type === "arrow" ? (cell.turn ? "转箭 " : "") + cell.dir : cell.type) + '">' + inner + "</button>";
      }
    }
    return '<div class="phone-shell">' +
      '<div class="play-meta">' +
      '<div class="level-pill">关卡<strong id="level-num">' + state.level + "</strong></div>" +
      '<div class="clock' + (urgent ? " urgent" : "") + '"><div class="lab">距下一次赛点</div><div class="time js-clock">' + formatTime(ms) + "</div></div>" +
      '<div class="score-pill">本队<strong id="my-score">' + (me ? me.score : 0) + "</strong></div>" +
      "</div>" +
      '<div class="level-clock' + (lvUrgent ? " urgent" : "") + '"><div class="lab">本关剩余</div><div class="time js-level-clock">' + formatTime(lvMs) + "</div></div>" +
      '<div class="priority-line">' + SLOGAN + "</div>" +
      banner() +
      '<div class="board-wrap"><div class="board" id="board" data-level="' + state.level + '" data-size="' + board.size + '" data-blockers="' + spec.blockers + '" style="grid-template-columns:repeat(' + board.size + ',1fr)">' + cells + "</div></div>" +
      (state.stuckHint ? '<button type="button" class="btn-ghost" id="btn-shuffle" style="color:#e8c48a">前面都挡住了，重新摆一摆</button>' : "") +
      '<div class="mini-board" id="live-scores">' + miniBoard() + "</div>" +
      '<button type="button" class="called-btn" id="btn-called">叫到号了</button>' +
      "</div>";
  }

  function couponCard(showEarly) {
    var gifts = (showEarly ? "优先进门<br/>" : "") + "小吃券 一份<br/>下次来盖章  +1 积分";
    return '<div class="coupon"><div class="shop">大冰的小屋 · 烟台山分舵</div><h3>消得多 先进门</h3><div class="gift">' +
      gifts + '</div><p class="fine-print">此为样稿，不能当真核销。</p><div class="seal">' + (showEarly ? "先请" : "同路") + "</div></div>";
  }

  function viewSettle() {
    var rec = state.lastSettle || { teams: sortedTeams(), winner: "", playerWon: false };
    var list = rec.teams;
    var winner = rec.winner;
    var playerWon = rec.playerWon;
    var prize = playerWon ? "本队这轮赢了" : ("这轮第一名是" + escapeHtml(winner));
    var rows = list.map(function (t, i) {
      var win = i === 0 ? " winner" : "";
      var tag = i === 0 ? '<span class="tag">优先进门</span>' : "";
      return '<div class="rank-item' + win + '"><div class="pos">' + (i + 1) + "</div><div>" +
        escapeHtml(t.name) + (t.isPlayer ? " · 本队" : "") + tag + "</div><strong>" + t.score + "</strong></div>";
    }).join("");
    return '<div class="phone-shell">' +
      '<div class="topbar"><div><div class="brand-kicker">赛点到了</div><h1 class="brand-title">消得多 先进门</h1><div class="brand-sub">' + SLOGAN + "</div></div>" +
      '<div class="queue-pill">本队第<strong>' + (list.findIndex(function (t) { return t.isPlayer; }) + 1 || "—") + "</strong></div></div>" +
      banner() +
      '<section class="paper"><h2>本轮成绩</h2><div class="rank-list">' + rows + "</div></section>" +
      '<div class="early-prize">' + prize + "<strong>优先进门</strong></div>" +
      couponCard(playerWon) +
      '<button type="button" class="btn-main" id="btn-next-round">开始下一轮</button>' +
      "</div>";
  }

  function viewCalled() {
    var list = sortedTeams();
    var rank = list.findIndex(function (t) { return t.isPlayer; }) + 1;
    return '<div class="phone-shell">' + banner() +
      '<div class="called-hero"><div class="no">' + state.queueNo + ' 号</div>' +
      "<p>号到了，先去店里听歌吧。<br/>这一轮的分数先记在这里。</p></div>" +
      '<section class="paper"><h2>本队此刻第 ' + rank + "</h2>" +
      '<p class="muted">优先进门要等每分钟的赛点结算。进门后把样稿券给店里看就行。</p></section>' +
      couponCard(false) +
      '<button type="button" class="btn-main" id="btn-again">回到门口再玩</button>' +
      "</div>";
  }

  function viewScreen() {
    var live = state && state.teams && state.teams.length;
    var list = live ? sortedTeams() : [];
    var max = Math.max(1, Math.max.apply(null, list.map(function (t) { return t.score; }).concat([1])));
    var nowLine = "门口电视样稿";
    var nowBig = "等候开局";
    var ms = remainMs();
    if (!live) {
      nowLine = "把手机样稿打开后，这边会同步比分和赛点";
      nowBig = "还没有进行中的一局";
    } else if (state.view === "play") {
      var sz = state.size || (state.board && state.board.size) || 0;
      nowLine = "第 " + state.level + " 关" + (sz ? " · 棋盘 " + sz + "×" + sz : "");
      if (state.levelEndsAt) nowLine += " · 本关剩余 <span class=\"js-level-clock\">" + formatTime(levelRemainMs()) + "</span>";
      nowBig = "正在门口消除，飞出越多分越高";
    } else if (state.view === "settle" && state.lastSettle) {
      nowLine = "赛点到了";
      nowBig = "第一名 " + state.lastSettle.winner + " · 优先进门";
    } else if (state.view === "called") {
      nowLine = "有一桌号到了";
      nowBig = state.queueNo + " 号，请入场";
    } else if (state.view === "join") {
      nowLine = "客人正在扫码入队";
      nowBig = "消得多 先进门";
    }
    var showTag = !!(live && state.view === "settle");
    var board = live ? '<div class="bars">' + list.map(function (t, i) {
      var w = Math.round((t.score / max) * 100);
      var tag = showTag && i === 0 ? '<span class="tag">优先进门</span>' : "";
      return '<div class="bar-row' + (i === 0 ? " lead" : "") + '"><div class="name' + (t.isPlayer ? " me" : "") + '">' + escapeHtml(t.name) +
        (t.isPlayer ? " · 本队" : "") + tag + '</div><div class="bar-track"><div class="bar-fill" style="width:' + w +
        '%"></div></div><div class="pts">' + t.score + "</div></div>";
    }).join("") + "</div>" : '<div class="idle-actions" style="text-align:center"><p class="muted" style="color:#e8c48a;margin-bottom:12px;">若只想先看大屏，可以开一局演示。</p><button type="button" class="btn-main" id="btn-demo" style="max-width:280px;margin:0 auto">演示大屏</button></div>';

    return '<div class="screen"><div class="screen-head"><div>' +
      '<div class="brand-kicker">大冰的小屋 · 烟台山分舵</div>' +
      "<h1>消得多 先进门</h1>" +
      '<div class="brand-sub">' + SLOGAN + "</div></div>" + banner() + "</div>" +
      '<div class="screen-clock' + (ms > 0 && ms <= 10000 ? " urgent" : "") + '"><div class="lab">距下一次赛点</div><div class="time js-clock">' + formatTime(ms) + "</div></div>" +
      '<div class="screen-now">' + nowLine + '<span class="big">' + escapeHtml(nowBig) + "</span></div>" +
      board +
      '<div class="screen-foot"><span>' + SLOGAN + "</span><span>" +
      (live ? "今晚号码 " + state.queueNo + " 号也在场" : "样稿：其他队为模拟") + "</span></div></div>";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bind() {
    var nameInput = document.getElementById("name-input");
    if (nameInput) {
      nameInput.addEventListener("input", function () { state.playerName = nameInput.value; });
    }
    var teamInput = document.getElementById("team-input");
    if (teamInput) {
      teamInput.addEventListener("input", function () {
        state.teamName = teamInput.value;
        state.teamHint = "";
        var chips = document.querySelectorAll("#team-grid [data-team]");
        var cur = normalizeTeamName(teamInput.value);
        chips.forEach(function (btn) {
          btn.classList.toggle("selected", btn.getAttribute("data-team") === cur);
        });
      });
    }
    var grid = document.getElementById("team-grid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-team]");
        if (!btn) return;
        state.teamName = btn.getAttribute("data-team");
        state.teamHint = "";
        render();
        var again = document.getElementById("name-input");
        if (again) again.value = state.playerName || "";
        var tIn = document.getElementById("team-input");
        if (tIn) tIn.value = state.teamName || "";
      });
    }
    var join = document.getElementById("btn-join");
    if (join) join.addEventListener("click", function () { begin(false); });
    var fast = document.getElementById("btn-fast");
    if (fast) fast.addEventListener("click", function () { begin(true); });
    var demo = document.getElementById("btn-demo");
    if (demo) demo.addEventListener("click", function () {
      startPlay("演示", "路过的", true);
    });
    var board = document.getElementById("board");
    if (board) {
      board.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-r]");
        if (!btn) return;
        tryClear(Number(btn.getAttribute("data-r")), Number(btn.getAttribute("data-c")), btn);
      });
    }
    var sh = document.getElementById("btn-shuffle");
    if (sh) sh.addEventListener("click", reshuffle);
    var called = document.getElementById("btn-called");
    if (called) called.addEventListener("click", function () {
      state.view = "called";
      publish();
      render();
    });
    var next = document.getElementById("btn-next-round");
    if (next) next.addEventListener("click", nextRound);
    var again = document.getElementById("btn-again");
    if (again) again.addEventListener("click", function () {
      var keep = { queueNo: state.queueNo, playerName: state.playerName, teamName: state.teamName, fast: state.fast };
      stopLoops();
      state = defaultState();
      state.queueNo = keep.queueNo;
      state.playerName = keep.playerName;
      state.teamName = keep.teamName;
      state.fast = keep.fast;
      publish();
      render();
    });
  }

  function begin(fast) {
    var n = ((document.getElementById("name-input") || {}).value || state.playerName || "").trim() || "同路人";
    var team = normalizeTeamName(((document.getElementById("team-input") || {}).value || state.teamName || ""));
    if (!team) {
      state.teamHint = "先给队伍起个名，或点一个已有的队";
      render();
      var tIn = document.getElementById("team-input");
      if (tIn) tIn.focus();
      return;
    }
    state.teamName = team;
    state.teamHint = "";
    rememberTeam(team);
    startPlay(n, team, fast);
  }

  function render() {
    document.body.classList.toggle("screen-mode", isScreen);
    if (isScreen) app.innerHTML = viewScreen();
    else if (!state || state.view === "join") app.innerHTML = viewJoin();
    else if (state.view === "play") app.innerHTML = viewPlay();
    else if (state.view === "settle") app.innerHTML = viewSettle();
    else if (state.view === "called") app.innerHTML = viewCalled();
    bind();
  }

  if (channel) {
    channel.onmessage = function (ev) {
      if (!isScreen || !ev || !ev.data) return;
      state = ev.data;
      render();
    };
  }
  window.addEventListener("storage", function (ev) {
    if (!isScreen || ev.key !== STORAGE_KEY || !ev.newValue) return;
    try { state = JSON.parse(ev.newValue); render(); } catch (e) {}
  });

  window.__xwApply = function (partial) {
    state = Object.assign(defaultState(), partial || {});
    publish();
    render();
  };
  window.__xwSetRemain = function (seconds) {
    if (!state) return;
    state.settleAt = Date.now() + Math.max(0, seconds) * 1000;
    publish();
    updateClockOnly();
  };
  window.__xwSetLevelRemain = function (seconds) {
    if (!state) return;
    state.levelEndsAt = Date.now() + Math.max(0, seconds) * 1000;
    publish();
    updateClockOnly();
  };
  window.__xwLevelSpec = levelSpec;
  window.__xwGenerateBoard = generateBoard;
  window.__xwGotoLevel = function (n) {
    if (!state) return;
    state.level = Math.max(1, n);
    state.board = generateBoard(state.level);
    state.transitioning = false;
    state.stuckHint = listClearable(state.board).length === 0;
    armLevelTimer();
    publish();
    render();
  };
  window.__xwState = function () { return state; };
  window.__xwRender = function () { publish(); render(); };

  if (isScreen) {
    state = loadPublished() || defaultState();
    render();
    startLoops();
  } else {
    state = defaultState();
    render();
  }
})();

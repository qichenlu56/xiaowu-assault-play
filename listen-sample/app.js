(function () {
  "use strict";

  const TOTAL_ROUNDS = 5;
  const ROUND_SECONDS = 15;
  const CHANNEL_NAME = "xw-listen-sample";
  const STORAGE_KEY = "xw-listen-state-v1";

  const SONGS = [
    {
      id: "01",
      title: "烟台山的晚风",
      src: "audio/01.wav",
      options: ["烟台山的晚风", "巷口那把旧吉他", "雨停以后再走", "三个城市的月亮"],
    },
    {
      id: "02",
      title: "青石路上的灯",
      src: "audio/02.wav",
      options: ["桥头还亮着一盏", "青石路上的灯", "左巷的橘子灯", "风把门帘掀开时"],
    },
    {
      id: "03",
      title: "湖面上的旧船票",
      src: "audio/03.wav",
      options: ["等船的那一夜", "旧船票上的字", "湖面上的旧船票", "夜渡的人还没回来"],
    },
    {
      id: "04",
      title: "雪山下的一封信",
      src: "audio/04.wav",
      options: ["从丽江寄来的路", "雪停了再写", "雪山下的一封信", "山路尽头的茶"],
    },
    {
      id: "05",
      title: "店里还存着那杯酒",
      src: "audio/05.wav",
      options: ["柜上那只空杯子", "今夜先记下这一笔", "店里还存着那杯酒", "把余下的酒先留下"],
    },
  ];

  const BOT_PRESETS = [
    { id: "lijiang", name: "丽江队", skill: 0.74 },
    { id: "jinan", name: "济南队", skill: 0.58 },
    { id: "fuzhou", name: "福州队", skill: 0.66 },
  ];

  const CITY_TEAMS = ["丽江队", "济南队", "福州队", "路上队"];

  const isScreen = /(?:^|[?&])screen(?:&|=|$)/.test(location.search);
  const app = document.getElementById("app");
  const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;

  let state = null;
  let timerId = 0;
  let botTimers = [];
  let audio = null;
  let lastTick = 0;

  function banner() {
    return `<div class="sample-banner">样稿：占位旋律，正式版换成店里歌手的录音</div>`;
  }

  function queueNo() {
    return 16 + Math.floor(Math.random() * 22);
  }

  function defaultState() {
    return {
      view: "join",
      playerName: "",
      teamName: "",
      queueNo: queueNo(),
      teams: [],
      roundIndex: -1,
      question: null,
      pickedIndex: null,
      answeredAt: null,
      couponGiven: false,
      endedByCall: false,
      now: Date.now(),
    };
  }

  function publish() {
    state.now = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      /* ignore quota */
    }
    if (channel) {
      try {
        channel.postMessage(state);
      } catch (err) {
        /* ignore */
      }
    }
  }

  function loadPublished() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function scoreFor(msLeft) {
    const sec = Math.max(0, msLeft / 1000);
    return Math.round(400 + 600 * (sec / ROUND_SECONDS));
  }

  function stopBots() {
    botTimers.forEach(function (id) {
      clearTimeout(id);
    });
    botTimers = [];
  }

  function stopAudio() {
    if (audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (err) {
        /* ignore */
      }
    }
  }

  function playClip(src) {
    stopAudio();
    audio = new Audio(src);
    audio.preload = "auto";
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch(function () {
        render();
      });
    }
    audio.onended = function () {
      render();
    };
    audio.onplay = function () {
      render();
    };
  }

  function isPlaying() {
    return !!(audio && !audio.paused && !audio.ended);
  }

  function shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function startLobby(name, teamName) {
    const playerTeam = {
      id: "player",
      name: teamName,
      score: 0,
      isPlayer: true,
      answered: false,
      lastGain: 0,
      lastCorrect: null,
    };
    const used = new Set([teamName]);
    const bots = BOT_PRESETS.filter(function (b) {
      return b.name !== teamName;
    }).map(function (b) {
      return {
        id: b.id,
        name: b.name,
        skill: b.skill,
        score: 0,
        isPlayer: false,
        answered: false,
        lastGain: 0,
        lastCorrect: null,
      };
    });
    while (bots.length < 3) {
      const fallback = { id: "tonglu", name: "同路人队", skill: 0.62 };
      if (used.has(fallback.name)) break;
      bots.push({
        id: fallback.id,
        name: fallback.name,
        skill: fallback.skill,
        score: 0,
        isPlayer: false,
        answered: false,
        lastGain: 0,
        lastCorrect: null,
      });
      used.add(fallback.name);
    }
    state.playerName = name;
    state.teamName = teamName;
    state.teams = [playerTeam].concat(bots);
    state.view = "lobby";
    publish();
    render();
  }

  function resetRoundFlags() {
    state.teams.forEach(function (t) {
      t.answered = false;
      t.lastGain = 0;
      t.lastCorrect = null;
    });
    state.pickedIndex = null;
    state.answeredAt = null;
  }

  function startRound() {
    stopBots();
    const next = state.roundIndex + 1;
    if (next >= TOTAL_ROUNDS) {
      finishGame(false);
      return;
    }
    const song = SONGS[next];
    const options = shuffle(song.options);
    state.roundIndex = next;
    resetRoundFlags();
    state.question = {
      title: song.title,
      src: song.src,
      options: options,
      correctIndex: options.indexOf(song.title),
      startedAt: Date.now(),
      endsAt: Date.now() + ROUND_SECONDS * 1000,
    };
    state.view = "question";
    publish();
    render();
    playClip(song.src);
    startTimer();
    scheduleBots();
  }

  function scheduleBots() {
    state.teams.forEach(function (team, idx) {
      if (team.isPlayer) return;
      const delay = 1400 + Math.random() * 5200 + idx * 220;
      const id = setTimeout(function () {
        botAnswer(team.id);
      }, delay);
      botTimers.push(id);
    });
  }

  function botAnswer(teamId) {
    if (!state || state.view !== "question" || !state.question) return;
    const team = state.teams.find(function (t) {
      return t.id === teamId;
    });
    if (!team || team.answered) return;
    const left = state.question.endsAt - Date.now();
    if (left <= 0) return;
    const correct = Math.random() < (team.skill || 0.6);
    const gain = correct ? scoreFor(left) : 0;
    team.answered = true;
    team.lastCorrect = correct;
    team.lastGain = gain;
    team.score += gain;
    publish();
    render();
    maybeRevealEarly();
  }

  function playerAnswer(index) {
    if (!state || state.view !== "question" || !state.question) return;
    const team = state.teams.find(function (t) {
      return t.isPlayer;
    });
    if (!team || team.answered) return;
    const left = state.question.endsAt - Date.now();
    if (left <= 0) return;
    const correct = index === state.question.correctIndex;
    const gain = correct ? scoreFor(left) : 0;
    team.answered = true;
    team.lastCorrect = correct;
    team.lastGain = gain;
    team.score += gain;
    state.pickedIndex = index;
    state.answeredAt = Date.now();
    publish();
    render();
    maybeRevealEarly();
  }

  function maybeRevealEarly() {
    if (!state || state.view !== "question") return;
    const all = state.teams.every(function (team) { return team.answered; });
    if (!all) return;
    setTimeout(function () {
      if (state && state.view === "question") reveal();
    }, 900);
  }

  function reveal() {
    stopBots();
    stopAudio();
    if (state.view !== "question") return;
    const q = state.question;
    const left = 0;
    state.teams.forEach(function (team) {
      if (!team.answered) {
        team.answered = true;
        team.lastCorrect = false;
        team.lastGain = 0;
      }
    });
    state.view = "reveal";
    state.question = Object.assign({}, q, { endsAt: Date.now() + left });
    publish();
    render();
    setTimeout(function () {
      if (state && state.view === "reveal") {
        if (state.roundIndex + 1 >= TOTAL_ROUNDS) finishGame(false);
        else startRound();
      }
    }, 3200);
  }

  function finishGame(byCall) {
    stopBots();
    stopTimer();
    stopAudio();
    state.endedByCall = !!byCall;
    state.couponGiven = true;
    state.view = byCall ? "called" : "results";
    publish();
    render();
  }

  function startTimer() {
    stopTimer();
    const tick = function () {
      if (!state || state.view !== "question" || !state.question) {
        stopTimer();
        return;
      }
      const left = state.question.endsAt - Date.now();
      if (left <= 0) {
        stopTimer();
        reveal();
        return;
      }
      if (Math.abs(left - lastTick) > 180) {
        lastTick = left;
        const num = document.querySelector(".timer .num");
        const ring = document.querySelector(".timer .ring-val");
        if (num) num.textContent = String(Math.ceil(left / 1000));
        if (ring) {
          const c = 2 * Math.PI * 42;
          const p = Math.max(0, Math.min(1, left / (ROUND_SECONDS * 1000)));
          ring.style.strokeDashoffset = String(c * (1 - p));
        }
      }
      timerId = requestAnimationFrame(tick);
    };
    timerId = requestAnimationFrame(tick);
  }

  function stopTimer() {
    if (timerId) cancelAnimationFrame(timerId);
    timerId = 0;
  }

  function sortedTeams() {
    return state.teams.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name, "zh");
    });
  }

  function playerRank() {
    const list = sortedTeams();
    const i = list.findIndex(function (t) {
      return t.isPlayer;
    });
    return i < 0 ? list.length : i + 1;
  }

  /* ---------- views ---------- */

  function viewJoin() {
    const name = (state.playerName || "").trim();
    const team = state.teamName || "路上队";
    return `
      <div class="phone-shell">
        <div class="topbar">
          <div>
            <div class="brand-kicker">大冰的小屋 · 烟台山分舵</div>
            <h1 class="brand-title">路上听歌</h1>
          </div>
          <div class="queue-pill">今晚号码<strong>${state.queueNo} 号</strong></div>
        </div>
        ${banner()}
        <section class="paper">
          <h2>门口先听一段</h2>
          <p class="muted">和同来的人组成一队。别的队伍也在同时听、同时答。答得又对又快，分更高。</p>
          <label class="field">怎么称呼
            <input id="name-input" type="text" maxlength="12" placeholder="例如：小刚" value="${escapeHtml(name)}" />
          </label>
          <div class="field">选一个队</div>
          <div class="team-grid" id="team-grid">
            ${CITY_TEAMS.map(function (t) {
              return `<button type="button" class="team-chip ${t === team ? "selected" : ""}" data-team="${escapeHtml(t)}">${t}</button>`;
            }).join("")}
          </div>
          <label class="field">或自己起个队名
            <input id="custom-team" type="text" maxlength="8" placeholder="四个字以内" />
          </label>
          <button type="button" class="btn-main" id="btn-join">进场组队</button>
        </section>
        <p class="muted" style="color:#e8c48a;text-align:center;font-size:12px;">这是样稿，分数和券都不能当真核销。门口电视可打开同一链接，后面加上 ?screen</p>
      </div>`;
  }

  function viewLobby() {
    return `
      <div class="phone-shell">
        <div class="topbar">
          <div>
            <div class="brand-kicker">大冰的小屋 · 烟台山分舵</div>
            <h1 class="brand-title">路上听歌</h1>
          </div>
          <div class="queue-pill">今晚号码<strong>${state.queueNo} 号</strong></div>
        </div>
        ${banner()}
        <section class="paper">
          <h2>队伍到齐了</h2>
          <p class="muted">样稿里，另外三队由店里替你演示，看起来像好几拨人同时在玩。正式版会是门口真实的队伍一起扫码。</p>
          ${state.teams
            .map(function (t) {
              return `<div class="team-row"><span>${escapeHtml(t.name)}</span><span class="tag ${t.isPlayer ? "me" : "bot"}">${t.isPlayer ? "本队" : "已入座"}</span></div>`;
            })
            .join("")}
          <button type="button" class="btn-main" id="btn-start">开始听歌</button>
        </section>
        <button type="button" class="called-btn" id="btn-called">叫到号了</button>
      </div>`;
  }

  function viewQuestion() {
    const q = state.question;
    const left = Math.max(0, q.endsAt - Date.now());
    const sec = Math.ceil(left / 1000);
    const c = 2 * Math.PI * 42;
    const p = Math.max(0, Math.min(1, left / (ROUND_SECONDS * 1000)));
    const playing = isPlaying();
    const player = state.teams.find(function (t) {
      return t.isPlayer;
    });
    const locked = !!(player && player.answered);
    return `
      <div class="phone-shell">
        <div class="round-meta">
          <span>第 ${state.roundIndex + 1} / ${TOTAL_ROUNDS} 局</span>
          <span>${escapeHtml(state.teamName)}</span>
        </div>
        ${banner()}
        <div class="timer-wrap">
          <div class="timer">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(232,196,138,0.2)" stroke-width="7"/>
              <circle class="ring-val" cx="50" cy="50" r="42" fill="none" stroke="#e8c48a" stroke-width="7"
                stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}"/>
            </svg>
            <div class="num">${sec}</div>
          </div>
        </div>
        <section class="paper listen-card">
          <div>请听这一段</div>
          <div class="eq ${playing ? "playing" : ""}" aria-hidden="true">${"<span></span>".repeat(7)}</div>
          <button type="button" class="btn-play" id="btn-play">${playing ? "正在播放" : "再听一遍"}</button>
        </section>
        <div class="options">
          ${q.options
            .map(function (opt, i) {
              const cls = locked && state.pickedIndex === i ? "option picked" : "option";
              return `<button type="button" class="${cls}" data-opt="${i}" ${locked ? "disabled" : ""}>${escapeHtml(opt)}</button>`;
            })
            .join("")}
        </div>
        ${miniBoard()}
        <button type="button" class="called-btn" id="btn-called">叫到号了</button>
      </div>`;
  }

  function viewReveal() {
    const q = state.question;
    const player = state.teams.find(function (t) {
      return t.isPlayer;
    });
    const gain = player ? player.lastGain : 0;
    const ok = player && player.lastCorrect;
    return `
      <div class="phone-shell">
        <div class="round-meta">
          <span>第 ${state.roundIndex + 1} / ${TOTAL_ROUNDS} 局</span>
          <span>${ok ? "答对了" : "这一题揭晓"}</span>
        </div>
        ${banner()}
        <section class="paper listen-card">
          <p class="muted">这一段是</p>
          <h2>${escapeHtml(q.title)}</h2>
          <div class="gain">${ok ? "+" + gain : "本题没有分"}</div>
        </section>
        <div class="options">
          ${q.options
            .map(function (opt, i) {
              let cls = "option";
              if (i === q.correctIndex) cls += " correct";
              else if (state.pickedIndex === i) cls += " wrong";
              return `<button type="button" class="${cls}" disabled>${escapeHtml(opt)}</button>`;
            })
            .join("")}
        </div>
        ${miniBoard(true)}
        <button type="button" class="called-btn" id="btn-next">${state.roundIndex + 1 >= TOTAL_ROUNDS ? "看今晚榜单" : "下一局"}</button>
      </div>`;
  }

  function couponCard() {
    return `
      <div class="coupon">
        <div class="shop">大冰的小屋 · 烟台山分舵</div>
        <h3>路上听歌</h3>
        <div class="gift">小吃券 一份<br/>下次来盖章  +1 积分</div>
        <p class="fine-print">此为样稿，不能当真核销。</p>
        <div class="seal">同路</div>
      </div>`;
  }

  function viewResults() {
    const list = sortedTeams();
    const rank = playerRank();
    return `
      <div class="phone-shell">
        <div class="topbar">
          <div>
            <div class="brand-kicker">今晚榜单</div>
            <h1 class="brand-title">路上听歌</h1>
          </div>
          <div class="queue-pill">本队第<strong>${rank}</strong></div>
        </div>
        ${banner()}
        <section class="paper">
          <h2>各队成绩</h2>
          <div class="rank-list">
            ${list
              .map(function (t, i) {
                return `<div class="rank-item"><div class="pos">${i + 1}</div><div>${escapeHtml(t.name)}${t.isPlayer ? " · 本队" : ""}</div><strong>${t.score}</strong></div>`;
              })
              .join("")}
          </div>
        </section>
        ${couponCard()}
        <button type="button" class="btn-main" id="btn-again" style="box-shadow:0 8px 0 #6d1b12;">再玩一局</button>
      </div>`;
  }

  function viewCalled() {
    const rank = playerRank();
    return `
      <div class="phone-shell">
        ${banner()}
        <div class="called-hero">
          <div class="no">${state.queueNo} 号</div>
          <p>号到了，先去店里听歌吧。<br/>这一局先替你结算，分还在。</p>
        </div>
        <section class="paper">
          <h2>本队此刻第 ${rank}</h2>
          <p class="muted">进门以后把这张样稿券给店里看就行。正式版会做成能核销的真实奖励。</p>
        </section>
        ${couponCard()}
        <button type="button" class="btn-main" id="btn-again">回到门口再看一局</button>
      </div>`;
  }

  function miniBoard(showGain) {
    const list = sortedTeams();
    return `<div class="mini-board">${list
      .map(function (t) {
        const extra = showGain && t.lastGain ? "  +" + t.lastGain : t.answered && state.view === "question" ? "  已答" : "";
        return `<div class="${t.isPlayer ? "is-me" : ""}"><b>${escapeHtml(t.name)}</b>  ${t.score}${extra}</div>`;
      })
      .join("")}</div>`;
  }

  function viewScreen() {
    const live = state && state.teams && state.teams.length;
    const list = live ? sortedTeams() : [];
    const max = Math.max(1, ...list.map(function (t) { return t.score; }));
    let nowLine = "把手机样稿打开后，这边会同步显示比分。";
    let nowBig = "等候开局";
    if (!live) {
      nowLine = "门口电视样稿";
      nowBig = "还没有进行中的一局";
    } else if (state.view === "lobby") {
      nowLine = "队伍正在门口集合";
      nowBig = "即将开局";
    } else if (state.view === "question") {
      const left = Math.max(0, Math.ceil((state.question.endsAt - Date.now()) / 1000));
      nowLine = `第 ${state.roundIndex + 1} / ${TOTAL_ROUNDS} 局 · 还剩 ${left} 秒`;
      nowBig = "正在放歌，请听这一段";
    } else if (state.view === "reveal") {
      nowLine = `第 ${state.roundIndex + 1} / ${TOTAL_ROUNDS} 局 · 揭晓`;
      nowBig = "这一段是「" + state.question.title + "」";
    } else if (state.view === "results") {
      nowLine = "今晚这一轮结束";
      nowBig = "看榜，也别忘了手里的券";
    } else if (state.view === "called") {
      nowLine = "有一桌号到了";
      nowBig = state.queueNo + " 号，请入场听歌";
    } else if (state.view === "join") {
      nowLine = "客人正在扫码入队";
      nowBig = "路上听歌";
    }
    const board = live
      ? `<div class="bars">${list
          .map(function (t) {
            const w = Math.round((t.score / max) * 100);
            return `<div class="bar-row">
              <div class="name ${t.isPlayer ? "me" : ""}">${escapeHtml(t.name)}${t.isPlayer ? " · 本队" : ""}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
              <div class="pts">${t.score}</div>
            </div>`;
          })
          .join("")}</div>`
      : `<div class="idle-actions">
           <p class="muted" style="color:#e8c48a;margin-bottom:12px;">若只想先看看大屏效果，可以开一局演示。</p>
           <button type="button" class="btn-main" id="btn-demo">演示大屏</button>
         </div>`;

    return `
      <div class="screen">
        <div class="screen-head">
          <div>
            <div class="brand-kicker">大冰的小屋 · 烟台山分舵</div>
            <h1>路上听歌</h1>
          </div>
          <div>${banner()}</div>
        </div>
        <div class="screen-now">${nowLine}<span class="big">${escapeHtml(nowBig)}</span></div>
        ${board}
        <div class="screen-foot">
          <span>几拨人同时分组比 · 答得又对又快分更高</span>
          <span>${live ? "今晚号码 " + state.queueNo + " 号也在场" : "正式版会换成店里歌手的录音"}</span>
        </div>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bind() {
    const nameInput = document.getElementById("name-input");
    if (nameInput) {
      nameInput.addEventListener("input", function () {
        state.playerName = nameInput.value;
      });
    }
    const grid = document.getElementById("team-grid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        const btn = e.target.closest("[data-team]");
        if (!btn) return;
        state.teamName = btn.getAttribute("data-team");
        render();
        const again = document.getElementById("name-input");
        if (again) again.value = state.playerName || "";
      });
    }
    const custom = document.getElementById("custom-team");
    if (custom) {
      custom.addEventListener("change", function () {
        const v = custom.value.trim();
        if (v) {
          state.teamName = v.slice(0, 8);
          render();
        }
      });
    }
    const join = document.getElementById("btn-join");
    if (join) {
      join.addEventListener("click", function () {
        const n = ((document.getElementById("name-input") || {}).value || state.playerName || "").trim() || "同路人";
        const customVal = ((document.getElementById("custom-team") || {}).value || "").trim();
        const team = customVal ? customVal.slice(0, 8) : state.teamName || "路上队";
        startLobby(n, team);
      });
    }
    const start = document.getElementById("btn-start");
    if (start) start.addEventListener("click", startRound);
    const play = document.getElementById("btn-play");
    if (play) {
      play.addEventListener("click", function () {
        if (state.question) playClip(state.question.src);
      });
    }
    document.querySelectorAll("[data-opt]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        playerAnswer(Number(btn.getAttribute("data-opt")));
      });
    });
    const next = document.getElementById("btn-next");
    if (next) {
      next.addEventListener("click", function () {
        if (state.roundIndex + 1 >= TOTAL_ROUNDS) finishGame(false);
        else startRound();
      });
    }
    const called = document.getElementById("btn-called");
    if (called) called.addEventListener("click", function () { finishGame(true); });
    const again = document.getElementById("btn-again");
    if (again) {
      again.addEventListener("click", function () {
        const keepNo = state.queueNo;
        const keepName = state.playerName;
        const keepTeam = state.teamName;
        stopBots();
        stopTimer();
        stopAudio();
        state = defaultState();
        state.queueNo = keepNo;
        state.playerName = keepName;
        state.teamName = keepTeam;
        publish();
        render();
      });
    }
    const demo = document.getElementById("btn-demo");
    if (demo) demo.addEventListener("click", startDemo);
  }

  function startDemo() {
    state = defaultState();
    startLobby("演示", "路上队");
    startRound();
  }

  function render() {
    document.body.classList.toggle("screen-mode", isScreen);
    window.__xwApply = function (partial) {
    stopBots();
    stopTimer();
    stopAudio();
    state = Object.assign(defaultState(), partial || {});
    publish();
    render();
  };

  if (isScreen) {
      app.innerHTML = viewScreen();
    } else if (!state || state.view === "join") {
      if (!state) state = defaultState();
      app.innerHTML = viewJoin();
    } else if (state.view === "lobby") {
      app.innerHTML = viewLobby();
    } else if (state.view === "question") {
      app.innerHTML = viewQuestion();
    } else if (state.view === "reveal") {
      app.innerHTML = viewReveal();
    } else if (state.view === "results") {
      app.innerHTML = viewResults();
    } else if (state.view === "called") {
      app.innerHTML = viewCalled();
    }
    bind();
  }

  if (channel) {
    channel.onmessage = function (ev) {
      if (!isScreen) return;
      if (ev && ev.data && ev.data.view) {
        state = ev.data;
        render();
      }
    };
  }
  window.addEventListener("storage", function (ev) {
    if (!isScreen || ev.key !== STORAGE_KEY || !ev.newValue) return;
    try {
      state = JSON.parse(ev.newValue);
      render();
    } catch (err) {
      /* ignore */
    }
  });

  if (isScreen) {
    state = loadPublished() || defaultState();
    render();
    setInterval(function () {
      if (state && state.view === "question") render();
    }, 500);
  } else {
    state = defaultState();
    render();
  }
})();

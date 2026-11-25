/* Secret Code client. Plain JS; the server is authoritative and sends full state on every change. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- storage (wrapped: private mode / blocked storage must not break the game) -------------

  const TOKEN_KEY = 'secretCode.playerToken';
  const NAME_KEY = 'secretCode.username';

  function sget(area, key) {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  }
  function sset(area, key, value) {
    try {
      if (value == null) window[area].removeItem(key);
      else window[area].setItem(key, value);
    } catch {
      /* ignore */
    }
  }
  function saveToken(token) {
    sset('localStorage', TOKEN_KEY, token);
    sset('sessionStorage', TOKEN_KEY, token);
  }

  // ---- shapes -------------------------------------------------------------------------------

  function starPolygon() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4.4 : 10.8;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12.8 + r * Math.sin(a)).toFixed(2)}`);
    }
    return `<polygon points="${pts.join(' ')}"/>`;
  }
  const SHAPE_SVG = {
    diamond: '<polygon points="12,1.5 22,12 12,22.5 2,12"/>',
    square: '<rect x="3.5" y="3.5" width="17" height="17"/>',
    triangle: '<polygon points="12,2.5 22.5,21 1.5,21"/>',
    circle: '<circle cx="12" cy="12" r="9.5"/>',
    star: starPolygon(),
  };
  const svgFor = (shape) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SHAPE_SVG[shape] || ''}</svg>`;

  const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  // ---- client state ---------------------------------------------------------------------------

  const sessionToken = sget('sessionStorage', TOKEN_KEY);
  const ui = {
    state: null,
    token: sessionToken || sget('localStorage', TOKEN_KEY),
    ownsToken: !!sessionToken, // this tab was already playing as this token (refresh / reconnect)
    connected: false,
    everConnected: false,
    watching: false,
    replaced: false,
    inUseName: null,
    selected: [],
    roundKey: null,
    submitting: false,
    joinError: '',
    playError: '',
    lobbyError: '',
    renameMsg: '',
    renameSynced: null,
    resultKey: null,
    resultView: 'answer', // after a round: 'answer' or 'guess'
  };

  // ---- socket -----------------------------------------------------------------------------------

  if (typeof io !== 'function') {
    $('connecting-msg').textContent = 'Could not load the game. Please refresh the page.';
    return;
  }
  const socket = io({ reconnectionDelayMax: 4000 });

  const wakeTimer = setTimeout(() => {
    if (!ui.everConnected) {
      $('connecting-msg').textContent = 'Waking up the server… this can take up to a minute.';
    }
  }, 2500);

  socket.on('connect', () => {
    ui.connected = true;
    ui.everConnected = true;
    clearTimeout(wakeTimer);
    hello(false);
    render();
  });

  socket.on('disconnect', (reason) => {
    ui.connected = false;
    ui.submitting = false;
    // Socket.IO does not retry by itself when the server closed the connection; do it here.
    if (reason === 'io server disconnect') setTimeout(() => socket.connect(), 1000);
    render();
  });

  socket.on('state', (s) => {
    const key = s.phase === 'round' && s.round ? `round-${s.round.number}` : null;
    if (key !== ui.roundKey) {
      ui.roundKey = key;
      ui.selected = [];
      ui.playError = '';
    }
    ui.state = s;
    render();
  });

  socket.on('replaced', () => {
    ui.replaced = true;
    ui.ownsToken = false;
    render();
  });

  function hello(takeover) {
    socket.emit('hello', { token: ui.token, takeover: takeover || ui.ownsToken }, (res) => {
      if (!res || !res.ok) return;
      ui.inUseName = null;
      if (res.you) {
        ui.replaced = false;
        ui.ownsToken = true;
        ui.watching = false;
        saveToken(ui.token);
        sset('localStorage', NAME_KEY, res.you.name);
      } else if (res.code === 'in-use') {
        ui.inUseName = res.name || '';
      } else if (ui.token) {
        // Unknown token (server restarted, or removed after being away). Start fresh.
        if (sget('localStorage', TOKEN_KEY) === ui.token) sset('localStorage', TOKEN_KEY, null);
        if (sget('sessionStorage', TOKEN_KEY) === ui.token) sset('sessionStorage', TOKEN_KEY, null);
        ui.token = null;
        ui.ownsToken = false;
      }
      render();
    });
  }

  /** Emit with a timeout. cb(errorMessage | null, response) */
  function send(event, payload, cb) {
    if (!ui.connected) return cb('You are offline. Reconnecting…', null);
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) return cb('No response from the server. Please try again.', null);
      if (!res || !res.ok) return cb((res && res.error) || 'Something went wrong.', res);
      cb(null, res);
    });
  }

  // ---- static wiring -----------------------------------------------------------------------------

  const grid = $('grid');
  const cardEls = LETTERS.map((letter) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'card';
    el.dataset.letter = letter;
    el.addEventListener('click', () => toggleCard(letter));
    grid.appendChild(el);
    return el;
  });

  // Join
  $('join-name').value = sget('localStorage', NAME_KEY) || '';
  $('join-name').addEventListener('input', () => {
    if (ui.joinError) {
      ui.joinError = '';
      render();
    }
  });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanName($('join-name').value);
    const problem = nameProblem(name);
    if (problem) {
      ui.joinError = problem;
      return render();
    }
    $('join-btn').disabled = true;
    send('join', { name }, (err, res) => {
      $('join-btn').disabled = false;
      if (err) {
        ui.joinError = err;
      } else {
        ui.token = res.token;
        ui.ownsToken = true;
        ui.watching = false;
        ui.inUseName = null;
        saveToken(res.token);
        sset('localStorage', NAME_KEY, res.you.name);
        ui.joinError = '';
      }
      render();
    });
  });
  $('watch-btn').addEventListener('click', () => {
    ui.watching = true;
    render();
  });
  $('banner-join').addEventListener('click', () => {
    ui.watching = false;
    ui.joinError = '';
    render();
    $('join-name').focus();
  });

  // Another tab
  $('takeover-btn').addEventListener('click', () => {
    ui.replaced = false;
    ui.inUseName = null;
    hello(true);
  });
  $('new-player-btn').addEventListener('click', () => {
    ui.inUseName = null;
    ui.token = null;
    ui.ownsToken = false;
    render();
  });

  // Results: switch between the correct answer and your own guess
  document.querySelectorAll('#view-toggle .toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ui.resultView = btn.dataset.view;
      render();
    });
  });

  // Rounds
  $('start-btn').addEventListener('click', () => startRound('lobbyError'));
  $('next-btn').addEventListener('click', () => startRound('lobbyError'));
  function startRound(errKey) {
    send('start', {}, (err) => {
      ui[errKey] = err || '';
      render();
    });
  }

  $('submit-btn').addEventListener('click', () => {
    if (ui.selected.length !== 4 || !canSelect()) return;
    ui.submitting = true;
    ui.playError = '';
    render();
    const cards = [...ui.selected];
    send('submit', { cards }, (err, res) => {
      ui.submitting = false;
      if (err) {
        ui.playError = err;
      } else if (!res.correct) {
        shakeWrong();
      }
      render();
    });
  });

  // Confirm-step buttons (End round, Reset scores)
  document.querySelectorAll('.confirm').forEach((box) => {
    const open = box.querySelector('.confirm-open');
    const ask = box.querySelector('.confirm-ask');
    const close = () => {
      open.hidden = false;
      ask.hidden = true;
    };
    box._close = close;
    open.addEventListener('click', () => {
      open.hidden = true;
      ask.hidden = false;
      box.querySelector('.confirm-yes').focus();
    });
    box.querySelector('.confirm-no').addEventListener('click', close);
    box.querySelector('.confirm-yes').addEventListener('click', () => {
      close();
      send(box.dataset.action, {}, (err) => {
        ui.playError = err || '';
        ui.lobbyError = err || '';
        render();
      });
    });
  });

  // Rename / leave
  $('rename-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = cleanName($('rename-input').value);
    const problem = nameProblem(name);
    if (problem) {
      ui.renameMsg = problem;
      return render();
    }
    send('rename', { name }, (err, res) => {
      ui.renameMsg = err || '';
      if (!err) {
        sset('localStorage', NAME_KEY, res.name);
        $('join-name').value = res.name;
      }
      render();
    });
  });
  $('rename-input').addEventListener('input', () => {
    if (ui.renameMsg) {
      ui.renameMsg = '';
      render();
    }
  });
  $('leave-btn').addEventListener('click', () => {
    send('leave', {}, (err) => {
      if (err) {
        ui.renameMsg = err;
      } else {
        saveToken(null);
        ui.token = null;
        ui.ownsToken = false;
        ui.watching = false;
      }
      render();
    });
  });

  // ---- helpers -------------------------------------------------------------------------------------

  function cleanName(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim();
  }
  function nameProblem(name) {
    if (!name) return 'Please enter a username.';
    if ([...name].length > 16) return 'Usernames can be at most 16 characters.';
    return '';
  }

  function canSelect() {
    const s = ui.state;
    return !!(s && s.phase === 'round' && s.you && s.you.status === 'playing' && ui.connected && !ui.submitting);
  }

  function toggleCard(letter) {
    if (!canSelect()) return;
    const i = ui.selected.indexOf(letter);
    if (i >= 0) ui.selected.splice(i, 1);
    else if (ui.selected.length < 4) ui.selected.push(letter);
    else {
      ui.playError = 'You already have 4 cards. Tap one to deselect it.';
      return render();
    }
    ui.playError = '';
    render();
  }

  function shakeWrong() {
    const targets = [$('actionbar'), ...ui.selected.map((l) => cardEls[LETTERS.indexOf(l)])];
    for (const el of targets) {
      el.classList.remove('shake');
      void el.offsetWidth; // restart animation
      el.classList.add('shake');
      el.addEventListener('animationend', () => el.classList.remove('shake'), { once: true });
    }
    setTimeout(() => {
      ui.selected = [];
      render();
    }, 450);
  }

  function show(id, visible) {
    $(id).hidden = !visible;
  }

  function place(childId, parentId) {
    const child = $(childId);
    const parent = $(parentId);
    if (child.parentElement !== parent) parent.appendChild(child);
  }
  function park(childId) {
    const holder = document.querySelector('body > div[hidden]');
    const child = $(childId);
    if (child.parentElement !== holder) {
      if (child._close) child._close();
      holder.appendChild(child);
    }
  }

  // ---- rendering ---------------------------------------------------------------------------------------

  function render() {
    const s = ui.state;
    show('net-banner', ui.everConnected && !ui.connected);

    let screen;
    if (!ui.everConnected || !s) screen = 'connecting';
    else if (ui.replaced || ui.inUseName !== null) screen = 'replaced';
    else if (!s.you && !ui.watching) screen = 'join';
    else screen = 'game';

    for (const name of ['connecting', 'replaced', 'join', 'game']) show(`screen-${name}`, screen === name);
    document.body.classList.toggle('has-actionbar', false);

    if (screen === 'replaced') renderReplaced();
    if (screen === 'join') renderJoin(s);
    if (screen === 'game') renderGame(s);
  }

  function renderReplaced() {
    if (ui.replaced) {
      $('replaced-msg').textContent = 'You opened the game in another tab.';
      $('takeover-btn').textContent = 'Play in this tab';
      show('new-player-btn', false);
    } else {
      const who = ui.inUseName ? ` as “${ui.inUseName}”` : '';
      $('replaced-msg').textContent = `Secret Code is already open in another tab${who}.`;
      $('takeover-btn').textContent = ui.inUseName ? `Play here as ${ui.inUseName}` : 'Play here instead';
      show('new-player-btn', true);
    }
  }

  function renderJoin(s) {
    const full = s.players.length >= s.maxPlayers;
    const parts = [`${s.players.length} of ${s.maxPlayers} players in the room.`];
    if (s.phase === 'round' && !full) parts.push("A round is in progress. You'll join the next one.");
    $('join-info').textContent = parts.join(' ');
    show('join-full', full);
    $('join-btn').disabled = full || !ui.connected;
    $('join-error').textContent = ui.joinError;
  }

  function renderGame(s) {
    const you = s.you;
    const mode = s.phase === 'round' ? 'round' : s.lastResult ? 'results' : 'lobby';

    // Top bar
    $('round-label').textContent =
      mode === 'round' ? `Round ${s.round.number}` : mode === 'results' ? `Round ${s.lastResult.number}` : '';
    $('me-label').textContent = you
      ? `${you.name} (you) · ${you.score} ${you.score === 1 ? 'pt' : 'pts'}`
      : 'Spectating';

    renderBanner(s, mode);

    show('lobby-view', mode === 'lobby');
    show('play-view', mode !== 'lobby');

    // Movable account + reset panels (only between rounds, only for players)
    const between = mode !== 'round' && !!you;
    if (between) {
      place('account-panel', mode === 'lobby' ? 'account-home' : 'account-play');
      place('reset-game', mode === 'lobby' ? 'lobby-reset' : 'reset-slot');
      const input = $('rename-input');
      if (ui.renameSynced !== you.name) {
        ui.renameSynced = you.name;
        input.value = you.name;
      }
      $('rename-msg').textContent = ui.renameMsg;
    } else {
      park('account-panel');
      park('reset-game');
    }

    if (mode === 'lobby') renderLobby(s);
    else renderPlay(s, mode);
  }

  function renderBanner(s, mode) {
    const you = s.you;
    let text = '';
    let warn = false;
    let canJoin = false;
    if (!you) {
      canJoin = s.players.length < s.maxPlayers;
      text = canJoin
        ? 'You are spectating. A seat is free.'
        : `You are spectating. The room is full (${s.maxPlayers} players).`;
    } else if (mode === 'round' && you.status === 'spectating') {
      text = "You'll join next round. You can watch this one.";
    } else if (mode === 'round' && you.status === 'out') {
      text = "Wrong guess. You're out for this round.";
      warn = true;
    }
    show('banner', !!text);
    $('banner').classList.toggle('warn', warn);
    $('banner-text').textContent = text;
    show('banner-join', canJoin);
  }

  function renderLobby(s) {
    const you = s.you;
    $('lobby-count').textContent = `(${s.players.length}/${s.maxPlayers})${s.watchers ? ` · ${s.watchers} watching` : ''}`;
    renderPlayers($('lobby-players'), s, true);
    show('start-btn', !!you);
    $('start-btn').disabled = !ui.connected;
    $('lobby-error').textContent = ui.lobbyError;
  }

  function renderPlay(s, mode) {
    const you = s.you;
    const inRound = mode === 'round';
    const result = s.lastResult;
    const board = inRound ? s.round.board : result.board;

    // Your own wrong guess (only ever sent to you): live while you're out, then after the round.
    const guess = you ? (inRound ? you.guess : you.lastGuess) : null;
    if (!inRound && ui.resultKey !== result.number) {
      ui.resultKey = result.number;
      ui.resultView = 'answer';
    }
    const showGuess = !!guess && (inRound || ui.resultView === 'guess');
    const solution = inRound || showGuess ? [] : result.solution;
    const guessCards = showGuess ? guess.cards : [];

    // Headline
    $('headline').textContent = inRound
      ? 'Find the 4 cards that match every rule.'
      : showGuess
        ? `Round ${result.number}: your guess was ${guess.cards.join(' · ')}`
        : `Round ${result.number}: the secret code was ${result.solution.join(' · ')}`;

    // Cards
    const selectable = canSelect();
    board.forEach((card, i) => {
      const el = cardEls[i];
      const sig = `${card.color}|${card.shape}`;
      if (el._sig !== sig) {
        el._sig = sig;
        el.className = 'card';
        el.innerHTML = `<span class="letter">${card.letter}</span><span class="num">${card.number}</span>${svgFor(card.shape)}`;
        el.title = `${card.letter} · ${card.number} · ${card.color} ${card.shape}`;
      }
      const isSel = inRound && ui.selected.includes(card.letter);
      const isSol = solution.includes(card.letter);
      const isGuess = guessCards.includes(card.letter);
      el.classList.toggle(`c-${card.color}`, true);
      for (const c of ['yellow', 'green', 'blue', 'purple', 'white']) if (c !== card.color) el.classList.remove(`c-${c}`);
      el.classList.toggle('selected', isSel);
      el.classList.toggle('solution', isSol);
      el.classList.toggle('guess', isGuess);
      el.classList.toggle('dim', !inRound && !isSol && !isGuess);
      el.disabled = !selectable;
      el.setAttribute('aria-pressed', String(isSel));
      el.setAttribute(
        'aria-label',
        `${card.letter}, ${card.number}, ${card.color} ${card.shape}${isSel ? ', selected' : ''}${isSol ? ', part of the answer' : ''}${isGuess ? ', your guess' : ''}`,
      );
    });

    // Rules
    const rulesEl = $('rules');
    const rules = showGuess ? guess.rules : inRound ? s.round.rules.map((text) => ({ text })) : result.rules;
    const ticked = showGuess || !inRound;
    show('guess-note', showGuess);
    if (showGuess) {
      const broke = guess.rules.filter((r) => !r.ok).length;
      $('guess-note').textContent = `Your guess (${guess.cards.join(' · ')}) broke ${broke} ${
        broke === 1 ? 'rule' : 'rules'
      }, marked ✗.`;
    }
    rulesEl.replaceChildren(
      ...rules.map((rule, i) => {
        const li = document.createElement('li');
        const num = document.createElement('span');
        num.className = 'rnum';
        num.textContent = CIRCLED[i] || `${i + 1}.`;
        const text = document.createElement('span');
        text.textContent = rule.text;
        li.append(num, text);
        if (ticked) {
          li.classList.toggle('fail', !rule.ok);
          const tick = document.createElement('span');
          tick.className = 'tick';
          tick.textContent = rule.ok ? '✓' : '✗';
          tick.setAttribute('aria-label', rule.ok ? 'satisfied' : 'not satisfied');
          const detail = document.createElement('span');
          detail.className = 'detail';
          detail.textContent = rule.detail || '';
          li.append(tick, detail);
        }
        return li;
      }),
    );

    // Selection bar
    const playing = inRound && you && you.status === 'playing';
    show('actionbar', !!playing);
    document.body.classList.toggle('has-actionbar', !!playing);
    if (playing) {
      const sorted = [...ui.selected].sort();
      $('slots').replaceChildren(
        ...[0, 1, 2, 3].map((i) => {
          const slot = document.createElement('div');
          slot.className = `slot${sorted[i] ? ' filled' : ''}`;
          slot.textContent = sorted[i] || '';
          return slot;
        }),
      );
      $('submit-btn').disabled = ui.selected.length !== 4 || !selectable;
      $('submit-btn').textContent = ui.submitting ? 'Checking…' : 'Submit';
    }
    $('play-error').textContent = inRound ? ui.playError : '';

    // Result
    show('result-box', !inRound);
    if (!inRound) {
      $('result-text').textContent = resultText(result, you);
      show('view-toggle', !!guess);
      document.querySelectorAll('#view-toggle .toggle-btn').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.view === (showGuess ? 'guess' : 'answer')));
      });
      show('next-btn', !!you);
      $('next-btn').disabled = !ui.connected;
      $('result-error').textContent = ui.lobbyError;
    }

    // Players / scoreboard
    $('players-title').textContent = `${inRound ? 'Players' : 'Scoreboard'} (${s.players.length}/${s.maxPlayers})${
      s.watchers ? ` · ${s.watchers} watching` : ''
    }`;
    renderPlayers($('play-players'), s, !inRound);

    show('end-round', inRound && !!you);
    if (!inRound) $('end-round')._close();
  }

  function resultText(r, you) {
    const mine = (id) => you && id === you.id;
    switch (r.outcome) {
      case 'solved':
        return mine(r.winnerId) ? 'You cracked the code! +1 point.' : `${r.winnerName} cracked the code! +1 point.`;
      case 'all-wrong':
        return 'Everyone guessed wrong. Nobody wins this round.';
      case 'ended':
        return `${you && r.endedByName === you.name ? 'You' : r.endedByName} ended the round. No winner.`;
      case 'abandoned':
        return 'The round ended because everyone left.';
      default:
        return 'Round over.';
    }
  }

  const STATUS_TAG = { out: 'out', spectating: 'next round' };

  function renderPlayers(ul, s, byScore) {
    const list = [...s.players];
    if (byScore) list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    ul.replaceChildren(
      ...list.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = `dot${p.connected ? '' : ' off'}`;
        dot.title = p.connected ? 'Connected' : 'Disconnected';
        const name = document.createElement('span');
        name.className = 'pname';
        name.textContent = p.name;
        li.append(dot, name);
        if (s.you && p.id === s.you.id) {
          const you = document.createElement('span');
          you.className = 'you';
          you.textContent = '(you)';
          li.append(you);
        }
        const tags = [];
        if (STATUS_TAG[p.status]) tags.push([STATUS_TAG[p.status], p.status]);
        if (!p.connected) tags.push(['offline', 'off']);
        for (const [label, cls] of tags) {
          const tag = document.createElement('span');
          tag.className = `ptag ${cls}`;
          tag.textContent = label;
          li.append(tag);
        }
        const score = document.createElement('span');
        score.className = 'pscore';
        score.textContent = String(p.score);
        score.title = `${p.score} ${p.score === 1 ? 'point' : 'points'}`;
        li.append(score);
        return li;
      }),
    );
  }

  render();
})();

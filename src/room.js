// Game room state: players, rounds, scores. No sockets here; server.js wires this up.
// The room is fully authoritative and never exposes the solution while a round is running.

import crypto from 'node:crypto';
import { generatePuzzle, LETTERS, evaluateRule, explainRule } from './puzzle.js';

export const MAX_PLAYERS = 8;
export const NAME_MAX = 16;

/** Validate and normalise a username. Returns { name } or { error }. */
export function validateName(raw) {
  if (typeof raw !== 'string') return { error: 'Please enter a username.' };
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Please enter a username.' };
  if ([...name].length > NAME_MAX) return { error: `Usernames can be at most ${NAME_MAX} characters.` };
  if (/\p{C}/u.test(name)) return { error: 'That username contains characters that are not allowed.' };
  return { name };
}

const fail = (code, error) => ({ ok: false, code, error });

export class Room {
  /**
   * @param {object} opts
   * @param {() => {board, rules, solution}} [opts.makePuzzle]
   * @param {() => number} [opts.now]
   * @param {number} [opts.maxPlayers]
   * @param {number} [opts.lobbyTimeoutMs]  remove players disconnected this long (lobby only)
   * @param {number} [opts.graceMs]         a disconnect shorter than this (e.g. a refresh) still counts as present
   */
  constructor({
    makePuzzle = () => generatePuzzle(),
    now = Date.now,
    maxPlayers = MAX_PLAYERS,
    lobbyTimeoutMs = 3 * 60 * 1000,
    graceMs = 10 * 1000,
  } = {}) {
    this.makePuzzle = makePuzzle;
    this.now = now;
    this.maxPlayers = maxPlayers;
    this.lobbyTimeoutMs = lobbyTimeoutMs;
    this.graceMs = graceMs;

    this.players = new Map(); // id -> player
    this.byToken = new Map(); // secret token -> id
    this.phase = 'lobby'; // 'lobby' | 'round'
    this.round = null;
    this.lastResult = null;
    this.roundNumber = 0;
    this.onChange = () => {};
  }

  changed() {
    this.onChange();
  }

  // ---- players ------------------------------------------------------------

  nameTaken(name, exceptId = null) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.id !== exceptId && p.name.toLowerCase() === lower) return true;
    return false;
  }

  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  addPlayer(rawName) {
    const v = validateName(rawName);
    if (v.error) return fail('name-invalid', v.error);
    if (this.isFull()) return fail('full', `The room is full (${this.maxPlayers} players).`);
    if (this.nameTaken(v.name)) return fail('name-taken', `“${v.name}” is already taken. Try another name.`);

    const player = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomUUID(),
      name: v.name,
      score: 0,
      connected: false,
      disconnectedAt: this.now(),
    };
    this.players.set(player.id, player);
    this.byToken.set(player.token, player.id);
    this.changed();
    return { ok: true, player };
  }

  playerByToken(token) {
    if (typeof token !== 'string') return null;
    const id = this.byToken.get(token);
    return id ? this.players.get(id) ?? null : null;
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    if (!connected) p.disconnectedAt = this.now();
    this.changed();
  }

  rename(id, rawName) {
    const p = this.players.get(id);
    if (!p) return fail('not-player', 'You are not in the game.');
    if (this.phase === 'round') return fail('in-round', 'You can change your name after this round.');
    const v = validateName(rawName);
    if (v.error) return fail('name-invalid', v.error);
    if (this.nameTaken(v.name, id)) return fail('name-taken', `“${v.name}” is already taken. Try another name.`);
    p.name = v.name;
    this.changed();
    return { ok: true, name: p.name };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return fail('not-player', 'You are not in the game.');
    if (this.phase === 'round') return fail('in-round', 'You can leave after this round.');
    this.players.delete(id);
    this.byToken.delete(p.token);
    this.changed();
    return { ok: true };
  }

  /** Disconnected long enough that we stop waiting for them in "has everyone answered?" checks. */
  isAway(p) {
    return !p.connected && this.now() - p.disconnectedAt >= this.graceMs;
  }

  // ---- rounds -------------------------------------------------------------

  startRound(id) {
    if (!this.players.has(id)) return fail('not-player', 'Join the game first.');
    if (this.phase === 'round') return fail('in-round', 'A round is already in progress.');

    const puzzle = this.makePuzzle();
    this.roundNumber++;
    this.round = {
      number: this.roundNumber,
      puzzle,
      solutionLetters: puzzle.solution.map((i) => LETTERS[i]),
      participants: new Set(this.players.keys()),
      wrong: new Set(),
      startedAt: this.now(),
    };
    this.phase = 'round';
    this.changed();
    return { ok: true };
  }

  submit(id, cards) {
    const p = this.players.get(id);
    if (!p) return fail('not-player', 'Join the game first.');
    if (this.phase !== 'round') return fail('no-round', 'There is no round in progress.');
    const r = this.round;
    if (!r.participants.has(id)) return fail('spectator', "You joined mid-round. You'll play next round.");
    if (r.wrong.has(id)) return fail('locked', 'You already used your guess this round.');

    if (!Array.isArray(cards) || cards.length !== 4) return fail('bad-cards', 'Select exactly 4 cards.');
    const letters = [];
    for (const c of cards) {
      if (typeof c !== 'string' || c.length !== 1 || !LETTERS.includes(c)) return fail('bad-cards', 'Invalid card.');
      letters.push(c);
    }
    if (new Set(letters).size !== 4) return fail('bad-cards', 'Select 4 different cards.');

    letters.sort();
    if (letters.join('') === r.solutionLetters.join('')) {
      p.score += 1;
      this.finishRound('solved', { winner: p });
      return { ok: true, correct: true };
    }

    r.wrong.add(id);
    this.changed();
    this.checkAllWrong();
    return { ok: true, correct: false };
  }

  endRound(id) {
    const p = this.players.get(id);
    if (!p) return fail('not-player', 'Join the game first.');
    if (this.phase !== 'round') return fail('no-round', 'There is no round in progress.');
    this.finishRound('ended', { endedBy: p });
    return { ok: true };
  }

  resetScores(id) {
    if (!this.players.has(id)) return fail('not-player', 'Join the game first.');
    if (this.phase === 'round') return fail('in-round', 'You can reset scores after this round.');
    for (const p of this.players.values()) p.score = 0;
    this.changed();
    return { ok: true };
  }

  /** Everyone who is still in the round has guessed wrong (ignoring players who have been away). */
  checkAllWrong() {
    if (this.phase !== 'round') return false;
    const r = this.round;
    if (r.wrong.size === 0) return false;
    for (const pid of r.participants) {
      const p = this.players.get(pid);
      if (!p || r.wrong.has(pid) || this.isAway(p)) continue;
      return false;
    }
    this.finishRound('all-wrong');
    return true;
  }

  finishRound(outcome, { winner = null, endedBy = null } = {}) {
    const r = this.round;
    const { board, rules, solution } = r.puzzle;
    this.lastResult = {
      number: r.number,
      outcome, // 'solved' | 'all-wrong' | 'ended' | 'abandoned'
      winnerId: winner?.id ?? null,
      winnerName: winner?.name ?? null,
      endedByName: endedBy?.name ?? null,
      board,
      solution: r.solutionLetters,
      rules: rules.map((rule) => ({
        text: rule.text,
        ok: evaluateRule(rule, board, solution),
        detail: explainRule(rule, board, solution),
      })),
    };
    this.phase = 'lobby';
    this.round = null;
    this.changed();
  }

  /** Periodic housekeeping. Call every couple of seconds. */
  tick() {
    const now = this.now();
    if (this.phase === 'round') {
      if (this.checkAllWrong()) return;
      // Nobody left at all for a long time: close the round so the room can clean up.
      const players = [...this.players.values()];
      if (players.length && players.every((p) => !p.connected && now - p.disconnectedAt >= this.lobbyTimeoutMs)) {
        this.finishRound('abandoned');
      }
      return;
    }
    let removed = false;
    for (const p of [...this.players.values()]) {
      if (!p.connected && now - p.disconnectedAt >= this.lobbyTimeoutMs) {
        this.players.delete(p.id);
        this.byToken.delete(p.token);
        removed = true;
      }
    }
    if (removed) this.changed();
  }

  // ---- views --------------------------------------------------------------

  statusOf(p) {
    if (this.phase !== 'round') return 'lobby';
    if (!this.round.participants.has(p.id)) return 'spectating';
    return this.round.wrong.has(p.id) ? 'out' : 'playing';
  }

  /** The state one client is allowed to see. Never contains the live solution. */
  viewFor(playerId, { watchers = 0 } = {}) {
    const me = playerId ? this.players.get(playerId) : null;
    const r = this.round;
    return {
      phase: this.phase,
      maxPlayers: this.maxPlayers,
      watchers,
      you: me ? { id: me.id, name: me.name, score: me.score, status: this.statusOf(me) } : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        status: this.statusOf(p),
      })),
      round:
        this.phase === 'round'
          ? {
              number: r.number,
              board: r.puzzle.board,
              rules: r.puzzle.rules.map((rule) => rule.text),
            }
          : null,
      lastResult: this.lastResult,
    };
  }
}

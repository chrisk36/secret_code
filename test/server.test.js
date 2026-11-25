import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../server.js';
import { Room } from '../src/room.js';
import { generatePuzzle, mulberry32, LETTERS } from '../src/puzzle.js';

// ---- harness -------------------------------------------------------------------------------

let ctx;

async function setup() {
  const clock = { t: 1_000_000 };
  const rng = mulberry32(7);
  const puzzles = [];
  const room = new Room({
    now: () => clock.t,
    graceMs: 10_000,
    lobbyTimeoutMs: 180_000,
    makePuzzle: () => {
      const p = generatePuzzle({ rng });
      puzzles.push(p);
      return p;
    },
  });
  const srv = createServer({ room, tickMs: 3_600_000 });
  await new Promise((resolve) => srv.server.listen(0, resolve));
  const url = `http://localhost:${srv.server.address().port}`;
  const sockets = [];
  return {
    srv,
    room,
    clock,
    url,
    sockets,
    solution: () => puzzles.at(-1).solution.map((i) => LETTERS[i]),
    wrongAnswer: () => {
      const sol = puzzles.at(-1).solution;
      const wrong = [0, 1, 2, 3].join() === sol.join() ? [0, 1, 2, 4] : [0, 1, 2, 3];
      return wrong.map((i) => LETTERS[i]);
    },
  };
}

function client() {
  const s = connect(ctx.url, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.state = null;
  s.on('state', (st) => (s.state = st));
  ctx.sockets.push(s);
  return s;
}

const call = (s, event, payload = {}) => new Promise((resolve) => s.emit(event, payload, resolve));

async function until(pred, label = 'condition', ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Connect, say hello, and join with a name. Returns { s, token }. */
async function player(name) {
  const s = client();
  await call(s, 'hello', {});
  const res = await call(s, 'join', { name });
  assert.equal(res.ok, true, `join ${name}: ${res.error}`);
  await until(() => s.state?.you?.name === res.you.name, `${name} state`);
  return { s, token: res.token, id: res.you.id };
}

/** Simulate a page refresh: drop the socket and come back with the same token. */
async function refresh(token) {
  const s = client();
  const res = await call(s, 'hello', { token, takeover: true });
  await until(() => s.state?.you, 'resumed state');
  return { s, res };
}

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  for (const s of ctx.sockets) s.disconnect();
  await ctx.srv.close();
});

// ---- tests -------------------------------------------------------------------------------------

describe('server', () => {
  test('/healthz responds', async () => {
    const res = await fetch(`${ctx.url}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('serves the frontend', async () => {
    const res = await fetch(ctx.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Secret Code<\/title>/);
  });

  test('usernames: trimmed, 1–16 chars, unique case-insensitively', async () => {
    const a = await player('  Alice  ');
    assert.equal(a.s.state.you.name, 'Alice');

    const b = client();
    await call(b, 'hello', {});
    assert.equal((await call(b, 'join', { name: '   ' })).code, 'name-invalid');
    assert.equal((await call(b, 'join', { name: 'x'.repeat(17) })).code, 'name-invalid');
    assert.equal((await call(b, 'join', { name: 42 })).code, 'name-invalid');
    const dup = await call(b, 'join', { name: 'ALICE' });
    assert.equal(dup.code, 'name-taken');
    assert.match(dup.error, /already taken/);
    assert.equal((await call(b, 'join', { name: 'x'.repeat(16) })).ok, true);
  });

  test('rename works in the lobby, keeps score, and is blocked during a round', async () => {
    const a = await player('Alice');
    await player('Bob');
    assert.equal((await call(a.s, 'rename', { name: 'bob' })).code, 'name-taken');

    await call(a.s, 'start');
    assert.equal((await call(a.s, 'submit', { cards: ctx.solution() })).correct, true);
    await until(() => a.s.state.you.score === 1, 'score');

    assert.equal((await call(a.s, 'rename', { name: 'Alicia' })).ok, true);
    await until(() => a.s.state.you.name === 'Alicia', 'rename');
    assert.equal(a.s.state.you.score, 1);

    await call(a.s, 'start');
    assert.equal((await call(a.s, 'rename', { name: 'Ally' })).code, 'in-round');
  });

  test('the solution is never sent during a round', async () => {
    const a = await player('Alice');
    await call(a.s, 'start');
    await until(() => a.s.state.phase === 'round', 'round');
    const st = a.s.state;
    assert.equal(st.lastResult, null);
    assert.deepEqual(Object.keys(st.round).sort(), ['board', 'number', 'rules']);
    assert.ok(st.round.rules.every((r) => typeof r === 'string'));
    assert.ok(!JSON.stringify(st).includes('solution'));
  });

  test('correct answer: wins, +1 point, round ends for everyone with the solution revealed', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    const res = await call(b.s, 'submit', { cards: [...ctx.solution()].reverse() }); // order does not matter
    assert.deepEqual(res, { ok: true, correct: true });

    await until(() => a.s.state.phase === 'lobby' && a.s.state.lastResult, 'result');
    const r = a.s.state.lastResult;
    assert.equal(r.outcome, 'solved');
    assert.equal(r.winnerName, 'Bob');
    assert.deepEqual(r.solution, ctx.solution());
    assert.ok(r.rules.length >= 5 && r.rules.every((x) => x.ok && x.text && x.detail));
    assert.equal(a.s.state.players.find((p) => p.name === 'Bob').score, 1);
    assert.equal(a.s.state.players.find((p) => p.name === 'Alice').score, 0);
  });

  test('wrong answer locks the player out; others see "out" but not the cards', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    const wrong = ctx.wrongAnswer();
    assert.deepEqual(await call(a.s, 'submit', { cards: wrong }), { ok: true, correct: false });

    await until(() => b.s.state.players.find((p) => p.name === 'Alice').status === 'out', 'out status');
    assert.equal(b.s.state.phase, 'round');
    assert.ok(!JSON.stringify(b.s.state).includes(wrong.join('')));
    assert.equal((await call(a.s, 'submit', { cards: ctx.solution() })).code, 'locked');
  });

  test('a locked-out player cannot get a second guess by refreshing', async () => {
    const a = await player('Alice');
    await player('Bob');
    await call(a.s, 'start');
    await call(a.s, 'submit', { cards: ctx.wrongAnswer() });
    a.s.disconnect();

    const { s, res } = await refresh(a.token);
    assert.equal(res.you.name, 'Alice');
    assert.equal(s.state.you.status, 'out');
    assert.equal(s.state.phase, 'round');
    assert.equal((await call(s, 'submit', { cards: ctx.solution() })).code, 'locked');
  });

  test('refresh restores username, score, and round status', async () => {
    const a = await player('Alice');
    await call(a.s, 'start');
    await call(a.s, 'submit', { cards: ctx.solution() });
    await call(a.s, 'start');
    a.s.disconnect();
    await until(() => !ctx.room.players.get(a.id).connected, 'disconnect');

    const { s } = await refresh(a.token);
    assert.equal(s.state.you.name, 'Alice');
    assert.equal(s.state.you.score, 1);
    assert.equal(s.state.you.status, 'playing');
  });

  test('everyone wrong: everyone loses and the solution is revealed', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    await call(a.s, 'submit', { cards: ctx.wrongAnswer() });
    assert.equal(ctx.room.phase, 'round');
    await call(b.s, 'submit', { cards: ctx.wrongAnswer() });

    await until(() => a.s.state.lastResult?.outcome === 'all-wrong', 'all-wrong');
    assert.deepEqual(a.s.state.lastResult.solution, ctx.solution());
    assert.ok(a.s.state.players.every((p) => p.score === 0));
  });

  test('disconnected players are not waited for (after a short grace period)', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    b.s.disconnect();
    await until(() => !ctx.room.players.get(b.id).connected, 'Bob disconnected');

    await call(a.s, 'submit', { cards: ctx.wrongAnswer() });
    assert.equal(ctx.room.phase, 'round', 'a quick refresh should not end the round');

    ctx.clock.t += 11_000;
    ctx.room.tick();
    await until(() => a.s.state.lastResult?.outcome === 'all-wrong', 'all-wrong after grace');
  });

  test('mid-round join is a spectator until the next round', async () => {
    const a = await player('Alice');
    await call(a.s, 'start');
    const c = await player('Carol');
    assert.equal(c.s.state.you.status, 'spectating');
    assert.equal(c.s.state.phase, 'round');
    assert.equal(c.s.state.round.board.length, 26);
    assert.equal((await call(c.s, 'submit', { cards: ctx.solution() })).code, 'spectator');

    // Alice guessing wrong ends the round: Carol (spectator) is not counted.
    await call(a.s, 'submit', { cards: ctx.wrongAnswer() });
    await until(() => c.s.state.lastResult?.outcome === 'all-wrong', 'all-wrong');

    await call(c.s, 'start');
    await until(() => c.s.state.phase === 'round', 'next round');
    assert.equal(c.s.state.you.status, 'playing');
  });

  test('9th visitor sees room full and can spectate', async () => {
    for (let i = 1; i <= 8; i++) await player(`P${i}`);
    const ninth = client();
    await call(ninth, 'hello', {});
    const res = await call(ninth, 'join', { name: 'Nine' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'full');

    await until(() => ninth.state?.players.length === 8, 'spectator state');
    assert.equal(ninth.state.you, null);
    assert.ok(ninth.state.watchers >= 1);
    assert.equal((await call(ninth, 'start')).code, 'not-player');
    assert.equal((await call(ninth, 'submit', { cards: ['A', 'B', 'C', 'D'] })).code, 'not-player');
  });

  test('submission validation', async () => {
    const a = await player('Alice');
    assert.equal((await call(a.s, 'submit', { cards: ['A', 'B', 'C', 'D'] })).code, 'no-round');
    await call(a.s, 'start');
    for (const cards of [
      ['A', 'B', 'C'],
      ['A', 'B', 'C', 'D', 'E'],
      ['A', 'A', 'B', 'C'],
      ['A', 'B', 'C', '1'],
      ['a', 'b', 'c', 'd'],
      'ABCD',
      null,
      [1, 2, 3, 4],
    ]) {
      const res = await call(a.s, 'submit', { cards });
      assert.equal(res.code, 'bad-cards', `cards=${JSON.stringify(cards)}`);
    }
    assert.equal(ctx.room.phase, 'round', 'invalid submissions do not use up the guess');
    assert.equal(a.s.state.you.status, 'playing');
  });

  test('end round and reveal', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    assert.equal((await call(b.s, 'endRound')).ok, true);
    await until(() => a.s.state.lastResult?.outcome === 'ended', 'ended');
    assert.equal(a.s.state.lastResult.endedByName, 'Bob');
    assert.deepEqual(a.s.state.lastResult.solution, ctx.solution());
  });

  test('reset game: scores to 0, round count restarts, back to the lobby', async () => {
    const a = await player('Alice');
    await call(a.s, 'start');
    await call(a.s, 'submit', { cards: ctx.solution() });
    await until(() => a.s.state.you.score === 1 && a.s.state.lastResult, 'score');

    assert.equal((await call(a.s, 'resetGame')).ok, true);
    await until(() => a.s.state.you.score === 0, 'reset');
    assert.equal(a.s.state.lastResult, null, 'lobby, not the last results');
    assert.equal(a.s.state.you.lastGuess, null);

    await call(a.s, 'start');
    await until(() => a.s.state.phase === 'round', 'round');
    assert.equal(a.s.state.round.number, 1);
    assert.equal((await call(a.s, 'resetGame')).code, 'in-round');
  });

  test('a wrong guess is checked rule by rule, shown only to that player', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    await call(a.s, 'start');
    const wrong = ctx.wrongAnswer();
    await call(a.s, 'submit', { cards: wrong });

    await until(() => a.s.state.you.guess, 'guess analysis');
    const g = a.s.state.you.guess;
    assert.deepEqual(g.cards, [...wrong].sort());
    assert.equal(g.rules.length, a.s.state.round.rules.length);
    assert.ok(g.rules.some((r) => !r.ok), 'at least one rule is broken');
    assert.ok(g.rules.every((r) => r.text && r.detail));
    assert.ok(!JSON.stringify(a.s.state).includes('solution'), 'still no solution during the round');

    // Bob sees neither Alice's cards nor her analysis
    await until(() => b.s.state.players.find((p) => p.name === 'Alice').status === 'out', 'out');
    assert.equal(b.s.state.you.guess, null);
    assert.ok(!JSON.stringify(b.s.state).includes('"guess":{'));

    // Survives a refresh
    a.s.disconnect();
    const { s } = await refresh(a.token);
    assert.deepEqual(s.state.you.guess, g);

    // After the round: Alice can compare, Bob (who never guessed wrong) has nothing to compare
    await call(b.s, 'submit', { cards: ctx.solution() });
    await until(() => s.state.lastResult?.outcome === 'solved', 'solved');
    assert.deepEqual(s.state.you.lastGuess, g);
    assert.equal(s.state.you.guess, null);
    await until(() => b.s.state.lastResult, 'Bob result');
    assert.equal(b.s.state.you.lastGuess, null);
  });

  test('opening a second tab with the same stored ID does not hijack the first', async () => {
    const a = await player('Alice');
    const second = client();
    const res = await call(second, 'hello', { token: a.token, takeover: false });
    assert.equal(res.you, null);
    assert.equal(res.code, 'in-use');
    assert.equal(res.name, 'Alice');

    // Choosing "play here" explicitly takes over; the old tab is told.
    let replaced = false;
    a.s.on('replaced', () => (replaced = true));
    const res2 = await call(second, 'hello', { token: a.token, takeover: true });
    assert.equal(res2.you.name, 'Alice');
    await until(() => replaced, 'replaced event');
  });

  test('players disconnected for a few minutes are removed from the lobby', async () => {
    const a = await player('Alice');
    const b = await player('Bob');
    b.s.disconnect();
    await until(() => a.s.state.players.find((p) => p.name === 'Bob')?.connected === false, 'Bob offline');
    ctx.clock.t += 60_000;
    ctx.room.tick();
    assert.equal(ctx.room.players.size, 2);
    ctx.clock.t += 130_000;
    ctx.room.tick();
    await until(() => a.s.state.players.length === 1, 'Bob removed');

    const back = client();
    const res = await call(back, 'hello', { token: b.token, takeover: true });
    assert.equal(res.you, null, 'removed player has to join again');
  });
});

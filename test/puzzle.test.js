import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS,
  SHAPES,
  LETTERS,
  COMBOS,
  COMBO_COUNT,
  MIN_SINGLE,
  mulberry32,
  generateBoard,
  generatePuzzle,
  evaluateRule,
  describeRule,
  explainRule,
  extremeValue,
  findSolutions,
  countMatches,
  ruleFamily,
  tally,
} from '../src/puzzle.js';

// A fixed board for hand-checked evaluator tests.
// Colors cycle Y G B P W, shapes cycle D S T C R (R = star) with an offset of 1.
function fixedBoard() {
  return LETTERS.map((letter, i) => ({
    letter,
    number: i + 1,
    color: COLORS[i % 5],
    shape: SHAPES[(i + 1) % 5],
  }));
}
// A=yellow square, B=green triangle, C=blue circle, D=purple star, E=white diamond,
// F=yellow square, G=green triangle, ...

const board = fixedBoard();
const ev = (rule, cards) => evaluateRule(rule, board, cards);

test('there are exactly 14,950 four-card combinations, each ascending', () => {
  assert.equal(COMBO_COUNT, 14950);
  assert.equal(COMBOS.length, 14950);
  for (const c of COMBOS) assert.ok(c[0] < c[1] && c[1] < c[2] && c[2] < c[3]);
});

test('board: letters and numbers are fixed, colors and shapes valid', () => {
  const b = generateBoard(mulberry32(1));
  assert.equal(b.length, 26);
  b.forEach((card, i) => {
    assert.equal(card.letter, LETTERS[i]);
    assert.equal(card.number, i + 1);
    assert.ok(COLORS.includes(card.color));
    assert.ok(SHAPES.includes(card.shape));
  });
});

test('cards are read in alphabetical order regardless of input order', () => {
  const rule = { type: 'position', pos: 0, cmp: 'before', letter: 3 }; // first card before D
  assert.equal(ev(rule, ['Z', 'C', 'M', 'Q']), true);
  assert.equal(ev(rule, ['Z', 'E', 'M', 'Q']), false);
});

test('sum rules', () => {
  // A+B+C+D = 1+2+3+4 = 10
  assert.equal(ev({ type: 'sum', op: 'eq', n: 10 }, ['A', 'B', 'C', 'D']), true);
  assert.equal(ev({ type: 'sum', op: 'le', n: 10 }, ['A', 'B', 'C', 'D']), true);
  assert.equal(ev({ type: 'sum', op: 'le', n: 9 }, ['A', 'B', 'C', 'D']), false);
  assert.equal(ev({ type: 'sum', op: 'ge', n: 11 }, ['A', 'B', 'C', 'D']), false);
  assert.equal(describeRule({ type: 'sum', op: 'le', n: 40 }), 'The four numbers add up to at most 40.');
});

test('variety rules (different colors / shapes, shared)', () => {
  // A, F, K, P are all yellow squares
  assert.equal(ev({ type: 'variety', attr: 'color', op: 'eq', k: 1 }, ['A', 'F', 'K', 'P']), true);
  assert.equal(ev({ type: 'variety', attr: 'shape', op: 'eq', k: 1 }, ['A', 'F', 'K', 'P']), true);
  // A, B, C, D: four different colors
  assert.equal(ev({ type: 'variety', attr: 'color', op: 'eq', k: 4 }, ['A', 'B', 'C', 'D']), true);
  assert.equal(ev({ type: 'variety', attr: 'color', op: 'le', k: 3 }, ['A', 'B', 'C', 'D']), false);
  // A, F, B, C: yellow, yellow, green, blue -> 3 colors, two share a color
  assert.equal(ev({ type: 'variety', attr: 'color', op: 'eq', k: 3 }, ['A', 'B', 'C', 'F']), true);
  assert.equal(ev({ type: 'variety', attr: 'color', op: 'le', k: 3 }, ['A', 'B', 'C', 'F']), true);
  assert.equal(describeRule({ type: 'variety', attr: 'color', op: 'le', k: 3 }), 'At least two of the cards share a color.');
  assert.equal(describeRule({ type: 'variety', attr: 'shape', op: 'eq', k: 4 }), 'All four cards are different shapes.');
});

test('pair rules use the Nth and Mth card in alphabetical order', () => {
  // Cards C(3), H(8), J(10), T(20): second + fourth = 28, fourth - second = 12
  const cards = ['T', 'C', 'J', 'H'];
  assert.equal(ev({ type: 'pair', calc: 'sum', i: 1, j: 3, op: 'eq', x: 28 }, cards), true);
  assert.equal(ev({ type: 'pair', calc: 'sum', i: 1, j: 3, op: 'ge', x: 29 }, cards), false);
  assert.equal(ev({ type: 'pair', calc: 'diff', i: 1, j: 3, op: 'eq', x: 12 }, cards), true);
  assert.equal(ev({ type: 'pair', calc: 'diff', i: 0, j: 1, op: 'le', x: 5 }, cards), true);
  assert.equal(ev({ type: 'pair', calc: 'diff', i: 0, j: 1, op: 'le', x: 4 }, cards), false);
});

test('range rule', () => {
  assert.equal(ev({ type: 'range', op: 'eq', x: 17 }, ['C', 'H', 'J', 'T']), true);
  assert.equal(ev({ type: 'range', op: 'le', x: 16 }, ['C', 'H', 'J', 'T']), false);
});

test('extreme rule: most/least common color or shape, ties are never satisfied', () => {
  // Fixed board: colors Y,G,B,P,W repeat; A..Z = 26 cards -> yellow gets 6 (A,F,K,P,U,Z), others 5.
  assert.equal(extremeValue(board, 'color', 'most'), 'yellow');
  assert.equal(extremeValue(board, 'color', 'least'), null); // four-way tie at 5
  const most = { type: 'extreme', which: 'largest', attr: 'color', mode: 'most' };
  assert.equal(ev(most, ['A', 'B', 'C', 'Z']), true); // Z is yellow
  assert.equal(ev(most, ['A', 'B', 'C', 'Y']), false); // Y is white
  const least = { type: 'extreme', which: 'smallest', attr: 'color', mode: 'least' };
  for (const c of [['A', 'B', 'C', 'D'], ['B', 'C', 'D', 'E'], ['C', 'D', 'E', 'F']]) assert.equal(ev(least, c), false);
});

test('count rules: exactly K / none', () => {
  // A, B, F, K: yellow, green, yellow, yellow
  assert.equal(ev({ type: 'count', attr: 'color', value: 'yellow', k: 3 }, ['A', 'B', 'F', 'K']), true);
  assert.equal(ev({ type: 'count', attr: 'color', value: 'blue', k: 0 }, ['A', 'B', 'F', 'K']), true);
  assert.equal(ev({ type: 'count', attr: 'shape', value: 'triangle', k: 1 }, ['A', 'B', 'F', 'K']), true);
  assert.equal(describeRule({ type: 'count', attr: 'color', value: 'blue', k: 0 }), 'No card is blue.');
  assert.equal(describeRule({ type: 'count', attr: 'shape', value: 'star', k: 2 }), 'Exactly 2 cards are stars.');
  assert.equal(describeRule({ type: 'count', attr: 'shape', value: 'star', k: 1 }), 'Exactly 1 card is a star.');
});

test('number kind rules: even / odd / prime / multiples of 3', () => {
  // 2, 3, 9, 12
  const cards = ['B', 'C', 'I', 'L'];
  assert.equal(ev({ type: 'numkind', kind: 'even', k: 2 }, cards), true);
  assert.equal(ev({ type: 'numkind', kind: 'odd', k: 2 }, cards), true);
  assert.equal(ev({ type: 'numkind', kind: 'prime', k: 2 }, cards), true); // 2, 3
  assert.equal(ev({ type: 'numkind', kind: 'mult3', k: 3 }, cards), true); // 3, 9, 12
  assert.equal(ev({ type: 'numkind', kind: 'prime', k: 1 }, ['A', 'D', 'F', 'H']), false); // 1 is not prime
  assert.equal(ev({ type: 'numkind', kind: 'prime', k: 0 }, ['A', 'D', 'F', 'H']), true);
});

test('adjacent rules', () => {
  assert.equal(ev({ type: 'adjacent', mode: 'none' }, ['A', 'C', 'E', 'G']), true);
  assert.equal(ev({ type: 'adjacent', mode: 'exactly1' }, ['A', 'B', 'E', 'G']), true);
  assert.equal(ev({ type: 'adjacent', mode: 'exactly1' }, ['A', 'B', 'C', 'G']), false); // A-B and B-C
  assert.equal(ev({ type: 'adjacent', mode: 'atleast2' }, ['A', 'B', 'C', 'G']), true);
  assert.equal(ev({ type: 'adjacent', mode: 'atleast1' }, ['A', 'C', 'E', 'G']), false);
});

test('position and nth rules', () => {
  assert.equal(ev({ type: 'position', pos: 3, cmp: 'after', letter: 18 }, ['A', 'B', 'C', 'T']), true); // T after S
  assert.equal(ev({ type: 'position', pos: 3, cmp: 'after', letter: 19 }, ['A', 'B', 'C', 'T']), false); // T not after T
  assert.equal(ev({ type: 'nth', pos: 1, attr: 'shape', value: 'triangle' }, ['A', 'B', 'C', 'D']), true);
  assert.equal(ev({ type: 'nth', pos: 2, attr: 'color', value: 'blue' }, ['A', 'B', 'C', 'D']), true);
  assert.equal(describeRule({ type: 'position', pos: 0, cmp: 'before', letter: 7 }), 'The first card comes before the letter H.');
  assert.equal(describeRule({ type: 'nth', pos: 1, attr: 'shape', value: 'star' }), 'The second card is a star.');
});

test('explainRule produces readable working', () => {
  assert.equal(explainRule({ type: 'sum', op: 'eq', n: 10 }, board, ['D', 'C', 'B', 'A']), '1 + 2 + 3 + 4 = 10');
  assert.equal(explainRule({ type: 'adjacent', mode: 'atleast1' }, board, ['A', 'B', 'E', 'G']), 'Adjacent pairs: A–B');
});

test('generator: 500 puzzles, each with exactly one solution and good-quality rules', () => {
  const rng = mulberry32(20261124);
  for (let n = 0; n < 500; n++) {
    const { board: b, rules, solution } = generatePuzzle({ rng });
    const tag = `puzzle #${n}`;

    // 5 or 6 rules, all from different families, all with English text
    assert.ok(rules.length === 5 || rules.length === 6, `${tag}: rule count ${rules.length}`);
    const families = rules.map(ruleFamily);
    assert.equal(new Set(families).size, rules.length, `${tag}: repeated family ${families}`);
    for (const r of rules) assert.equal(r.text, describeRule(r));

    // Exactly one solution, and it is the hidden one (independent brute force)
    const sols = findSolutions(b, rules);
    assert.equal(sols.length, 1, `${tag}: ${sols.length} solutions`);
    assert.deepEqual(sols[0], solution, `${tag}: wrong solution`);

    // Every rule is necessary: dropping any one leaves more than one solution
    for (let i = 0; i < rules.length; i++) {
      const rest = rules.filter((_, j) => j !== i);
      assert.ok(findSolutions(b, rest).length > 1, `${tag}: rule "${rules[i].text}" is redundant`);
    }

    // No single rule nearly gives the answer away
    for (const r of rules) assert.ok(countMatches(r, b) >= MIN_SINGLE, `${tag}: "${r.text}" too strong alone`);

    // Most/least common rules are never used when the board has a tie
    for (const r of rules.filter((x) => x.type === 'extreme')) {
      assert.notEqual(extremeValue(b, r.attr, r.mode), null, `${tag}: tie for ${r.mode} common ${r.attr}`);
      const counts = Object.values(tally(b, r.attr));
      const target = r.mode === 'most' ? Math.max(...counts) : Math.min(...counts);
      assert.equal(counts.filter((c) => c === target).length, 1);
    }
  }
});

test('generator is deterministic for a given seed', () => {
  const a = generatePuzzle({ rng: mulberry32(42) });
  const b = generatePuzzle({ rng: mulberry32(42) });
  assert.deepEqual(a, b);
});

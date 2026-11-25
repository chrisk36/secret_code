// Secret Code puzzle engine.
//
// Pure module: no I/O, no timers, no globals that change. Everything random takes an
// injectable `rng` (a function returning a float in [0, 1)) so tests can be deterministic.
//
// Terminology
//   board    – array of 26 cards, index 0..25 = A..Z. card = { letter, number, color, shape }
//   combo    – 4 card indices in ascending order, e.g. [0, 4, 9, 20] = A, E, J, U.
//              "first card" = combo[0], "second card" = combo[1], and so on.
//   rule     – plain data object, e.g. { type: 'sum', op: 'le', n: 40 }.
//              compileRule(rule, board) turns it into a fast predicate over combos.

export const COLORS = ['yellow', 'green', 'blue', 'purple', 'white'];
export const SHAPES = ['diamond', 'square', 'triangle', 'circle', 'star'];
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export const ORDINALS = ['first', 'second', 'third', 'fourth'];
export const PRIMES = new Set([2, 3, 5, 7, 11, 13, 17, 19, 23]);

const SHAPE_PLURAL = {
  diamond: 'diamonds',
  square: 'squares',
  triangle: 'triangles',
  circle: 'circles',
  star: 'stars',
};

// Quality thresholds (measured in number of 4-card combinations out of 14,950).
// A rule that on its own leaves fewer than MIN_SINGLE combos "nearly gives the answer away";
// a rule that leaves more than MAX_SINGLE barely says anything.
export const MIN_SINGLE = 150; // ~1% of all combinations
export const MAX_SINGLE = 12700; // ~85% of all combinations
const PER_FAMILY_CAP = 3; // candidate rules considered per family per attempt

// ---------------------------------------------------------------------------
// Combinations
// ---------------------------------------------------------------------------

export const COMBOS = (() => {
  const out = [];
  for (let a = 0; a < 26; a++)
    for (let b = a + 1; b < 26; b++)
      for (let c = b + 1; c < 26; c++)
        for (let d = c + 1; d < 26; d++) out.push([a, b, c, d]);
  return out;
})();
export const COMBO_COUNT = COMBOS.length; // 14,950

// ---------------------------------------------------------------------------
// Randomness helpers
// ---------------------------------------------------------------------------

/** Small seeded PRNG for reproducible tests. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Up to `n` distinct integers drawn from [lo, hi]. */
function sampleRange(rng, lo, hi, n) {
  if (hi < lo) return [];
  const all = [];
  for (let v = lo; v <= hi; v++) all.push(v);
  return shuffle(rng, all).slice(0, n);
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * Random board. Letters and numbers are fixed (A=1 ... Z=26); colors and shapes are random.
 * Every color and every shape appears at least twice so "most/least common" rules and
 * "no card is X" rules stay meaningful.
 */
export function generateBoard(rng = Math.random) {
  for (;;) {
    const board = LETTERS.map((letter, i) => ({
      letter,
      number: i + 1,
      color: pick(rng, COLORS),
      shape: pick(rng, SHAPES),
    }));
    const cc = tally(board, 'color');
    const sc = tally(board, 'shape');
    if (COLORS.every((c) => cc[c] >= 2) && SHAPES.every((s) => sc[s] >= 2)) return board;
  }
}

/** Count how many of the 26 cards have each color (attr='color') or shape (attr='shape'). */
export function tally(board, attr) {
  const values = attr === 'color' ? COLORS : SHAPES;
  const counts = Object.fromEntries(values.map((v) => [v, 0]));
  for (const card of board) counts[card[attr]]++;
  return counts;
}

/**
 * The single most (mode='most') or least (mode='least') common color/shape on the board,
 * or null if there is a tie. Rules that depend on this are never used when it is null.
 */
export function extremeValue(board, attr, mode) {
  const entries = Object.entries(tally(board, attr));
  const counts = entries.map(([, c]) => c);
  const target = mode === 'most' ? Math.max(...counts) : Math.min(...counts);
  const winners = entries.filter(([, c]) => c === target);
  return winners.length === 1 ? winners[0][0] : null;
}

// ---------------------------------------------------------------------------
// Rules: families, text, evaluation, explanation
// ---------------------------------------------------------------------------
//
// Rule shapes (all positions are 0-based: 0 = first card ... 3 = fourth card):
//   { type: 'sum',      op: 'le'|'ge'|'eq', n }                    sum of the four numbers
//   { type: 'variety',  attr: 'color'|'shape', op: 'eq'|'le', k }  number of different colors/shapes
//   { type: 'pair',     calc: 'sum'|'diff', i, j, op, x }          two cards' numbers (i < j)
//   { type: 'range',    op, x }                                    largest minus smallest number
//   { type: 'extreme',  which: 'largest'|'smallest', attr, mode: 'most'|'least' }
//   { type: 'count',    attr, value, k }                           exactly k cards have color/shape value
//   { type: 'numkind',  kind: 'even'|'odd'|'prime'|'mult3', k }    exactly k numbers are of that kind
//   { type: 'adjacent', mode: 'none'|'exactly1'|'atleast1'|'atleast2' }
//   { type: 'position', pos, cmp: 'before'|'after', letter }       letter = index 0..25
//   { type: 'nth',      pos, attr, value }                          the Nth card is a shape / color

export function ruleFamily(rule) {
  switch (rule.type) {
    case 'sum':
      return 'sum';
    case 'variety':
      return `variety-${rule.attr}`;
    case 'pair':
      return 'pair';
    case 'range':
      return 'range';
    case 'extreme':
      return 'extreme';
    case 'count':
      return `count-${rule.attr}`;
    case 'numkind':
      return rule.kind === 'even' || rule.kind === 'odd' ? 'parity' : rule.kind;
    case 'adjacent':
      return 'adjacent';
    case 'position':
      return 'position';
    case 'nth':
      return 'nth';
    default:
      throw new Error(`Unknown rule type: ${rule.type}`);
  }
}

const OP_WORD = { le: 'at most', ge: 'at least', eq: 'exactly' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const plural = (k, one, many) => (k === 1 ? one : many);

function kindPhrase(kind, k) {
  switch (kind) {
    case 'even':
      return 'even';
    case 'odd':
      return 'odd';
    case 'prime':
      return 'prime';
    case 'mult3':
      return plural(k, 'a multiple of 3', 'multiples of 3');
    default:
      throw new Error(`Unknown kind: ${kind}`);
  }
}

/** English text for a rule. */
export function describeRule(rule) {
  switch (rule.type) {
    case 'sum':
      return `The four numbers add up to ${OP_WORD[rule.op]} ${rule.n}.`;

    case 'variety': {
      const noun = rule.attr === 'color' ? 'color' : 'shape';
      if (rule.op === 'le' && rule.k === 3) return `At least two of the cards share a ${noun}.`;
      if (rule.op === 'le') return `The cards show at most ${rule.k} different ${noun}s.`;
      if (rule.k === 1) return `All four cards are the same ${noun}.`;
      if (rule.k === 4) return `All four cards are different ${noun}s.`;
      return `The cards show exactly ${rule.k} different ${noun}s.`;
    }

    case 'pair': {
      const a = ORDINALS[rule.i];
      const b = ORDINALS[rule.j];
      if (rule.calc === 'sum')
        return `The numbers on the ${a} and ${b} cards add up to ${OP_WORD[rule.op]} ${rule.x}.`;
      return `The difference between the numbers on the ${a} and ${b} cards is ${OP_WORD[rule.op]} ${rule.x}.`;
    }

    case 'range':
      return `The difference between the largest and smallest numbers is ${OP_WORD[rule.op]} ${rule.x}.`;

    case 'extreme':
      return `The card with the ${rule.which} number has the ${rule.mode} common ${rule.attr} among all 26 cards.`;

    case 'count': {
      const { k, value } = rule;
      if (rule.attr === 'color') {
        if (k === 0) return `No card is ${value}.`;
        return `Exactly ${k} ${plural(k, 'card is', 'cards are')} ${value}.`;
      }
      if (k === 0) return `No card is a ${value}.`;
      if (k === 1) return `Exactly 1 card is a ${value}.`;
      return `Exactly ${k} cards are ${SHAPE_PLURAL[value]}.`;
    }

    case 'numkind': {
      const { k, kind } = rule;
      if (k === 0) return `None of the four numbers is ${kindPhrase(kind, 1)}.`;
      if (k === 4) return `All four numbers are ${kindPhrase(kind, 4)}.`;
      return `Exactly ${k} of the numbers ${plural(k, 'is', 'are')} ${kindPhrase(kind, k)}.`;
    }

    case 'adjacent':
      switch (rule.mode) {
        case 'none':
          return 'No two of the cards are adjacent letters (like C and D).';
        case 'exactly1':
          return 'Exactly one pair of the cards are adjacent letters (like C and D).';
        case 'atleast1':
          return 'At least one pair of the cards are adjacent letters (like C and D).';
        case 'atleast2':
          return 'At least two pairs of the cards are adjacent letters (like C and D).';
        default:
          throw new Error(`Unknown adjacent mode: ${rule.mode}`);
      }

    case 'position':
      return `The ${ORDINALS[rule.pos]} card comes ${rule.cmp} the letter ${LETTERS[rule.letter]}.`;

    case 'nth':
      if (rule.attr === 'color') return `The ${ORDINALS[rule.pos]} card is ${rule.value}.`;
      return `The ${ORDINALS[rule.pos]} card is a ${rule.value}.`;

    default:
      throw new Error(`Unknown rule type: ${rule.type}`);
  }
}

const compare = (op, v, x) => (op === 'le' ? v <= x : op === 'ge' ? v >= x : v === x);

function isKind(kind, n) {
  switch (kind) {
    case 'even':
      return n % 2 === 0;
    case 'odd':
      return n % 2 === 1;
    case 'prime':
      return PRIMES.has(n);
    case 'mult3':
      return n % 3 === 0;
    default:
      throw new Error(`Unknown kind: ${kind}`);
  }
}

function adjacentPairs(c) {
  return (c[1] - c[0] === 1) + (c[2] - c[1] === 1) + (c[3] - c[2] === 1);
}

/**
 * Turn a rule into a fast predicate `(combo) => boolean` for a given board.
 * `combo` must be 4 ascending card indices.
 */
export function compileRule(rule, board) {
  const attrIndex = (attr) => {
    const values = attr === 'color' ? COLORS : SHAPES;
    return board.map((card) => values.indexOf(card[attr]));
  };

  switch (rule.type) {
    case 'sum': {
      const { op, n } = rule;
      return (c) => compare(op, c[0] + c[1] + c[2] + c[3] + 4, n);
    }

    case 'variety': {
      const idx = attrIndex(rule.attr);
      const { op, k } = rule;
      return (c) => {
        const mask = (1 << idx[c[0]]) | (1 << idx[c[1]]) | (1 << idx[c[2]]) | (1 << idx[c[3]]);
        let distinct = 0;
        for (let m = mask; m; m &= m - 1) distinct++;
        return compare(op, distinct, k);
      };
    }

    case 'pair': {
      const { calc, i, j, op, x } = rule;
      if (calc === 'sum') return (c) => compare(op, c[i] + c[j] + 2, x);
      return (c) => compare(op, c[j] - c[i], x);
    }

    case 'range': {
      const { op, x } = rule;
      return (c) => compare(op, c[3] - c[0], x);
    }

    case 'extreme': {
      const target = extremeValue(board, rule.attr, rule.mode);
      if (target === null) return () => false; // ambiguous on this board: never satisfied
      const pos = rule.which === 'largest' ? 3 : 0;
      const attr = rule.attr;
      return (c) => board[c[pos]][attr] === target;
    }

    case 'count': {
      const { attr, value, k } = rule;
      const has = board.map((card) => (card[attr] === value ? 1 : 0));
      return (c) => has[c[0]] + has[c[1]] + has[c[2]] + has[c[3]] === k;
    }

    case 'numkind': {
      const has = board.map((card) => (isKind(rule.kind, card.number) ? 1 : 0));
      const { k } = rule;
      return (c) => has[c[0]] + has[c[1]] + has[c[2]] + has[c[3]] === k;
    }

    case 'adjacent': {
      switch (rule.mode) {
        case 'none':
          return (c) => adjacentPairs(c) === 0;
        case 'exactly1':
          return (c) => adjacentPairs(c) === 1;
        case 'atleast1':
          return (c) => adjacentPairs(c) >= 1;
        case 'atleast2':
          return (c) => adjacentPairs(c) >= 2;
        default:
          throw new Error(`Unknown adjacent mode: ${rule.mode}`);
      }
    }

    case 'position': {
      const { pos, cmp, letter } = rule;
      return cmp === 'before' ? (c) => c[pos] < letter : (c) => c[pos] > letter;
    }

    case 'nth': {
      const { pos, attr, value } = rule;
      return (c) => board[c[pos]][attr] === value;
    }

    default:
      throw new Error(`Unknown rule type: ${rule.type}`);
  }
}

/** Normalise any 4 card indices or letters into an ascending index combo. */
export function toCombo(cards) {
  return cards
    .map((x) => (typeof x === 'string' ? LETTERS.indexOf(x.toUpperCase()) : x))
    .sort((a, b) => a - b);
}

/** Does this set of 4 cards (indices or letters, any order) satisfy the rule? */
export function evaluateRule(rule, board, cards) {
  return compileRule(rule, board)(toCombo(cards));
}

/** Brute force: every 4-card combination that satisfies all rules. */
export function findSolutions(board, rules) {
  const preds = rules.map((r) => compileRule(r, board));
  const out = [];
  for (const c of COMBOS) if (preds.every((p) => p(c))) out.push(c);
  return out;
}

/** Number of combinations satisfying a single rule. */
export function countMatches(rule, board) {
  const p = compileRule(rule, board);
  let n = 0;
  for (const c of COMBOS) if (p(c)) n++;
  return n;
}

/** Short human-readable working for the reveal screen, e.g. "3 + 8 + 14 + 20 = 45". */
export function explainRule(rule, board, cards) {
  const c = toCombo(cards);
  const cardsOf = c.map((i) => board[i]);
  const label = (card) => `${card.letter}(${card.number})`;

  switch (rule.type) {
    case 'sum':
      return `${cardsOf.map((x) => x.number).join(' + ')} = ${cardsOf.reduce((s, x) => s + x.number, 0)}`;

    case 'variety': {
      const vals = cardsOf.map((x) => x[rule.attr]);
      const n = new Set(vals).size;
      return `${vals.join(', ')} → ${n} different`;
    }

    case 'pair': {
      const a = cardsOf[rule.i];
      const b = cardsOf[rule.j];
      if (rule.calc === 'sum') return `${label(a)} + ${label(b)} = ${a.number + b.number}`;
      return `${label(b)} − ${label(a)} = ${b.number - a.number}`;
    }

    case 'range':
      return `${label(cardsOf[3])} − ${label(cardsOf[0])} = ${cardsOf[3].number - cardsOf[0].number}`;

    case 'extreme': {
      const target = extremeValue(board, rule.attr, rule.mode);
      const counts = tally(board, rule.attr);
      const card = cardsOf[rule.which === 'largest' ? 3 : 0];
      const article = rule.attr === 'shape' ? 'a ' : '';
      return `${rule.mode === 'most' ? 'Most' : 'Least'} common ${rule.attr}: ${target} (${counts[target]} cards). ${card.letter} is ${article}${card[rule.attr]}.`;
    }

    case 'count': {
      const hits = cardsOf.filter((x) => x[rule.attr] === rule.value).map((x) => x.letter);
      return hits.length ? `${cap(rule.value)}: ${hits.join(', ')}` : `No ${rule.value} cards`;
    }

    case 'numkind': {
      const name = { even: 'Even', odd: 'Odd', prime: 'Prime', mult3: 'Multiples of 3' }[rule.kind];
      const hits = cardsOf.filter((x) => isKind(rule.kind, x.number)).map((x) => x.number);
      return `${name}: ${hits.length ? hits.join(', ') : 'none'}`;
    }

    case 'adjacent': {
      const pairs = [];
      for (let i = 0; i < 3; i++)
        if (c[i + 1] - c[i] === 1) pairs.push(`${LETTERS[c[i]]}–${LETTERS[c[i + 1]]}`);
      return `Adjacent pairs: ${pairs.length ? pairs.join(', ') : 'none'}`;
    }

    case 'position':
      return `${cap(ORDINALS[rule.pos])} card: ${cardsOf[rule.pos].letter}`;

    case 'nth': {
      const card = cardsOf[rule.pos];
      return `${cap(ORDINALS[rule.pos])} card: ${card.letter}, ${card.color} ${card.shape}`;
    }

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Bitsets over the 14,950 combinations (fast intersections during generation)
// ---------------------------------------------------------------------------

const WORDS = Math.ceil(COMBO_COUNT / 32);

const FULL = (() => {
  const b = new Uint32Array(WORDS);
  for (let i = 0; i < COMBO_COUNT; i++) b[i >>> 5] |= 1 << (i & 31);
  return b;
})();

function bitsetOf(pred) {
  const b = new Uint32Array(WORDS);
  for (let i = 0; i < COMBO_COUNT; i++) if (pred(COMBOS[i])) b[i >>> 5] |= 1 << (i & 31);
  return b;
}

function popcount32(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

function count(b) {
  let n = 0;
  for (let i = 0; i < WORDS; i++) n += popcount32(b[i]);
  return n;
}

function andCount(a, b) {
  let n = 0;
  for (let i = 0; i < WORDS; i++) n += popcount32(a[i] & b[i]);
  return n;
}

function and(a, b) {
  const out = new Uint32Array(WORDS);
  for (let i = 0; i < WORDS; i++) out[i] = a[i] & b[i];
  return out;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * All candidate rules that the given solution satisfies, before quality filtering.
 * Threshold rules ("at most", "at least") are sampled near the solution's actual value.
 */
export function candidateRules(board, sol, rng = Math.random) {
  const nums = sol.map((i) => i + 1);
  const cards = sol.map((i) => board[i]);
  const out = [];

  // Sum of all four
  const S = nums.reduce((a, b) => a + b, 0);
  out.push({ type: 'sum', op: 'eq', n: S });
  for (const n of sampleRange(rng, S, Math.min(98, S + 25), 3)) out.push({ type: 'sum', op: 'le', n });
  for (const n of sampleRange(rng, Math.max(10, S - 25), S, 3)) out.push({ type: 'sum', op: 'ge', n });

  // Number of different colors / shapes
  for (const attr of ['color', 'shape']) {
    const d = new Set(cards.map((x) => x[attr])).size;
    out.push({ type: 'variety', attr, op: 'eq', k: d });
    if (d <= 3) out.push({ type: 'variety', attr, op: 'le', k: 3 });
    if (d <= 2) out.push({ type: 'variety', attr, op: 'le', k: 2 });
  }

  // Sum / difference of two specific cards
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const s = nums[i] + nums[j];
      out.push({ type: 'pair', calc: 'sum', i, j, op: 'eq', x: s });
      for (const x of sampleRange(rng, s, Math.min(51, s + 15), 2)) out.push({ type: 'pair', calc: 'sum', i, j, op: 'le', x });
      for (const x of sampleRange(rng, Math.max(3, s - 15), s, 2)) out.push({ type: 'pair', calc: 'sum', i, j, op: 'ge', x });
      if (i === 0 && j === 3) continue; // that is the "range" family
      const d = nums[j] - nums[i];
      out.push({ type: 'pair', calc: 'diff', i, j, op: 'eq', x: d });
      for (const x of sampleRange(rng, d, Math.min(23, d + 8), 2)) out.push({ type: 'pair', calc: 'diff', i, j, op: 'le', x });
      for (const x of sampleRange(rng, Math.max(1, d - 8), d, 2)) out.push({ type: 'pair', calc: 'diff', i, j, op: 'ge', x });
    }
  }

  // Largest minus smallest
  const R = nums[3] - nums[0];
  out.push({ type: 'range', op: 'eq', x: R });
  for (const x of sampleRange(rng, R, Math.min(25, R + 10), 2)) out.push({ type: 'range', op: 'le', x });
  for (const x of sampleRange(rng, Math.max(3, R - 10), R, 2)) out.push({ type: 'range', op: 'ge', x });

  // Largest/smallest card has the most/least common color/shape (only when there is no tie)
  for (const which of ['largest', 'smallest']) {
    for (const attr of ['color', 'shape']) {
      for (const mode of ['most', 'least']) {
        const target = extremeValue(board, attr, mode);
        const card = cards[which === 'largest' ? 3 : 0];
        if (target !== null && card[attr] === target) out.push({ type: 'extreme', which, attr, mode });
      }
    }
  }

  // Exactly K cards are [color] / [shape]  (K = 0 reads "No card is ...")
  for (const value of COLORS) out.push({ type: 'count', attr: 'color', value, k: cards.filter((x) => x.color === value).length });
  for (const value of SHAPES) out.push({ type: 'count', attr: 'shape', value, k: cards.filter((x) => x.shape === value).length });

  // Exactly K numbers are even / odd / prime / multiples of 3
  for (const kind of ['even', 'odd', 'prime', 'mult3'])
    out.push({ type: 'numkind', kind, k: nums.filter((n) => isKind(kind, n)).length });

  // Adjacent letters
  const adj = adjacentPairs(sol);
  if (adj === 0) out.push({ type: 'adjacent', mode: 'none' });
  if (adj === 1) out.push({ type: 'adjacent', mode: 'exactly1' });
  if (adj >= 1) out.push({ type: 'adjacent', mode: 'atleast1' });
  if (adj >= 2) out.push({ type: 'adjacent', mode: 'atleast2' });

  // The Nth card comes before / after letter X
  for (let pos = 0; pos < 4; pos++) {
    const idx = sol[pos];
    for (const letter of sampleRange(rng, idx + 1, Math.min(25, idx + 8), 2)) out.push({ type: 'position', pos, cmp: 'before', letter });
    for (const letter of sampleRange(rng, Math.max(0, idx - 8), idx - 1, 2)) out.push({ type: 'position', pos, cmp: 'after', letter });
  }

  // The Nth card is a [shape] / [color]
  for (let pos = 0; pos < 4; pos++) {
    out.push({ type: 'nth', pos, attr: 'shape', value: cards[pos].shape });
    out.push({ type: 'nth', pos, attr: 'color', value: cards[pos].color });
  }

  // Normalise and de-duplicate by text
  const seen = new Set();
  const unique = [];
  for (const rule of out) {
    const text = describeRule(rule);
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push({ ...rule, family: ruleFamily(rule), text });
  }
  return unique;
}

/** True if removing any single rule leaves more than one solution. */
function allNecessary(bitsets) {
  for (let skip = 0; skip < bitsets.length; skip++) {
    let cur = FULL;
    for (let i = 0; i < bitsets.length; i++) if (i !== skip) cur = and(cur, bitsets[i]);
    if (count(cur) <= 1) return false;
  }
  return true;
}

/**
 * Depth-first search for `ruleCount` rules from distinct families whose intersection is
 * exactly one combination and where every rule is necessary. Each step aims for a roughly
 * geometric shrink of the remaining combinations (14,950 → ... → 1), so no single rule
 * does all the work.
 */
function searchRules(cands, ruleCount, rng, nodeBudget = 400) {
  const targets = [];
  for (let k = 0; k <= ruleCount; k++) targets[k] = Math.pow(COMBO_COUNT, (ruleCount - k) / ruleCount);
  const BRANCH = 4;
  let nodes = 0;
  const chosen = [];
  const used = new Set();

  function dfs(depth, cur, curCount) {
    if (++nodes > nodeBudget) return null;

    if (depth === ruleCount - 1) {
      const finals = shuffle(
        rng,
        cands.filter((c) => !used.has(c.family) && andCount(cur, c.bits) === 1),
      );
      for (const f of finals) {
        const set = [...chosen, f];
        if (allNecessary(set.map((r) => r.bits))) return set;
      }
      return null;
    }

    const target = targets[depth + 1];
    const minLeft = ruleCount - depth; // leave room for the remaining rules to each cut something
    const opts = [];
    for (const c of cands) {
      if (used.has(c.family)) continue;
      const n = andCount(cur, c.bits);
      if (n >= curCount || n < minLeft) continue;
      opts.push({ c, n, score: Math.abs(Math.log(n / target)) + rng() * 0.6 });
    }
    opts.sort((a, b) => a.score - b.score);

    for (const o of opts.slice(0, BRANCH)) {
      chosen.push(o.c);
      used.add(o.c.family);
      const res = dfs(depth + 1, and(cur, o.c.bits), o.n);
      if (res) return res;
      chosen.pop();
      used.delete(o.c.family);
      if (nodes > nodeBudget) return null;
    }
    return null;
  }

  return dfs(0, FULL, COMBO_COUNT);
}

/**
 * Generate a puzzle: { board, rules, solution }.
 *   board    – 26 cards
 *   rules    – 5 or 6 rules, each { type, ...params, family, text }
 *   solution – ascending card indices of the unique answer
 *
 * Options: rng (default Math.random), ruleCount (5 or 6; random if omitted), maxAttempts.
 */
export function generatePuzzle({ rng = Math.random, ruleCount, maxAttempts = 500 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const board = generateBoard(rng);
    const solution = COMBOS[Math.floor(rng() * COMBO_COUNT)];
    const T = ruleCount ?? (rng() < 0.5 ? 5 : 6);

    // Quality filter, then cap each family's share so that families with many parameter
    // combinations (pair sums, "the Nth card is ...") don't crowd out the others.
    const byFamily = new Map();
    for (const rule of shuffle(rng, candidateRules(board, solution, rng))) {
      const list = byFamily.get(rule.family) ?? [];
      if (list.length >= PER_FAMILY_CAP) continue;
      const bits = bitsetOf(compileRule(rule, board));
      const n = count(bits);
      if (n < MIN_SINGLE || n > MAX_SINGLE) continue;
      list.push({ ...rule, bits, matches: n });
      byFamily.set(rule.family, list);
    }
    const cands = [...byFamily.values()].flat();

    const found = searchRules(cands, T, rng);
    if (!found) continue;

    const rules = shuffle(
      rng,
      found.map(({ bits, matches, ...rule }) => rule),
    );

    // Independent brute-force confirmation over all 14,950 combinations.
    const solutions = findSolutions(board, rules);
    if (solutions.length !== 1 || solutions[0].join() !== solution.join()) continue;

    return { board, rules, solution: [...solution] };
  }
  throw new Error('Could not generate a puzzle');
}

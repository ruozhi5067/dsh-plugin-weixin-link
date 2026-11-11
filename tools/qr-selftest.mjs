#!/usr/bin/env node
/**
 * qr-selftest.mjs — offline structural self-test for ../vendor/qrcode.js
 *
 * Why this exists
 * ---------------
 * The vendored library (qrcode-generator 1.4.4, MIT) is used to render the
 * WeChat QR-login URL. No QR *decoder* is available offline, so instead of
 * decoding the symbol back to text we verify structural invariants that any
 * spec-conformant QR symbol must satisfy. A wrong encoder (bad RS blocks, bad
 * mask, bad placement) breaks these invariants.
 *
 * Checks
 * ------
 *  (0) module exports a callable factory; documented API shape is present
 *  (1) the three finder patterns are the standard 7x7 pattern + light separator
 *  (2) matrix is square, side === 17 + 4 * version (version 1 -> 21)
 *  (3) timing patterns (row 6 / col 6) alternate correctly
 *  (4) same content at EC level L vs M -> different matrices, same size rule
 *  (5) longer content -> version number monotonic non-decreasing
 *  (6) format information: both copies agree, is a valid BCH(15,5) codeword
 *      under G15 = 0x537 with the G15_MASK = 0x5412 mask, and encodes the
 *      requested error-correction level; the fixed dark module is dark
 *
 * Usage:  node tools/qr-selftest.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, '..', 'vendor', 'qrcode.js');

/* ------------------------------------------------------------------ *
 * Loader
 * ------------------------------------------------------------------ */

const src = readFileSync(VENDOR, 'utf8');

/**
 * UMD/CommonJS-safe loader: evaluates the source inside a function scope that
 * fakes `module`/`exports`, so the UMD tail takes its CommonJS branch no matter
 * how the host resolves .js files. This is the path to use from ESM.
 */
function loadViaSandbox(code) {
  const module_ = { exports: {} };
  const fn = new Function('module', 'exports', 'require', code);
  fn(module_, module_.exports, undefined);
  return module_.exports;
}

let qrcode;
let loadMethod;
let requireWorked = false;
try {
  const require = createRequire(import.meta.url);
  qrcode = require(VENDOR);
  requireWorked = true;
  loadMethod = 'createRequire(import.meta.url)(vendor/qrcode.js)  [CommonJS/UMD branch]';
} catch (err) {
  qrcode = loadViaSandbox(src);
  loadMethod = `new Function("module","exports","require",src) sandbox  [require() failed: ${err.code || err.message}]`;
}

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${id} ${name}${detail ? '  -- ' + detail : ''}`);
  return !!ok;
}
function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const EC_INDICATOR = { L: 1, M: 0, Q: 3, H: 2 }; // 2-bit field of the format info
const G15 = 0x537;      // format-info generator polynomial
const G15_MASK = 0x5412;

function build(text, ecLevel, typeNumber = 0) {
  const qr = qrcode(typeNumber, ecLevel);
  qr.addData(text);
  qr.make();
  return qr;
}

function matrixOf(qr) {
  const n = qr.getModuleCount();
  const m = [];
  for (let r = 0; r < n; r++) {
    const row = new Array(n);
    for (let c = 0; c < n; c++) row[c] = qr.isDark(r, c) === true;
    m.push(row);
  }
  return m;
}

const versionOf = (qr) => (qr.getModuleCount() - 17) / 4;

/** 7x7 finder core: outer ring dark, inner 3x3 dark, inner ring light. */
function finderCoreOk(m, row0, col0) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const heart = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const want = ring || heart;
      if (m[row0 + r][col0 + c] !== want) return { ok: false, at: [row0 + r, col0 + c] };
    }
  }
  return { ok: true };
}

/** Spec requires a light separator around each finder pattern. */
function separatorOk(m, cells, n) {
  for (const [r, c] of cells) {
    if (r < 0 || c < 0 || r >= n || c >= n) continue;
    if (m[r][c] !== false) return { ok: false, at: [r, c] };
  }
  return { ok: true };
}

/** Rebuild the 15-bit format info from its two placements. */
function readFormatInfo(m, n) {
  let v = 0;
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 6) bit = m[i][8];
    else if (i < 8) bit = m[i + 1][8];
    else bit = m[n - 15 + i][8];
    if (bit) v |= 1 << i;
  }
  let h = 0;
  for (let i = 0; i < 15; i++) {
    let bit;
    if (i < 8) bit = m[8][n - i - 1];
    else if (i < 9) bit = m[8][15 - i];
    else bit = m[8][14 - i];
    if (bit) h |= 1 << i;
  }
  return { vertical: v, horizontal: h };
}

/** Independent BCH(15,5) remainder check: valid codeword <-> remainder 0. */
function bchRemainder15(v) {
  let d = v & 0x7fff;
  for (let i = 14; i >= 10; i--) {
    if ((d >>> i) & 1) d ^= G15 << (i - 10);
  }
  return d & 0x3ff;
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (a[r][c] !== b[r][c]) return [r, c];
  }
  return a.length === b.length ? null : [-1, -1];
}

/* ------------------------------------------------------------------ *
 * 0. module shape
 * ------------------------------------------------------------------ */

section('0. module load / API shape');
console.log(`  loaded via : ${loadMethod}`);
console.log(`  typeof export : ${typeof qrcode}`);
console.log(`  keys on export: ${Object.keys(qrcode).join(', ') || '(none)'}`);

if (!requireWorked) {
  const viaRequire = (() => {
    try { return createRequire(import.meta.url)(VENDOR); } catch { return null; }
  })();
  check('0.5', 'sandbox loader usable from ESM', typeof qrcode === 'function',
    viaRequire ? 'require() also works in this layout' : 'require() unavailable here -> sandbox loader is the ESM path');
} else {
  const viaSandbox = loadViaSandbox(src);
  check('0.5', 'sandbox loader agrees with require() loader', viaSandbox === qrcode || typeof viaSandbox === 'function',
    'both loaders yield the exported factory');
}

check('0.1', 'export is a callable factory (function)', typeof qrcode === 'function');
const probe = qrcode(0, 'M');
check('0.2', 'qrcode(typeNumber, ecLevel) returns an object', probe && typeof probe === 'object');
for (const fn of ['addData', 'make', 'getModuleCount', 'isDark']) {
  check('0.3.' + fn, `instance exposes ${fn}()`, typeof probe[fn] === 'function');
}
probe.addData('x');
probe.make();
check('0.4', 'addData -> make -> getModuleCount chain works',
  typeof probe.getModuleCount() === 'number' && probe.getModuleCount() > 0,
  `moduleCount=${probe.getModuleCount()}, isDark(0,0)=${probe.isDark(0, 0)}`);

/* ------------------------------------------------------------------ *
 * 1..3, 6 : invariants on the real payload
 * ------------------------------------------------------------------ */

const CONTENT = 'https://example.com/test?q=1';
section(`1-3,6. invariants for ${JSON.stringify(CONTENT)}`);

/** Build a fixture without letting a capacity error abort the whole suite. */
function safeBuild(text, ec, type = 0) {
  try {
    return { qr: build(text, ec, type), err: null };
  } catch (e) {
    return { qr: null, err: String(e) };
  }
}

const fixtures = [
  { tag: 'auto M', text: CONTENT, ec: 'M', type: 0 },
  { tag: 'auto L', text: CONTENT, ec: 'L', type: 0 },
  { tag: 'fixed v1 M', text: 'HELLO', ec: 'M', type: 1 },
  // version 7 at EC Q holds 86 byte-mode chars; keep the payload well inside that.
  { tag: 'fixed v7 Q', text: 'A'.repeat(60), ec: 'Q', type: 7 },
].map((spec) => ({ ...spec, ...safeBuild(spec.text, spec.ec, spec.type) }));

let allStructuralOk = true;

for (const fx of fixtures) {
  if (!fx.qr) {
    check(`build[${fx.tag}]`, `generate ${fx.ec} / typeNumber ${fx.type}`, false, `threw: ${fx.err}`);
    allStructuralOk = false;
    continue;
  }
  const n = fx.qr.getModuleCount();
  const m = matrixOf(fx.qr);
  const v = versionOf(fx.qr);
  console.log(`\n  -- fixture "${fx.tag}": moduleCount=${n}, version=${v}, ec=${fx.ec}`);

  // (2) square + size rule
  const square = m.every((row) => row.length === n);
  check(`2[${fx.tag}]`, `square matrix, n === 17 + 4*version (${n} === 17 + 4*${v})`,
    square && n === 17 + 4 * v, `n=${n}, v=${v}`);
  if (v === 1) {
    check(`2.1[${fx.tag}]`, 'version 1 -> moduleCount 21', n === 21, `n=${n}`);
  }

  // (1) finder patterns + separators
  const tl = finderCoreOk(m, 0, 0);
  const tr = finderCoreOk(m, 0, n - 7);
  const bl = finderCoreOk(m, n - 7, 0);
  check(`1[${fx.tag}]`, 'three 7x7 finder patterns at TL / TR / BL are standard',
    tl.ok && tr.ok && bl.ok,
    [tl, tr, bl].every((x) => x.ok) ? 'all three match ring+core 7x7' : JSON.stringify([tl, tr, bl]));

  const sep = separatorOk(m, [
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [[7, i], [i, 7]]),
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [[7, n - 1 - i], [i, n - 8]]),
    ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [[n - 8, i], [n - 1 - i, 7]]),
  ], n);
  check(`1.1[${fx.tag}]`, 'light separators around all three finders', sep.ok,
    sep.ok ? 'separator ring all light' : `leaked dark at ${JSON.stringify(sep.at)}`);

  // (3) timing patterns
  let timingAlt = true, timingBad = null;
  for (let c = 8; c <= n - 9; c++) {
    if (m[6][c] !== (c % 2 === 0)) { timingAlt = false; timingBad = [6, c]; break; }
  }
  if (timingAlt) {
    for (let r = 8; r <= n - 9; r++) {
      if (m[r][6] !== (r % 2 === 0)) { timingAlt = false; timingBad = [r, 6]; break; }
    }
  }
  let alternates = timingAlt;
  if (alternates) {
    for (let c = 8; c < n - 9; c++) if (m[6][c] === m[6][c + 1]) { alternates = false; timingBad = [6, c]; break; }
  }
  if (alternates) {
    for (let r = 8; r < n - 9; r++) if (m[r][6] === m[r + 1][6]) { alternates = false; timingBad = [r, 6]; break; }
  }
  check(`3[${fx.tag}]`, 'timing pattern row 6 / col 6 alternates (dark on even index)',
    timingAlt && alternates, timingBad ? `first violation at ${JSON.stringify(timingBad)}` : `span 8..${n - 9}`);

  // (6) format info
  const fi = readFormatInfo(m, n);
  const copiesAgree = fi.vertical === fi.horizontal;
  const u = fi.vertical ^ G15_MASK;
  const rem = bchRemainder15(u);
  const data5 = u >>> 10;
  const ecOk = (data5 >>> 3) === EC_INDICATOR[fx.ec];
  check(`6[${fx.tag}]`, 'format info: both copies identical + valid BCH(15,5) + right EC level',
    copiesAgree && rem === 0 && ecOk,
    `v=0x${fi.vertical.toString(16)}, h=0x${fi.horizontal.toString(16)}, remainder=${rem}, ` +
    `data=0b${data5.toString(2).padStart(5, '0')} (ec=${['M', 'L', 'H', 'Q'][data5 >>> 3]}, mask=${data5 & 7})`);
  check(`6.1[${fx.tag}]`, 'fixed dark module at (n-8, 8) is dark', m[n - 8][8] === true);

  allStructuralOk = allStructuralOk && square && tl.ok && tr.ok && bl.ok && sep.ok &&
    timingAlt && alternates && copiesAgree && rem === 0 && ecOk;
}

/* ------------------------------------------------------------------ *
 * 4. L vs M: different matrix, same size rule
 * ------------------------------------------------------------------ */

section('4. EC level L vs M for the same content');

const qrL = build(CONTENT, 'L');
const qrM = build(CONTENT, 'M');
const mL = matrixOf(qrL);
const mM = matrixOf(qrM);
const nL = qrL.getModuleCount();
const nM = qrM.getModuleCount();
const diffAt = firstDiff(mL, mM);

console.log(`  L: moduleCount=${nL} version=${versionOf(qrL)}   M: moduleCount=${nM} version=${versionOf(qrM)}`);
check('4.1', 'L and M matrices differ (different EC/RS + mask)',
  diffAt !== null && !(nL === nM && diffAt === null),
  diffAt ? `first difference at row/col ${JSON.stringify(diffAt)}` : 'matrices identical');
check('4.2', 'both satisfy n === 17 + 4*version',
  nL === 17 + 4 * versionOf(qrL) && nM === 17 + 4 * versionOf(qrM),
  `L n=${nL} v=${versionOf(qrL)}, M n=${nM} v=${versionOf(qrM)}`);
check('4.3', 'stronger EC (M) needs version >= weaker EC (L)',
  versionOf(qrM) >= versionOf(qrL), `${versionOf(qrL)} -> ${versionOf(qrM)}`);

/* ------------------------------------------------------------------ *
 * 5. monotonic version growth
 * ------------------------------------------------------------------ */

section('5. version monotonicity vs content length (EC level M)');

const lengths = [10, 28, 60, 120, 300, 600, 1000, 1600];
const versions = [];
let text = '';
for (let i = 0; i < lengths.length; i++) {
  text = 'A'.repeat(lengths[i]);
  const qr = build(text, 'M');
  versions.push({ len: lengths[i], v: versionOf(qr), n: qr.getModuleCount(), okSize: qr.getModuleCount() === 17 + 4 * versionOf(qr) });
}
for (const row of versions) console.log(`  len=${String(row.len).padStart(4)}  version=${String(row.v).padStart(2)}  moduleCount=${row.n}`);
let monotonic = true, sizeRule = true;
for (let i = 0; i < versions.length; i++) {
  if (i > 0 && versions[i].v < versions[i - 1].v) monotonic = false;
  if (!versions[i].okSize) sizeRule = false;
}
check('5.1', 'version never decreases as content grows', monotonic,
  versions.map((r) => r.v).join(' -> '));
check('5.2', 'size rule holds across all lengths', sizeRule);
check('5.3', 'a longer payload needs strictly more capacity (tail grows)',
  versions[versions.length - 1].v > versions[0].v,
  `v${versions[0].v} -> v${versions[versions.length - 1].v}`);

/* ------------------------------------------------------------------ *
 * ASCII preview
 * ------------------------------------------------------------------ */

section(`ASCII preview (first 21x21 of the ${CONTENT} / M symbol)`);
const preview = matrixOf(qrM);
const ROWS = Math.min(21, preview.length);
const COLS = Math.min(21, preview[0].length);
let art = '';
for (let r = 0; r < ROWS; r++) {
  let line = '';
  for (let c = 0; c < COLS; c++) line += preview[r][c] ? '##' : '  ';
  art += line + '\n';
}
console.log(art.replace(/\n$/, ''));

/* ------------------------------------------------------------------ *
 * Verdict
 * ------------------------------------------------------------------ */

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${passed}/${results.length} checks passed ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAILED: ${f.id} ${f.name} ${f.detail}`);
  process.exitCode = 1;
} else {
  console.log('SELF-TEST OK: vendor/qrcode.js produces structurally valid QR symbols.');
}

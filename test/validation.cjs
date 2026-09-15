'use strict';
// Explicit local validation driver. Run with the read-only pre-edit copy directory.
// All fixture mutations are inside newly allocated temporary directories.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const tw = require('../lib.cjs');
const { fixture, temp, write, testSource, valueTest } = require('./fixtures.cjs');
const original = path.resolve(process.argv[2]);
const destination = path.resolve(process.argv[3]);
const old = require(path.join(original, 'lib.cjs'));
const summary = { createdAt: new Date().toISOString(), runtime: process.version, platform: process.platform,
  cases: [], benchmarks: { original: [], v01: [] } };
function evidence(label, f, report, expected) {
  if (report.verdict !== expected) throw new Error(label + ': ' + report.verdict + ' expected ' + expected);
  summary.cases.push({ label, expected, verdict: report.verdict, reason: report.reason,
    before: report.before.map(r => r.outcome), after: report.after.map(r => r.outcome),
    witnessedChanges: report.witnessedChanges, dependencyState: report.environment.state,
    timings: report.timings, safety: report.safety });
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_');
  tw.saveNew(path.join(destination, safeLabel + '.json'), report);
}
for (const [label, body, expected, options] of [
  ['A_H_I_J_FIX', null, 'PROVEN', { repeat: 3 }],
  ['B_UNRELATED', testSource("test('always',()=>{});"), 'NOT_PROVEN', {}],
  ['C_BROKEN', testSource("test('broken',()=>a.equal(1,2));"), 'NOT_PROVEN', {}],
  ['D_SKIPPED', testSource("test.skip('skip',()=>{});test('control',()=>{});"), 'INCONCLUSIVE', {}],
  ['E_TIMEOUT', testSource("test('hang',()=>{while(true){}});"), 'INCONCLUSIVE', { timeoutMs: 100, repeat: 2 }],
  ['F_DISCOVERY', 'exports.noTests=true;', 'INCONCLUSIVE', {}],
  ['G_DEPENDENCY_CHANGE', null, 'INCONCLUSIVE', {}],
]) {
  const f = fixture(); f.put('unrelated.txt', 'existing dirty bytes\r\n');
  if (label.startsWith('G')) f.put('package-lock.json', '{"lockfileVersion":3}');
  tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;'); f.put('another.txt', 'second change'); f.put('value.test.cjs', body || valueTest);
  if (label.startsWith('G')) f.put('package-lock.json', '{"lockfileVersion":3,"name":"changed"}');
  evidence(label, f, tw.prove(f.ctx, options), expected);
}

// A real-source replay: original implementation bytes, final implementation bytes,
// and one regression added in this task. Keep the original manifest fixed so this
// isolates code changes and does not claim a manifest-changing full-tree proof.
{
  const f = fixture();
  for (const name of ['lib.cjs', 'reporter.cjs', 'package.json']) f.put(name, fs.readFileSync(path.join(original, name)));
  const beforeHashes = Object.fromEntries(['lib.cjs', 'reporter.cjs'].map(n => [n, tw.hash(fs.readFileSync(path.join(original, n)))]));
  tw.arm(f.ctx);
  for (const name of ['lib.cjs', 'reporter.cjs', 'capture.cjs', 'runner.cjs']) f.put(name, fs.readFileSync(path.join(__dirname, '..', name)));
  f.put('test/partial-skip-regression.test.cjs', fs.readFileSync(path.join(__dirname, 'partial-skip-regression.test.cjs')));
  const report = tw.prove(f.ctx, { tests: ['test/partial-skip-regression.test.cjs'], repeat: 3 });
  evidence('REAL_SOURCE_PARTIAL_SKIP_REPLAY', f, report, 'PROVEN');
  summary.realSourceReplay = { kind: 'REAL_SOURCE_REPLAY_WITH_FIXED_MANIFEST', beforeHashes,
    afterHashes: Object.fromEntries(['lib.cjs', 'reporter.cjs', 'capture.cjs', 'runner.cjs'].map(n => [n, tw.hash(fs.readFileSync(path.join(__dirname, '..', n)))])) };
}

for (const [label, implementation] of [['original', old], ['v01', tw]]) {
  for (let i = 0; i < 3; i++) {
    const f = fixture(), start = performance.now(); implementation.arm(f.ctx);
    const armMs = performance.now() - start;
    f.put('lib.cjs', 'exports.value=2;'); f.put('value.test.cjs', valueTest);
    const proveStart = performance.now();
    const r = implementation.prove(f.ctx, label === 'original' ? { maxFiles: 0 } : { repeat: 2 });
    const proveMs = performance.now() - proveStart;
    const runs = label === 'original' ? [r.before, r.after, r.beforeAgain, r.afterAgain] : [...r.before, ...r.after];
    const testMs = runs.reduce((n, r) => n + r.durationMs, 0);
    if (!['WITNESSED', 'PROVEN'].includes(r.verdict)) throw new Error('Benchmark failed: ' + r.verdict);
    summary.benchmarks[label].push({ armMs, proveMs, testMs, overheadMs: proveMs - testMs,
      ...(label === 'v01' ? { sandboxPreparationMs: r.timings.sandboxPreparationMs, archivalMs: r.timings.archivalMs } : {}) });
  }
}
// Actual CLI calls preserve literal argv for quoted Windows paths, including both shells.
{
  const f = fixture(), cli = path.resolve(__dirname, '../timewitness.cjs');
  const invoke = (shell, command, args) => cp.spawnSync(shell, [...command, ...args], { cwd: f.root, encoding: 'utf8', windowsHide: true });
  const psQuote = s => "'" + s.replaceAll("'", "''") + "'";
  const armed = invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command'],
    ['& ' + psQuote(process.execPath) + ' ' + psQuote(cli) + ' arm --repo ' + psQuote(f.root) + ' --json']);
  if (armed.status !== 0) throw new Error('PowerShell arm failed');
  f.put('lib.cjs', 'exports.value=2;'); f.put('test with spaces.test.cjs', valueTest);
  const proved = invoke('cmd.exe', ['/d', '/s', '/c'],
    ['""' + process.execPath + '" "' + cli + '" prove --repo "' + f.root + '" --test "test with spaces.test.cjs" --json"']);
  if (proved.status !== 0) throw new Error('cmd prove failed: ' + proved.stderr);
  const r = JSON.parse(proved.stdout); if (r.verdict !== 'PROVEN') throw new Error('CLI proof failed');
  summary.cli = { powershellArmExit: armed.status, cmdProveExit: proved.status, verdict: r.verdict,
    selectedTest: r.tests, freshness: r.freshness.status };
}
summary.falseProven = summary.cases.filter(c => c.expected !== 'PROVEN' && c.verdict === 'PROVEN').length;
tw.saveNew(path.join(destination, 'validation-summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));

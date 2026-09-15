'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const tw = require('../lib.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'timewitness-test-'));
const file = content => ({ content: Buffer.from(content).toString('base64'), sha256: tw.hash(content) });
function fixture() {
  const root = temp();
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  fs.writeFileSync(path.join(root, 'math.cjs'), 'exports.double = n => n + 2;\n');
  fs.writeFileSync(path.join(root, 'label.cjs'), 'exports.label = "old";\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  const ctx = tw.context(root);
  ctx.home = path.join(temp(), 'state');
  return { root, ctx };
}

test('path traversal and absolute paths cannot become snapshot destinations', () => {
  const root = temp();
  assert.throws(() => tw.safeFile(root, '../outside'));
  assert.throws(() => tw.safeFile(root, path.resolve(root, 'absolute')));
  assert.throws(() => tw.safeFile(root, '.git/config'));
  assert.equal(tw.safeFile(root, '日本語 name.cjs'), path.join(root, '日本語 name.cjs'));
});

test('Git snapshot preserves dirty/untracked bytes and omits ignored files and junctions', () => {
  const { root, ctx } = fixture();
  fs.mkdirSync(path.join(root, 'ignored'));
  fs.writeFileSync(path.join(root, 'ignored', 'secret'), 'not copied');
  fs.mkdirSync(path.join(root, 'private-data'));
  fs.writeFileSync(path.join(root, 'private-data', 'runtime.json'), '{}');
  const outside = temp();
  fs.writeFileSync(path.join(outside, 'outside.cjs'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const snap = tw.snapshot(ctx);
  assert.equal(Buffer.from(snap.files['math.cjs'].content, 'base64').toString(), 'exports.double = n => n + 2;\n');
  assert.equal(snap.files['ignored/secret'], undefined);
  assert.equal(snap.files['private-data/runtime.json'], undefined);
  assert.equal(snap.files['linked/outside.cjs'], undefined);
  assert.equal(ctx.head, null);
});

test('end to end: future test witnesses the full change set without staging', () => {
  const { root, ctx } = fixture();
  const beforeStatus = cp.execFileSync('git', ['-C', root, 'diff', '--cached']).toString();
  tw.arm(ctx);
  fs.writeFileSync(path.join(root, 'math.cjs'), 'exports.double = n => n * 2;\n');
  fs.writeFileSync(path.join(root, 'label.cjs'), 'exports.label = "new";\n');
  fs.writeFileSync(path.join(root, 'double.test.cjs'),
    "const {test}=require('node:test'); const a=require('node:assert/strict');const m=require('./math.cjs');test('double three',()=>a.equal(m.double(3),6));\n");
  const beforeRun = tw.snapshot(ctx);
  const report = tw.prove(ctx);
  assert.equal(report.verdict, 'PROVEN');
  assert.match(report.before[0].assertions[0].id, /^double\.test\.cjs :: [a-f0-9]+$/);
  assert.deepEqual(report.witnessedChanges, ['label.cjs', 'math.cjs']);
  assert.equal(report.mode, 'FULL_WITNESS');
  assert.deepEqual(tw.diff(beforeRun.files, tw.snapshot(ctx).files), []);
  assert.equal(cp.execFileSync('git', ['-C', root, 'diff', '--cached']).toString(), beforeStatus);
  assert.equal(tw.freshness(ctx, report).status, 'CURRENT');
  fs.appendFileSync(path.join(root, 'math.cjs'), '// next edit\n');
  assert.equal(tw.freshness(ctx, report).status, 'STALE');
});

test('missing modules are inconclusive, never a successful witness', () => {
  const folder = path.join(temp(), 'world');
  const run = tw.runWorld(folder, { 'oops.test.cjs': file("require('./missing.cjs');") }, ['oops.test.cjs']);
  assert.equal(run.infrastructureFailure, true);
  assert.equal(run.assertions.length, 0);
  assert.equal(tw.classify(run, run, run, run), 'INCONCLUSIVE');
});

test('a tautological test that passes in both worlds does not demonstrate a fix', () => {
  const folder = path.join(temp(), 'world');
  const run = tw.runWorld(folder, { 'same.test.cjs': file("require('node:test').test('always',()=>{});") }, ['same.test.cjs']);
  assert.equal(run.passed, true);
  assert.equal(tw.classify(run, run, run, run), 'NOT_PROVEN');
});

test('disagreeing repetitions cannot receive a stable witness verdict', () => {
  const fail = { exitCode: 1, tests: [{id:'a',passed:false}], infrastructureFailure:false, passed:false, assertions:[{id:'a'}] };
  const pass = { exitCode: 0, tests: [{id:'a',passed:true}], infrastructureFailure:false, passed:true, assertions:[] };
  assert.equal(tw.classify(fail, pass, fail, pass), 'PROVEN');
  assert.equal(tw.classify(fail, pass, pass, pass), 'INCONCLUSIVE');
});

test('a skipped assertion cannot count as a passing witness', () => {
  const run = tw.runWorld(path.join(temp(), 'world'), {
    'skip.test.cjs': file("const {test}=require('node:test'); test.skip('not run',()=>{}); test('control',()=>{});")
  }, ['skip.test.cjs']);
  assert.equal(run.passed, false);
  assert.equal(run.tests.find(t => t.skip).passed, false);
  const fail = { exitCode:1, tests:[{id:'skip.test.cjs :: not run',passed:false}], passed:false,
    infrastructureFailure:false, assertions:[{id:'skip.test.cjs :: not run'}] };
  assert.equal(tw.classify(fail, run, fail, run), 'INCONCLUSIVE');
});

test('all-skipped test run is inconclusive', () => {
  const run = tw.runWorld(path.join(temp(), 'world'), {
    'skip.test.cjs': file("require('node:test').test.skip('never runs',()=>{});")
  }, ['skip.test.cjs']);
  assert.equal(run.passed, false);
  assert.equal(run.infrastructureFailure, true);
});

test('duplicate names cannot ambiguously match a different passing test', () => {
  const fail = {exitCode:1,tests:[{id:'same',passed:false},{id:'same',passed:true}],
    passed:false,infrastructureFailure:false,assertions:[{id:'same'}]};
  const pass = {exitCode:0,tests:[{id:'same',passed:true},{id:'same',passed:true}],
    passed:true,infrastructureFailure:false,assertions:[]};
  assert.equal(tw.classify(fail, pass, fail, pass), 'INCONCLUSIVE');
});

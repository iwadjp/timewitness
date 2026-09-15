'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const tw = require('../lib.cjs');
const { temp, write, git, testSource } = require('./fixtures.cjs');

// Real-repo shape: source under one top-level directory, tests under a sibling one,
// with an unrelated nested package.json and a private/output-style directory elsewhere
// in the repo that must never be pulled in just because scope now spans two directories.
function multiScopeFixture() {
  const root = temp('tw-multiscope-');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'lib/value.cjs', 'exports.compareRuns=function(a,b){return a.hasEvaluated&&!b.hasEvaluated?-1:1;};\n');
  write(root, 'other-project/package.json', JSON.stringify({ name: 'unrelated', dependencies: { leftpad: '1.0.0' } }));
  write(root, 'private-data/secret.md', 'do not capture this');
  write(root, 'test/.keep', '');
  const ctx = tw.context(root, ['lib', 'test']);
  ctx.home = path.join(temp(), 'state');
  return { root, ctx, put: (name, text) => write(root, name, text) };
}

test('source and test directories can be scoped together without pulling in unrelated nested package.json or private/output dirs', () => {
  const f = multiScopeFixture();
  const armed = tw.arm(f.ctx);
  a.deepEqual(armed.omitted, []);
  a.equal(armed.dependency.state, 'EXISTING_ENV');
  a.equal(armed.dependency.reasons.length, 0);
  a.ok(!('other-project/package.json' in armed.files));
  a.ok(!('private-data/secret.md' in armed.files));
  a.ok('lib/value.cjs' in armed.files);
});

test('d290a13-shaped fix: multi-directory scope reaches PROVEN without any git index editing', () => {
  const f = multiScopeFixture();
  tw.arm(f.ctx);
  // Pre-fix bug: an already-evaluated run always outranks a newer one.
  f.put('lib/value.cjs', 'exports.compareRuns=function(a,b){return b.completedAt-a.completedAt;};\n');
  f.put('test/value.test.cjs', testSource(
    "test('newer unevaluated run outranks an older evaluated one',()=>{" +
    "const {compareRuns}=require('../lib/value.cjs');" +
    "const older={hasEvaluated:true,completedAt:1};const newer={hasEvaluated:false,completedAt:2};" +
    "a.equal([older,newer].sort(compareRuns)[0],newer);});"));
  const r = tw.prove(f.ctx, { repeat: 2 });
  a.equal(r.verdict, 'PROVEN', JSON.stringify(r));
  a.equal(r.reason, 'REPEATED_ASSERTION_FAIL_TO_PASS');
  a.ok(r.before.every(x => x.outcome === 'FAIL'));
  a.ok(r.after.every(x => x.outcome === 'PASS'));
  a.deepEqual(r.witnessedChanges, ['lib/value.cjs']);
});

test('negative control: an unrelated, unmodified test under the same multi-directory scope cannot become PROVEN', () => {
  const f = multiScopeFixture();
  tw.arm(f.ctx);
  f.put('test/unrelated.test.cjs', testSource("test('always',()=>a.equal(1,1));"));
  f.put('lib/value.cjs', 'exports.compareRuns=function(a,b){return b.completedAt-a.completedAt;};\n');
  f.put('test/value.test.cjs', testSource("test('irrelevant to unrelated.test.cjs',()=>a.equal(1,1));"));
  const r = tw.prove(f.ctx, { tests: ['test/unrelated.test.cjs'], repeat: 2 });
  a.notEqual(r.verdict, 'PROVEN');
  a.equal(r.reason, 'BEFORE_ALSO_PASSES');
});

test('a relevant helper left outside every scoped directory cannot silently pass; it goes INCONCLUSIVE', () => {
  const root = temp('tw-multiscope-hidden-');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'lib/value.cjs', "exports.value=require('../shared/helper.cjs').base+1;\n");
  write(root, 'shared/helper.cjs', 'exports.base=1;\n');
  write(root, 'test/.keep', '');
  const ctx = tw.context(root, ['lib', 'test']);
  ctx.home = path.join(temp(), 'state');
  tw.arm(ctx);
  write(root, 'lib/value.cjs', "exports.value=require('../shared/helper.cjs').base+2;\n");
  write(root, 'test/value.test.cjs', testSource("test('value',()=>a.equal(require('../lib/value.cjs').value,3));"));
  const r = tw.prove(ctx, { repeat: 2 });
  a.equal(r.verdict, 'INCONCLUSIVE', JSON.stringify(r));
  a.notEqual(r.reason, 'REPEATED_ASSERTION_FAIL_TO_PASS');
});

test('dependency/manifest drift is still caught when scope excludes the repo root', () => {
  const root = temp('tw-multiscope-dep-');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'package.json', JSON.stringify({ private: true, dependencies: { example: '1.0.0' } }));
  write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0' } } }));
  write(root, 'node_modules/example/package.json', '{"name":"example","version":"1.0.0","main":"index.js"}');
  write(root, 'node_modules/example/index.js', 'exports.offset=0;');
  write(root, '.gitignore', 'node_modules/\n');
  write(root, 'lib/value.cjs', 'exports.value=1;\n');
  write(root, 'test/.keep', '');
  const ctx = tw.context(root, ['lib', 'test']);
  ctx.home = path.join(temp(), 'state');
  const armed = tw.arm(ctx);
  a.equal(armed.dependency.state, 'EXISTING_ENV');
  a.ok(!('package.json' in armed.files));
  fs.appendFileSync(path.join(root, 'package.json'), ' ');
  write(root, 'lib/value.cjs', 'exports.value=2;\n');
  write(root, 'test/value.test.cjs', testSource("test('value',()=>a.equal(require('../lib/value.cjs').value,2));"));
  const r = tw.prove(ctx, { repeat: 1 });
  a.equal(r.verdict, 'INCONCLUSIVE');
  a.equal(r.environment.state, 'ENVIRONMENT_NOT_REPRODUCED');
});

test('CLI accepts repeated --scope without a Duplicate option error', () => {
  const root = temp('tw-multiscope-cli-');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'lib/value.cjs', 'exports.value=1;\n');
  write(root, 'test/placeholder.test.cjs', testSource("test('x',()=>a.equal(1,1));"));
  const cli = path.resolve(__dirname, '../timewitness.cjs');
  const env = { ...process.env, LOCALAPPDATA: path.join(temp(), 'state-root') };
  const result = cp.spawnSync(process.execPath, [cli, 'arm', '--repo', root, '--scope', 'lib', '--scope', 'test'],
    { encoding: 'utf8', windowsHide: true, env });
  a.equal(result.status, 0, result.stderr);
  a.match(result.stdout, /ARMED/);
});

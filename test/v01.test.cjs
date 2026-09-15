'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const tw = require('../lib.cjs');
const { temp, fixture, fixed, file, git, testSource, valueTest, indexedFixture, write } = require('./fixtures.cjs');

test('A/H/I/J: real assertion witness, full set, unrelated dirt, untracked test, repeat 3', () => {
  const f = fixture(); f.put('unrelated.txt', 'keep this dirty byte stream\r\n');
  tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;'); f.put('another.txt', 'another change'); f.put('value.test.cjs', valueTest);
  const before = tw.snapshot(f.ctx), state = tw.guard(f.ctx);
  const r = tw.prove(f.ctx, { tests: ['.\\value.test.cjs'], repeat: 3 });
  a.equal(r.verdict, 'PROVEN'); a.equal(r.before.length, 3); a.equal(r.after.length, 3);
  a.ok(r.before.every(x => x.outcome === 'FAIL')); a.ok(r.after.every(x => x.outcome === 'PASS'));
  a.deepEqual(r.witnessedChanges, ['another.txt', 'lib.cjs']); a.deepEqual(r.transplanted, ['value.test.cjs']);
  a.deepEqual(tw.diff(before.files, tw.snapshot(f.ctx).files), []); a.deepEqual(tw.guard(f.ctx), state);
  a.ok(Object.values(r.safety).every(Boolean));
  for (const key of ['cwdFingerprint', 'commandFingerprint', 'environmentFingerprint'])
    a.equal(new Set([...r.before, ...r.after].map(x => x[key])).size, 1);
});

for (const [label, body, expected, outcome] of [
  ['B unrelated test', "test('always',()=>a.equal(1,1));", 'NOT_PROVEN', 'PASS'],
  ['C broken assertion', "test('broken',()=>a.equal(1,2));", 'NOT_PROVEN', 'FAIL'],
  ['D skip with passing control', "test.skip('skip',()=>{});test('control',()=>{});", 'INCONCLUSIVE', 'INCONCLUSIVE'],
  ['D todo with passing control', "test.todo('todo');test('control',()=>{});", 'INCONCLUSIVE', 'INCONCLUSIVE'],
  ['F empty discovery', 'exports.noTests=true;', 'INCONCLUSIVE', 'INCONCLUSIVE'],
  ['setup assertion in before hook', "before(()=>a.equal(1,2));test('control',()=>{});", 'INCONCLUSIVE', 'INCONCLUSIVE'],
  ['setup assertion in after hook', "after(()=>a.equal(1,2));test('control',()=>{});", 'INCONCLUSIVE', 'INCONCLUSIVE'],
  ['module setup failure', "require('./missing.cjs');", 'INCONCLUSIVE', 'INCONCLUSIVE'],
]) {
  test(label + ' cannot become a proof', () => {
    const f = fixed(); f.put('value.test.cjs', testSource(body));
    const r = tw.prove(f.ctx); a.equal(r.verdict, expected, JSON.stringify(r));
    a.equal(r.before[0].outcome, outcome); a.equal(r.after[0].outcome, outcome);
  });
}

test('E synchronous hang is bounded by outer timeout and never counts as FAIL', () => {
  const f = fixed(); f.put('value.test.cjs', testSource("test('hang',()=>{while(true){}});"));
  const start = Date.now(), r = tw.prove(f.ctx, { timeoutMs: 100, repeat: 1 });
  a.equal(r.verdict, 'INCONCLUSIVE'); a.ok(Date.now() - start < 10000);
  a.ok(r.before[0].reasons.includes('TIMEOUT')); a.equal(r.before[0].outcome, 'INCONCLUSIVE');
});
test('E asynchronous timeout is inconclusive', () => {
  const f = fixed(); f.put('value.test.cjs', testSource("test('hang',async()=>{await new Promise(resolve=>setTimeout(resolve,5000));});"));
  const r = tw.prove(f.ctx, { timeoutMs: 100, repeat: 1 }); a.equal(r.verdict, 'INCONCLUSIVE');
});
test('F explicit missing test produces a persisted inconclusive report', () => {
  const f = fixed(), r = tw.prove(f.ctx, { tests: ['missing.test.cjs'] });
  a.equal(r.verdict, 'INCONCLUSIVE'); a.equal(r.reason, 'TEST_DISCOVERY_FAILURE');
  a.equal(tw.latestReport(f.ctx).runId, r.runId);
});
test('different discovered tests and setup errors cannot prove a patch', () => {
  const f = fixed(); f.put('value.test.cjs', testSource("const v=require('./lib.cjs').value;test(v===1?'old':'new',()=>a.equal(v,2));"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'NOT_PROVEN'); a.equal(r.reason, 'TEST_DISCOVERY_DIFFERS');
});
test('an assertion in a failed suite setup is inconclusive', () => {
  const f = fixed(); f.put('value.test.cjs', testSource("describe('suite',()=>{a.equal(require('./lib.cjs').value,2);test('inside',()=>{});});"));
  a.equal(tw.prove(f.ctx).verdict, 'INCONCLUSIVE');
});

function dependencyFixture() {
  const f = fixture(); f.put('package.json', JSON.stringify({ private: true, dependencies: { example: '1.0.0' } }));
  f.put('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0' } } }));
  f.put('node_modules/example/package.json', '{"name":"example","version":"1.0.0","main":"index.js"}');
  f.put('node_modules/example/index.js', 'exports.offset=0;');
  f.put('.gitignore', 'node_modules/\n'); return f;
}
test('EXISTING_ENV copies dependencies to independent worlds without install or shared writes', () => {
  const f = dependencyFixture(); tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;');
  f.put('value.test.cjs', testSource("test('dep',()=>a.equal(require('./lib.cjs').value+require('example').offset,2));"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'PROVEN'); a.equal(r.environment.kind, 'COPIED_NODE_MODULES');
  a.equal(r.environment.state, 'EXISTING_ENV'); a.equal(r.environment.lockfileSame, true);
  a.equal(fs.readFileSync(path.join(f.root, 'node_modules/example/index.js'), 'utf8'), 'exports.offset=0;');
});
for (const target of ['package.json', 'package-lock.json', 'node_modules/example/index.js']) {
  test('G change in ' + target + ' is explicitly environment-not-reproduced', () => {
    const f = dependencyFixture(); tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;'); f.put('value.test.cjs', valueTest);
    fs.appendFileSync(path.join(f.root, target), target.endsWith('.js') ? '// changed' : ' ');
    const r = tw.prove(f.ctx); a.equal(r.verdict, 'INCONCLUSIVE'); a.equal(r.environment.state, 'ENVIRONMENT_NOT_REPRODUCED');
    a.equal(r.before.length, 0);
  });
}
test('missing declared dependencies and pnpm/yarn locks do not silently use global packages', () => {
  const f = fixture(); f.put('package.json', '{"dependencies":{"missing":"1"}}'); f.put('yarn.lock', '# fixture');
  tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;'); f.put('value.test.cjs', valueTest);
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'INCONCLUSIVE');
  a.ok(r.environment.reasons.includes('NODE_MODULES_MISSING')); a.ok(r.environment.reasons.includes('NON_NPM_LOCKFILE_UNSUPPORTED'));
});
test('dependency junctions are refused and never followed', () => {
  const f = fixture(), outside = temp(); write(outside, 'index.js', 'module.exports=1;');
  fs.mkdirSync(path.join(f.root, 'node_modules')); fs.symlinkSync(outside, path.join(f.root, 'node_modules', 'linked'), 'junction');
  a.ok(tw.arm(f.ctx).dependency.reasons.includes('DEPENDENCY_LINK_UNSUPPORTED'));
});
test('mutating a dependency inside the sandbox cannot corrupt the original or prove', () => {
  const f = dependencyFixture(); tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;');
  f.put('value.test.cjs', testSource("test('mutate',()=>{fs.writeFileSync('node_modules/example/index.js','changed');a.equal(require('./lib.cjs').value,2);});"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'INCONCLUSIVE'); a.ok(r.before[0].reasons.includes('INPUT_MUTATED_BY_TEST'));
  a.equal(fs.readFileSync(path.join(f.root, 'node_modules/example/index.js'), 'utf8'), 'exports.offset=0;');
});

test('staged/unstaged/mixed/add/delete/rename/binary/CRLF/large/path bytes and index survive arm/prove', () => {
  const f = indexedFixture(), status = git(f.root, ['status', '--porcelain=v1']);
  for (const token of ['MM mixed.cjs', 'M  staged.txt', ' M unstaged.txt', ' D deleted.txt', 'A  added.txt', 'R  old-name.txt -> new-name.txt', '?? untracked.txt']) a.ok(status.includes(token), token);
  const base = tw.arm(f.ctx), state = tw.guard(f.ctx);
  a.equal(Buffer.from(base.files['mixed.cjs'].content, 'base64').toString(), 'exports.value=2;\n');
  a.equal(base.files['deleted.txt'], undefined); a.ok(base.files['new-name.txt']);
  f.put('mixed.cjs', 'exports.value=3;\n');
  f.put('value.test.cjs', testSource("test('mixed dirty fix',()=>a.equal(require('./mixed.cjs').value,3));"));
  const pre = tw.snapshot(f.ctx), preGuard = tw.guard(f.ctx), r = tw.prove(f.ctx);
  a.equal(r.verdict, 'PROVEN'); a.deepEqual(tw.diff(pre.files, tw.snapshot(f.ctx).files), []);
  a.deepEqual(tw.guard(f.ctx), preGuard); a.equal(tw.guard(f.ctx).index, state.index);
  const world = path.join(f.ctx.home, 'runs', r.runId, 'before-1');
  for (const name of ['binary.dat', 'line endings.txt', 'large.dat', 'new-name.txt'])
    a.deepEqual(fs.readFileSync(path.join(world, name)), Buffer.from(base.files[name].content, 'base64'));
  a.equal(fs.statSync(path.join(world, 'mixed.cjs')).mode & 0o777, base.files['mixed.cjs'].mode);
});
test('file addition/deletion/rename and mode are materialized as the complete change set', () => {
  const f = fixture(); f.put('old.txt', 'old\r\n'); f.put('delete.txt', 'obsolete'); tw.arm(f.ctx);
  fs.renameSync(path.join(f.root, 'old.txt'), path.join(f.root, 'new name.txt'));
  fs.renameSync(path.join(f.root, 'delete.txt'), path.join(temp(), 'retained.txt'));
  f.put('added.bin', Buffer.from([0, 255, 2]));
  f.put('value.test.cjs', testSource("test('new files',()=>{a.equal(fs.existsSync('old.txt'),false);a.equal(fs.existsSync('delete.txt'),false);a.equal(fs.readFileSync('new name.txt','utf8'),'old\\r\\n');a.equal(fs.readFileSync('added.bin')[1],255);});"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'PROVEN');
  a.deepEqual(r.witnessedChanges, ['added.bin', 'delete.txt', 'new name.txt', 'old.txt']);
  a.deepEqual(tw.diff({ x: { sha256: 'same', mode: 0o644 } }, { x: { sha256: 'same', mode: 0o755 } }), ['x']);
});
test('nested repository and worktree boundaries are not crossed', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.root, 'nested'));
  cp.execFileSync('git', ['init', '--quiet', path.join(f.root, 'nested')], { windowsHide: true });
  write(path.join(f.root, 'nested'), 'hidden.cjs', 'never copied');
  a.throws(() => tw.context(f.root, 'nested'), /boundary/);
  const snap = tw.snapshot(f.ctx); a.ok(!snap.files['nested/hidden.cjs']); a.ok(snap.omitted.length);
  const wt = temp(), admin = path.join(f.root, '.git', 'worktrees', 'fixture');
  write(admin, 'commondir', '../..\n'); write(admin, 'HEAD', 'ref: refs/heads/fixture-worktree\n');
  write(admin, 'gitdir', path.join(wt, '.git') + '\n'); write(wt, '.git', 'gitdir: ' + admin + '\n'); write(wt, 'lib.cjs', 'exports.value=1;');
  const ctx = tw.context(wt); ctx.home = path.join(temp(), 'state'); tw.arm(ctx);
  write(wt, 'lib.cjs', 'exports.value=2;'); write(wt, 'value.test.cjs', valueTest);
  a.equal(tw.prove(ctx).verdict, 'PROVEN');
});
test('large capture fails closed before reading an oversized file', () => {
  const f = fixture(), large = path.join(f.root, 'oversize.dat'); const fd = fs.openSync(large, 'wx');
  fs.ftruncateSync(fd, 65 * 1024 * 1024); fs.closeSync(fd);
  a.throws(() => tw.arm(f.ctx), /CAPTURE_LIMIT/);
});
test('ignored runtime inputs cause explicit inconclusive reproduction', () => {
  const f = fixture(); f.put('.gitignore', 'runtime/\n'); f.put('runtime/state.json', '{}'); tw.arm(f.ctx);
  f.put('lib.cjs', 'exports.value=2;'); f.put('value.test.cjs', valueTest);
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'INCONCLUSIVE'); a.equal(r.reason, 'SANDBOX_INPUTS_OMITTED');
});

test('quoted paths/metacharacters use literal argv; no shell interpretation', () => {
  const f = fixed(), name = 'test with spaces & echo nope.test.cjs'; f.put(name, valueTest);
  const r = tw.prove(f.ctx, { tests: ['./' + name] }); a.equal(r.verdict, 'PROVEN'); a.deepEqual(r.tests, [name]);
  for (const unsafe of ['../x.test.cjs', 'C:\\escape.cjs', '.GIT/config', 'x:stream', 'NUL.test.cjs']) a.throws(() => tw.safeFile(f.root, unsafe));
  const cli = path.resolve(__dirname, '../timewitness.cjs');
  const bad = cp.spawnSync(process.execPath, [cli, 'prove', '--command', 'echo unsafe'], { encoding: 'utf8', windowsHide: true }); a.equal(bad.status, 1);
});
test('environment allowlist removes inherited test context, Node loaders, Git overrides and secrets', () => {
  const saved = { ...process.env };
  try {
    process.env.NODE_TEST_CONTEXT = 'child-v8'; process.env.NODE_OPTIONS = '--require=missing';
    process.env.GIT_DIR = 'missing'; process.env.TW_SECRET_SENTINEL = 'never inherit';
    const folder = path.join(temp(), 'world');
    const src = testSource("test('env',()=>{for(const k of ['NODE_TEST_CONTEXT','NODE_OPTIONS','GIT_DIR','TW_SECRET_SENTINEL'])a.equal(process.env[k],undefined);a.equal(process.env.TIMEWITNESS_WORLD,process.cwd());});");
    a.equal(tw.runWorld(folder, { 'env.test.cjs': file(src) }, ['env.test.cjs']).passed, true);
  } finally { process.env = saved; }
});
test('stdout/stderr and assertion/test-name secrets never enter the persisted report', () => {
  const f = fixed(), secret = 'TW_FAKE_SECRET_SENTINEL_123';
  f.put('value.test.cjs', testSource("test('" + secret + "',()=>{console.log('" + secret + "');console.error('" + secret + "');a.equal(require('./lib.cjs').value,2,'" + secret + "');});"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'PROVEN');
  const serialized = fs.readFileSync(path.join(f.ctx.home, r.evidencePath), 'utf8');
  a.ok(!serialized.includes(secret)); a.ok(!serialized.includes(f.root)); a.ok(!serialized.includes(process.env.USERNAME));
  a.ok(r.before[0].output.stdoutBytes > 0); a.equal(r.before[0].output.rawSaved, false);
});
test('changed test helpers remain part of the witnessed set instead of silently transplanted', () => {
  const f = fixture(); f.put('test/helper.cjs', 'exports.value=1;'); tw.arm(f.ctx); f.put('test/helper.cjs', 'exports.value=2;');
  f.put('value.test.cjs', testSource("test('helper',()=>a.equal(require('./test/helper.cjs').value,2));"));
  const r = tw.prove(f.ctx); a.equal(r.verdict, 'PROVEN'); a.deepEqual(r.witnessedChanges, ['test/helper.cjs']);
});
test('mixed repeated results from an external-state test are inconclusive', () => {
  const f = fixed(), counter = path.join(temp(), 'count.txt'); fs.writeFileSync(counter, '0');
  // Controlled negative fixture deliberately violates the trusted-test contract.
  f.put('value.test.cjs', testSource("test('flaky fixture',()=>{const p=" + JSON.stringify(counter) + ";const n=Number(fs.readFileSync(p));fs.writeFileSync(p,String(n+1));a.equal(n===2?2:require('./lib.cjs').value,2);});"));
  const r = tw.prove(f.ctx, { repeat: 3 }); a.equal(r.verdict, 'INCONCLUSIVE'); a.equal(r.reason, 'MIXED_REPETITIONS');
});
test('binary, command, cwd, environment, source drift and unsupported focus cannot yield PROVEN', () => {
  const base = { exitCode: 1, tests: [{ id: 'a', passed: false }], assertions: [{ id: 'a' }], passed: false, infrastructureFailure: false,
    cwdFingerprint: 'same', commandFingerprint: 'same', environmentFingerprint: 'same' };
  const pass = { ...base, exitCode: 0, tests: [{ id: 'a', passed: true }], assertions: [], passed: true };
  for (const k of ['cwdFingerprint', 'commandFingerprint', 'environmentFingerprint']) a.notEqual(tw.classify(base, { ...pass, [k]: 'different' }), 'PROVEN');
  const f = fixed(); let changed = false;
  const r = tw.prove(f.ctx, { progress: () => { if (!changed) { f.put('lib.cjs', 'exports.value=3;'); changed = true; } } });
  a.equal(r.verdict, 'INCONCLUSIVE'); a.equal(r.reason, 'SOURCE_ENVIRONMENT_OR_RUNTIME_MOVED');
  a.throws(() => tw.prove(f.ctx, { focus: 'lib.cjs' }), /FULL_WITNESS/);
  a.throws(() => tw.prove(f.ctx, { repeat: 0 }), /repeat/);
});

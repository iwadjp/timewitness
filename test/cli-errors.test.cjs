'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const path = require('node:path'), cp = require('node:child_process');
const { temp, write } = require('./fixtures.cjs');

const cli = path.resolve(__dirname, '../timewitness.cjs');
function run(cwd, args, env) {
  return cp.spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true, env });
}

// Usage errors must say what to do; only system errors keep the generic message.
test('CLI usage errors name the cause instead of one generic message', () => {
  const root = temp('tw-cli-errors-');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'lib/value.cjs', 'exports.value=1;\n');
  const env = { ...process.env, LOCALAPPDATA: path.join(temp(), 'state-root') };

  const noBaseline = run(root, ['prove'], env);
  a.equal(noBaseline.status, 1);
  a.match(noBaseline.stderr, /No armed v0\.1 baseline for this repo\/scope\./);
  const hint = /Scope defaults to the current directory/;
  a.match(noBaseline.stderr, hint);

  const armed = run(root, ['arm'], env);
  a.equal(armed.status, 0);
  a.doesNotMatch(armed.stdout + armed.stderr, hint);
  const fromSubdir = run(path.join(root, 'lib'), ['prove'], env);
  a.equal(fromSubdir.status, 1);
  a.match(fromSubdir.stderr, /No armed v0\.1 baseline/);
  a.match(fromSubdir.stderr, hint);
  a.ok(!fromSubdir.stderr.includes(root), 'hint must not print the local path');
  const showSubdir = run(path.join(root, 'lib'), ['show'], env);
  a.equal(showSubdir.status, 1);
  a.match(showSubdir.stderr, /No completed experiment/);
  a.match(showSubdir.stderr, hint);

  a.match(run(root, ['prove', '--repeat', '0'], env).stderr, /Option outside supported range/);
  a.match(run(root, ['arm', '--test', 'x'], env).stderr, /Test options require prove/);

  const system = run(root, ['prove', '--repo', path.join(root, 'missing')], env);
  a.equal(system.status, 1);
  a.match(system.stderr, /operation could not complete/);
  a.doesNotMatch(system.stderr, hint);
  a.ok(!system.stderr.includes(root), 'system errors must not print local paths');
});

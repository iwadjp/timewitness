'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { hash, slash, materialize, safeFile } = require('./capture.cjs');
const reporter = path.join(__dirname, 'reporter.cjs');

function environment(folder) {
  const env = {};
  // Deliberate allowlist: no credentials, parent test context, loaders, npm or Git routing.
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|TZ)$/i.test(key)) env[key] = value;
  }
  const temp = path.join(folder, '.timewitness-runtime');
  Object.assign(env, { HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp,
    TIMEWITNESS_WORLD: folder, NO_COLOR: '1' });
  return env;
}
function command(tests, timeoutMs) {
  return ['--test', '--test-isolation=none', '--test-concurrency=1', `--test-timeout=${timeoutMs}`,
    '--test-reporter=' + pathToFileURL(reporter).href, ...tests.map(n => './' + n)];
}
function runWorld(folder, files, tests, options = {}) {
  const prepStart = performance.now();
  materialize(folder, files);
  const runtime = path.join(folder, '.timewitness-runtime');
  if (fs.existsSync(runtime)) throw new Error('Reserved sandbox runtime path');
  fs.mkdirSync(runtime);
  const timeoutMs = options.timeoutMs ?? 15000;
  const env = options.env || environment(folder);
  const args = command(tests, timeoutMs);
  const environmentFingerprint = crypto.createHmac('sha256', options.key || 'standalone').update(JSON.stringify(env)).digest('hex');
  const preparationMs = performance.now() - prepStart;
  const start = performance.now();
  const result = cp.spawnSync(process.execPath, args, {
    cwd: folder, env, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: timeoutMs + 500, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const durationMs = performance.now() - start;
  const events = [];
  let parseError = false;
  for (const line of String(result.output?.[3] || '').split(/\r?\n/).filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      if (!['test:pass', 'test:fail', 'test:summary'].includes(row.type)) throw new Error('Invalid event');
      row.file = row.file ? slash(path.relative(folder, row.file)) : '';
      events.push(row);
    } catch { parseError = true; }
  }
  const outcomes = events.filter(e => ['test:pass', 'test:fail'].includes(e.type));
  const leaves = outcomes.filter(e => e.failureType !== 'subtestsFailed' && e.testType !== 'suite' && !e.fileWrapper);
  const executed = leaves.filter(e => !e.skip && !e.todo);
  const id = e => e.file + ' :: ' + crypto.createHmac('sha256', options.key || 'standalone').update(String(e.name)).digest('hex');
  const assertion = e => e.type === 'test:fail' && e.code === 'ERR_ASSERTION' && e.failureType === 'testCodeFailure';
  const assertions = leaves.filter(assertion);
  const reasons = [];
  if (result.error) reasons.push(result.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'RUNNER_ERROR');
  if (parseError) reasons.push('REPORTER_PROTOCOL_ERROR');
  if (!events.some(e => e.type === 'test:summary' && e.file === '')) reasons.push('INCOMPLETE_TEST_REPORT');
  if (!executed.length) reasons.push('NO_TESTS_DISCOVERED');
  if (outcomes.some(e => e.fileWrapper)) reasons.push('FILE_WITHOUT_EXPLICIT_TEST');
  if (outcomes.some(e => e.skip || e.todo)) reasons.push('SKIP_OR_TODO');
  if (outcomes.some(e => e.failureType === 'testTimeoutFailure' || e.failureType === 'cancelledByParent')) reasons.push('TIMEOUT_OR_CANCELLED');
  if (outcomes.some(e => e.type === 'test:fail' && e.failureType !== 'subtestsFailed' && !assertion(e))) reasons.push('SETUP_OR_NON_ASSERTION_FAILURE');
  if (result.status !== 0 && !assertions.length && !reasons.length) reasons.push('UNEXPLAINED_EXIT');
  // A test must not rewrite captured inputs, dependencies, or the common harness.
  const verifyStart = performance.now();
  let inputMutation = false;
  for (const [n, f] of Object.entries(files)) {
    try {
      const full = safeFile(folder, n), stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || hash(fs.readFileSync(full)) !== f.sha256
        || f.mode !== undefined && (stat.mode & 0o777) !== f.mode) inputMutation = true;
    } catch { inputMutation = true; }
  }
  if (inputMutation) reasons.push('INPUT_MUTATED_BY_TEST');
  const infrastructureFailure = reasons.length > 0;
  return {
    exitCode: result.status, signal: result.signal, durationMs, preparationMs,
    verificationMs: performance.now() - verifyStart,
    outcome: infrastructureFailure ? 'INCONCLUSIVE' : result.status === 0 ? 'PASS' : 'FAIL',
    passed: !infrastructureFailure && result.status === 0 && executed.length > 0 && !outcomes.some(e => e.type === 'test:fail'),
    infrastructureFailure, reasons: [...new Set(reasons)], environmentFingerprint,
    commandFingerprint: hash(JSON.stringify([process.execPath, ...args])),
    cwdFingerprint: hash(folder),
    tests: leaves.map(e => ({ id: id(e), passed: e.type === 'test:pass' && !e.skip && !e.todo, skip: !!e.skip, todo: !!e.todo })),
    assertions: assertions.map(e => ({ id: id(e) })),
    output: { stdoutBytes: Buffer.byteLength(result.stdout || ''), stderrBytes: Buffer.byteLength(result.stderr || ''), rawSaved: false },
  };
}
function signature(run) {
  return JSON.stringify({ exitCode: run.exitCode, tests: run.tests, reasons: run.reasons,
    assertions: run.assertions, infrastructureFailure: run.infrastructureFailure });
}
function classifyRuns(before, after) {
  const all = [...before, ...after];
  if (!before.length || before.length !== after.length) return { verdict: 'NOT_PROVEN', reason: 'INSUFFICIENT_EVIDENCE' };
  if (all.some(r => r.infrastructureFailure)) return { verdict: 'INCONCLUSIVE', reason: 'EXECUTION_INCONCLUSIVE' };
  if (before.some(r => signature(r) !== signature(before[0])) || after.some(r => signature(r) !== signature(after[0])))
    return { verdict: 'INCONCLUSIVE', reason: 'MIXED_REPETITIONS' };
  for (const key of ['environmentFingerprint', 'commandFingerprint', 'cwdFingerprint']) {
    if (new Set(all.map(r => r[key])).size !== 1) return { verdict: key === 'environmentFingerprint' ? 'INCONCLUSIVE' : 'NOT_PROVEN', reason: 'EXECUTION_CONDITIONS_DIFFER' };
  }
  if (all.some(r => new Set(r.tests.map(t => t.id)).size !== r.tests.length))
    return { verdict: 'INCONCLUSIVE', reason: 'AMBIGUOUS_TEST_IDENTITIES' };
  if (JSON.stringify(before[0].tests.map(t => t.id).sort()) !== JSON.stringify(after[0].tests.map(t => t.id).sort()))
    return { verdict: 'NOT_PROVEN', reason: 'TEST_DISCOVERY_DIFFERS' };
  if (!after[0].passed) return { verdict: 'NOT_PROVEN', reason: 'AFTER_FAILS' };
  if (before[0].passed) return { verdict: 'NOT_PROVEN', reason: 'BEFORE_ALSO_PASSES' };
  const passedIDs = new Set(after[0].tests.filter(t => t.passed).map(t => t.id));
  if (before[0].exitCode === 1 && before[0].assertions.length && before[0].assertions.every(t => passedIDs.has(t.id)))
    return { verdict: 'PROVEN', reason: 'REPEATED_ASSERTION_FAIL_TO_PASS' };
  return { verdict: 'NOT_PROVEN', reason: 'NO_MATCHED_ASSERTION_WITNESS' };
}
function classify(before, after, beforeAgain = before, afterAgain = after) {
  return classifyRuns([before, beforeAgain], [after, afterAgain]).verdict;
}
module.exports = { environment, command, runWorld, classifyRuns, classify, reporter };

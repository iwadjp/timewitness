'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const capture = require('./capture.cjs');
const runner = require('./runner.cjs');
const { hash, slash, safeFile, snapshot, diff, dependencies, saveNew, guard } = capture;
const testFile = name => /(?:^|\/)(?:test|tests)\/.*\.[cm]?js$|\.(?:test|spec)\.[cm]?js$/i.test(name);
const executableTest = name => /\.(?:test|spec)\.[cm]?js$|(?:^|\/)test-[^/]+\.[cm]?js$/i.test(name);
const newId = () => new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
const depSummary = d => { const { files, ...summary } = d; return summary; };
const hashes = files => Object.fromEntries(Object.entries(files).map(([n, f]) => [n, { sha256: f.sha256, mode: f.mode }]));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function runtime() {
  return { node: process.version, platform: process.platform, arch: process.arch,
    nodeSha256: hash(fs.readFileSync(process.execPath)), reporterSha256: hash(fs.readFileSync(runner.reporter)) };
}
function arm(ctx) {
  const start = performance.now(), initialGuard = guard(ctx);
  const captured = snapshot(ctx), deps = dependencies(ctx, captured);
  const repeated = snapshot(ctx), repeatedDeps = dependencies(ctx, repeated);
  if (diff(captured.files, repeated.files).length || !equal(captured.omitted, repeated.omitted)
    || !equal(depSummary(deps), depSummary(repeatedDeps)) || !equal(initialGuard, guard(ctx)))
    throw new Error('Working state moved during arm. Stop concurrent edits and arm again.');
  if (!Object.keys(captured.files).length) throw new Error('No eligible files in scope');
  const session = { version: 2, id: newId(), createdAt: new Date().toISOString(), scope: ctx.scope,
    head: initialGuard.head, ...captured, dependency: depSummary(deps),
    elapsedMs: performance.now() - start };
  saveNew(path.join(ctx.home, 'sessions', session.id + '.json'), session);
  return session;
}
function latest(ctx) {
  const folder = path.join(ctx.home, 'sessions');
  const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith('.json')).sort() : [];
  if (!names.length) throw new Error('No armed v0.1 baseline for this repo/scope. Run arm first.');
  const session = JSON.parse(fs.readFileSync(path.join(folder, names.at(-1)), 'utf8'));
  if (session.version !== 2) throw new Error('Baseline format changed. Run arm again.');
  return session;
}
function selectTests(ctx, files, changed, options) {
  const normalize = name => {
    const normalized = slash(path.relative(ctx.root, safeFile(ctx.root, name)));
    return Object.keys(files).find(n => process.platform === 'win32' ? n.toLowerCase() === normalized.toLowerCase() : n === normalized) || normalized;
  };
  return [...new Set(options.tests?.length ? options.tests.map(normalize) : changed.filter(n => executableTest(n) && files[n]))].sort();
}
function prove(ctx, options = {}) {
  const start = performance.now();
  const repeat = options.repeat ?? 2, timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('--repeat must be 1..10');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600000) throw new Error('--timeout-ms must be 50..600000');
  if (options.maxFiles !== undefined || options.focus !== undefined) throw new Error('v0.1 supports FULL_WITNESS only');
  const baseline = latest(ctx), initialGuard = guard(ctx), runId = newId();
  const out = path.join(ctx.home, 'runs', runId);
  fs.mkdirSync(out, { recursive: true });
  const report = { version: 2, runId, baselineId: baseline.id, createdAt: new Date().toISOString(),
    mode: 'FULL_WITNESS', scope: ctx.scope, head: initialGuard.head, baselineAt: baseline.createdAt,
    verdict: 'INCONCLUSIVE', reason: 'NOT_STARTED', repeat, timeoutMs, tests: [], changed: [], witnessedChanges: [],
    transplanted: [], before: [], after: [], environment: {}, safety: {}, timings: {},
    privacy: { rawLogsSaved: false, testNames: 'HMAC', environmentValuesSaved: false,
      sourceInReport: false, snapshots: 'PRIVATE_LOCAL_SOURCE_COPIES_RETAINED', networkByTimewitness: false },
    evidencePath: 'runs/' + runId + '/report.json' };
  const finish = () => {
    report.timings.armMs = baseline.elapsedMs;
    const runs = [...report.before, ...report.after];
    report.timings.sandboxPreparationMs = runs.reduce((n, r) => n + r.preparationMs, 0);
    report.timings.beforeTestMs = report.before.reduce((n, r) => n + r.durationMs, 0);
    report.timings.afterTestMs = report.after.reduce((n, r) => n + r.durationMs, 0);
    report.timings.inputVerificationMs = runs.reduce((n, r) => n + r.verificationMs, 0);
    report.timings.cleanupMs = 0;
    report.timings.cleanupPolicy = 'RETAIN_NO_DELETION';
    report.timings.proveMs = performance.now() - start;
    report.timings.overheadMs = report.timings.proveMs - report.timings.beforeTestMs - report.timings.afterTestMs;
    const writing = performance.now();
    saveNew(path.join(out, 'report.json'), report);
    fs.writeFileSync(path.join(out, 'handoff.txt'), render(report), { flag: 'wx', mode: 0o600 });
    // Persist final accounting in a separate small file; include report I/O in CLI timings.
    report.timings.reportWriteMs = performance.now() - writing;
    report.timings.totalMs = performance.now() - start;
    saveNew(path.join(out, 'timing.json'), report.timings);
    return report;
  };
  try {
    const current = snapshot(ctx), deps = dependencies(ctx, current), identity = runtime();
    const changed = diff(baseline.files, current.files), tests = selectTests(ctx, current.files, changed, options);
    Object.assign(report, { tests, changed, currentHashes: hashes(current.files),
      omitted: current.omitted, environment: { ...depSummary(deps), runtime: identity,
        policy: 'ALLOWLIST_NO_PARENT_TEST_CONTEXT_OR_LOADERS', cwd: 'SAME_ABSOLUTE_SANDBOX_PATH_EVERY_RUN',
        lockfileSame: equal(baseline.dependency.manifestHashes, deps.manifestHashes),
        dependencySame: baseline.dependency.digest === deps.digest, commandSame: true,
        command: ['node', '--test', '--test-isolation=none', '--test-concurrency=1', '--test-timeout=' + timeoutMs,
          '--test-reporter=<timewitness-reporter-file-url>', ...tests.map(n => './' + n)] } });
    if (baseline.head !== initialGuard.head) { report.reason = 'HEAD_CHANGED_SINCE_ARM'; return finish(); }
    if (baseline.omitted.length || current.omitted.length) {
      report.reason = 'SANDBOX_INPUTS_OMITTED'; report.baselineOmitted = baseline.omitted; return finish();
    }
    if (deps.state !== 'EXISTING_ENV' || baseline.dependency.state !== 'EXISTING_ENV'
      || !report.environment.lockfileSame || !report.environment.dependencySame) {
      report.environment.state = 'ENVIRONMENT_NOT_REPRODUCED';
      report.reason = 'DEPENDENCY_OR_MANIFEST_CHANGED_OR_UNAVAILABLE'; return finish();
    }
    if (!tests.length || tests.some(n => !current.files[n] || !/\.[cm]?js$/i.test(n))) {
      report.reason = 'TEST_DISCOVERY_FAILURE'; return finish();
    }
    // Only explicitly selected tests are transplanted. Helpers remain witnessed inputs.
    // Copying all test/ helpers would silently hide production edits in those paths.
    report.transplanted = tests;
    const beforeFiles = { ...baseline.files };
    for (const name of tests) beforeFiles[name] = current.files[name];
    report.witnessedChanges = diff(beforeFiles, current.files);
    if (!report.witnessedChanges.length) {
      report.verdict = 'NOT_PROVEN'; report.reason = 'NO_WITNESSED_CHANGES'; return finish();
    }
    const stable = snapshot(ctx), stableDeps = dependencies(ctx, stable);
    if (diff(current.files, stable.files).length || !equal(current.omitted, stable.omitted)
      || !equal(depSummary(deps), depSummary(stableDeps)) || !equal(initialGuard, guard(ctx))) {
      report.reason = 'SOURCE_MOVED_DURING_CAPTURE'; return finish();
    }
    const folder = path.join(out, 'world'), env = runner.environment(folder), key = crypto.randomBytes(32);
    let archivalMs = 0;
    // Reuse the exact absolute cwd and environment; move completed copies aside, never delete.
    for (let i = 0; i < repeat; i++) {
      for (const [label, files] of [['before', beforeFiles], ['after', current.files]]) {
        options.progress?.(label.toUpperCase() + ' ' + (i + 1) + '/' + repeat);
        const result = runner.runWorld(folder, { ...files, ...deps.files }, tests, { env, key, timeoutMs });
        report[label].push(result);
        const moveStart = performance.now();
        if (!capture.inside(out, folder) || path.basename(folder) !== 'world') throw new Error('Unsafe sandbox archival path');
        fs.renameSync(folder, path.join(out, label + '-' + (i + 1)));
        archivalMs += performance.now() - moveStart;
      }
    }
    report.timings.archivalMs = archivalMs;
    Object.assign(report, runner.classifyRuns(report.before, report.after));
    const finalCapture = snapshot(ctx), finalDeps = dependencies(ctx, finalCapture), finalGuard = guard(ctx);
    report.safety = { gitStateUnchanged: equal(initialGuard, finalGuard),
      capturedSourceUnchanged: !diff(current.files, finalCapture.files).length && equal(current.omitted, finalCapture.omitted),
      dependencyUnchanged: equal(depSummary(deps), depSummary(finalDeps)),
      runtimeUnchanged: equal(identity, runtime()) };
    if (Object.values(report.safety).some(v => !v)) {
      report.verdict = 'INCONCLUSIVE'; report.reason = 'SOURCE_ENVIRONMENT_OR_RUNTIME_MOVED';
    }
    report.environment.fingerprint = report.before[0]?.environmentFingerprint;
    report.environment.commandFingerprint = report.before[0]?.commandFingerprint;
    report.environment.cwdFingerprint = report.before[0]?.cwdFingerprint;
    report.environment.testBytes = Object.fromEntries(tests.map(n => [n, current.files[n].sha256]));
  } catch (error) {
    // Do not print arbitrary error messages: they can contain source, secrets or absolute paths.
    report.verdict = 'INCONCLUSIVE';
    report.reason = /CAPTURE_LIMIT|SOURCE_MOVED|Unsafe relative|Reserved sandbox/.test(error.message)
      ? error.message.replace(/[^A-Za-z_ ]/g, '').toUpperCase().replaceAll(' ', '_') : 'SANDBOX_REPRODUCTION_FAILED';
  }
  return finish();
}
function render(report) {
  const count = runs => {
    if (!runs.length) return 'NOT RUN';
    const kinds = [...new Set(runs.map(r => r.outcome))];
    return kinds.length === 1 ? kinds[0] + ' ' + runs.length + '/' + report.repeat
      : 'MIXED (' + runs.map(r => r.outcome).join(', ') + ')';
  };
  return [
    'TIMEWITNESS: ' + report.verdict, '',
    'Before: ' + count(report.before), 'After : ' + count(report.after), '',
    'Witnessed changes (whole set):',
    ...report.witnessedChanges.slice(0, 12).map(n => '- ' + n),
    ...(report.witnessedChanges.length > 12 ? ['- ... see report'] : []),
    'Test: ' + (report.tests.join(', ') || '(none discovered)'),
    'Environment: ' + (report.environment.state || 'UNKNOWN')
      + (report.environment.lockfileSame ? ' / same manifests' : '')
      + (report.before.length ? ' / same command / same cwd' : ''),
    'Reason: ' + report.reason,
    'Evidence: ' + report.evidencePath,
  ].join('\n') + '\n';
}
function latestReport(ctx) {
  const root = path.join(ctx.home, 'runs');
  const names = fs.existsSync(root) ? fs.readdirSync(root).sort().reverse() : [];
  const name = names.find(n => fs.existsSync(path.join(root, n, 'report.json')));
  if (!name) throw new Error('No completed experiment. Run prove first.');
  return JSON.parse(fs.readFileSync(path.join(root, name, 'report.json'), 'utf8'));
}
function freshness(ctx, report) {
  if (!report.currentHashes) return { status: 'UNKNOWN', changed: [] };
  const current = snapshot(ctx), deps = dependencies(ctx, current);
  const changed = diff(report.currentHashes, current.files);
  return { status: changed.length || capture.head(ctx.root) !== report.head
    || deps.digest !== report.environment.digest || !equal(deps.manifestHashes, report.environment.manifestHashes)
    || !equal(current.omitted, report.omitted) || !equal(runtime(), report.environment.runtime) ? 'STALE' : 'CURRENT', changed };
}
function copy(text) {
  if (process.platform !== 'win32') throw new Error('--copy requires Windows');
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))"],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
module.exports = { ...capture, ...runner, arm, latest, prove, render, latestReport, freshness, copy, testFile, executableTest };

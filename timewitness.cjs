#!/usr/bin/env node
'use strict';
const path = require('node:path');
const tw = require('./lib.cjs');
const help = [
  'Timewitness v0.1: prove that the same test fails before and passes after a fix.',
  '',
  '  node timewitness.cjs arm   [--repo <directory>] [--scope <repo-relative-directory>]...',
  '  node timewitness.cjs prove [--repo <directory>] [--test <repo-relative-file>] [--repeat 2]',
  '  node timewitness.cjs show  [--repo <directory>]',
  '',
  'Run arm before editing; prove after the fix and regression test.',
  '--scope is repeatable (default: the current directory) to capture only the given',
  'repo-relative directories -- e.g. separate source and test directories -- without',
  'pulling in unrelated parts of the repository. Dependency/manifest reproduction',
  'always checks the repo root regardless of scope.',
  '--test is repeatable and always repo-relative; otherwise selects new/changed *.test.* / *.spec.*.',
  '--timeout-ms 50..600000 (default 15000); --repeat 1..10 (default 2).',
  '--json returns the report; --copy copies the short summary on Windows.',
  'FULL_WITNESS only. Exit: PROVEN=0, NOT_PROVEN=2, INCONCLUSIVE=3, usage=1.',
  '',
  'Executed directly, without a shell:',
  '  <this Node binary> --test --test-isolation=none --test-concurrency=1',
  '    --test-timeout=<ms> --test-reporter=<Timewitness file URL> ./<selected test> ...',
  '',
  'Requires Windows, Git, Node >=24. No install, npm scripts, network API or Git writes.',
  'Only run TRUSTED tests without persistent children, external file/service access',
  'or network writes. Copies are NOT an OS security sandbox.',
  'Private source copies are retained. Raw stdout/stderr are never saved.', '',
].join('\n');
function main(argv) {
  const [command, ...args] = argv;
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(help); return; }
  if (!['arm', 'prove', 'show'].includes(command)) throw new Error('Unknown command; use --help');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required');
  const options = { tests: [], scope: [] }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--test', '--scope'].includes(key) && seen.has(key)) throw new Error('Duplicate option');
    seen.add(key);
    if (['--copy', '--json'].includes(key)) { options[key.slice(2)] = true; continue; }
    if (!['--repo', '--scope', '--test', '--repeat', '--timeout-ms'].includes(key)) throw new Error('Unknown option; use --help');
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing option value');
    if (key === '--test') options.tests.push(value);
    else if (key === '--scope') options.scope.push(value);
    else if (key === '--repeat' || key === '--timeout-ms') {
      const n = Number(value), repeat = key === '--repeat';
      if (!Number.isInteger(n) || n < (repeat ? 1 : 50) || n > (repeat ? 10 : 600000)) throw new Error('Option outside supported range');
      options[repeat ? 'repeat' : 'timeoutMs'] = n;
    } else options[key.slice(2)] = value;
  }
  if (command !== 'prove' && (options.tests.length || options.repeat !== undefined || options.timeoutMs !== undefined))
    throw new Error('Test options require prove');
  const ctx = tw.context(options.repo, options.scope.length ? options.scope : undefined);
  const localHome = '%LOCALAPPDATA%/Timewitness/v01/' + path.basename(ctx.home);
  if (command === 'arm') {
    const baseline = tw.arm(ctx);
    const summary = { status: 'ARMED', id: baseline.id, scope: baseline.scope, files: Object.keys(baseline.files).length,
      bytes: baseline.bytes, elapsedMs: baseline.elapsedMs, dependency: baseline.dependency,
      omitted: baseline.omitted, evidenceHome: localHome };
    process.stdout.write(options.json ? JSON.stringify(summary, null, 2) + '\n'
      : 'ARMED / ' + summary.files + ' files / ' + Math.round(summary.elapsedMs) + ' ms\n'
        + 'Environment: ' + baseline.dependency.state + ' / ' + baseline.dependency.kind + '\n'
        + (baseline.omitted.length ? 'Uncaptured inputs: ' + baseline.omitted.length + ' (prove will be INCONCLUSIVE)\n' : '')
        + 'Now edit normally, add the regression test, then run prove.\n');
    return;
  }
  const report = command === 'prove' ? tw.prove(ctx, { ...options,
    progress: options.json ? undefined : message => process.stderr.write(message + '\n') }) : tw.latestReport(ctx);
  const fresh = tw.freshness(ctx, report);
  const output = tw.render(report) + 'Evidence home: ' + localHome + '\n'
    + (fresh.status !== 'CURRENT' ? 'Freshness: ' + fresh.status + '\n' : '');
  if (options.copy) tw.copy(output);
  process.stdout.write(options.json ? JSON.stringify({ ...report, freshness: fresh, evidenceHome: localHome }, null, 2) + '\n' : output);
  if (command === 'prove') process.exitCode = report.verdict === 'PROVEN' ? 0 : report.verdict === 'NOT_PROVEN' ? 2 : 3;
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('Timewitness: operation could not complete. Check --help, repository/scope, baseline and local storage.\n'); process.exitCode = 1; }
}
module.exports = { main };

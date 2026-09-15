'use strict';
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tw = require('../lib.cjs');

test('a passing control does not turn a skipped test run into PASS', () => {
  const source = "const {test}=require('node:test');test.skip('not executed',()=>{});test('executed control',()=>{});";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-partial-skip-'));
  const run = tw.runWorld(path.join(root, 'world'), {
    'partial.test.cjs': { content: Buffer.from(source).toString('base64'), sha256: tw.hash(source) },
  }, ['partial.test.cjs']);
  a.equal(run.passed, false, 'a skip-containing run must never be treated as PASS');
});

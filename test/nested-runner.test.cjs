'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tw = require('../lib.cjs');

test('a nested experiment executes its test instead of silently skipping it', () => {
  const source = "require('node:test').test('actual child test',()=>require('node:assert/strict').equal(2+2,4));";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timewitness-nested-'));
  const result = tw.runWorld(path.join(root, 'world'), {
    'child.test.cjs': { content: Buffer.from(source).toString('base64'), sha256: tw.hash(source) },
  }, ['child.test.cjs']);
  assert.equal(result.passed, true, 'the child test must really execute');
  assert.equal(result.tests.length, 1);
  assert.match(result.tests[0].id, /^child\.test\.cjs :: [a-f0-9]+$/);
});

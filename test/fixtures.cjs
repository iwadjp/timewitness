'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto'), zlib = require('node:zlib');
const tw = require('../lib.cjs');
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tw-v01-test-'));
function write(root, name, content) {
  const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content);
}
function fixture() {
  const root = temp('tw v01 space ');
  cp.execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  write(root, 'lib.cjs', 'exports.value=1;\n');
  const ctx = tw.context(root); ctx.home = path.join(temp(), 'state');
  return { root, ctx, put: (name, text) => write(root, name, text) };
}
const testSource = body => "const {test,before,after,describe}=require('node:test');const a=require('node:assert/strict');const fs=require('node:fs');" + body;
const valueTest = testSource("test('value',()=>a.equal(require('./lib.cjs').value,2));");
function fixed() {
  const f = fixture(); tw.arm(f.ctx); f.put('lib.cjs', 'exports.value=2;\n'); f.put('value.test.cjs', valueTest); return f;
}
function file(content) { return { content: Buffer.from(content).toString('base64'), sha256: tw.hash(content) }; }
function git(root, args) { return cp.execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', windowsHide: true }); }

// Construct immutable Git-object/index fixture bytes. No add/stage/commit/checkout
// commands, and no writes to the caller's repository or index.
function indexedFixture() {
  const f = fixture(), dotgit = path.join(f.root, '.git');
  const sha = b => crypto.createHash('sha1').update(b).digest();
  const object = (type, content) => {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = Buffer.concat([Buffer.from(type + ' ' + body.length + '\0'), body]);
    const id = sha(packed).toString('hex');
    write(dotgit, 'objects/' + id.slice(0, 2) + '/' + id.slice(2), zlib.deflateSync(packed)); return id;
  };
  const initial = { 'mixed.cjs': 'exports.value=0;\n', 'staged.txt': 'old\n', 'unstaged.txt': 'old\n',
    'deleted.txt': 'delete fixture\n', 'old-name.txt': 'rename fixture\n', 'binary.dat': Buffer.from([0, 255, 1, 128]),
    'line endings.txt': 'a\r\nb\r\n', 'large.dat': Buffer.alloc(2 * 1024 * 1024, 42) };
  const entries = Object.entries(initial).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const tree = Buffer.concat(entries.map(([name, text]) => Buffer.concat([Buffer.from('100644 ' + name + '\0'), Buffer.from(object('blob', text), 'hex')])));
  const treeId = object('tree', tree);
  const commitId = object('commit', 'tree ' + treeId + '\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n');
  write(dotgit, 'HEAD', 'ref: refs/heads/fixture\n'); write(dotgit, 'refs/heads/fixture', commitId + '\n');
  const staged = { ...initial, 'mixed.cjs': 'exports.value=1;\n', 'staged.txt': 'staged\n', 'added.txt': 'added\n' };
  // Rename fixture represented as an index add/remove, without deleting any real file.
  const indexEntries = Object.entries(staged).filter(([n]) => n !== 'old-name.txt');
  indexEntries.push(['new-name.txt', initial['old-name.txt']]);
  indexEntries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const chunks = [];
  for (const [name, text] of indexEntries) {
    const filename = Buffer.from(name), entry = Buffer.alloc(Math.ceil((62 + filename.length + 1) / 8) * 8);
    entry.writeUInt32BE(0o100644, 24); entry.writeUInt32BE(Buffer.byteLength(text), 36);
    Buffer.from(object('blob', text), 'hex').copy(entry, 40); entry.writeUInt16BE(filename.length, 60); filename.copy(entry, 62);
    chunks.push(entry);
    if (name !== 'deleted.txt') f.put(name, text);
  }
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(chunks.length, 8);
  const index = Buffer.concat([header, ...chunks]); write(dotgit, 'index', Buffer.concat([index, sha(index)]));
  f.put('mixed.cjs', 'exports.value=2;\n'); f.put('unstaged.txt', 'unstaged\n'); f.put('untracked.txt', 'untracked\n');
  f.ctx = tw.context(f.root); f.ctx.home = path.join(temp(), 'state');
  return f;
}
module.exports = { temp, write, fixture, fixed, file, git, testSource, valueTest, indexedFixture };

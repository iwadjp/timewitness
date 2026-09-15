'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const sourceLimit = { bytes: 64 * 1024 * 1024, count: 2000 };
const dependencyLimit = { bytes: 128 * 1024 * 1024, count: 12000 };
const excluded = /(^|\/)(?:private-data|coverage|dist|build|evidence)(?:\/|$)|(^|\/)(?:\.npmrc|\.env(?:\.[^/]+)?|[^/]+\.(?:pem|key|pfx))$/i;
const manifests = /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt)$/i;

function git(root, args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(?!OPTIONAL_LOCKS$)/i.test(key)) delete env[key];
  return cp.execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[:\0\r\n]/.test(relative)
    || relative.split(/[\\/]/).some(p => p === '..' || /^\.git$/i.test(p)
      || /[. ]$/.test(p) && p !== '.' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error('Unsafe relative path');
  }
  const target = path.resolve(root, relative);
  if (!inside(root, target) || target === root) throw new Error('Path escapes scope or names its root');
  return target;
}
function context(repo = process.cwd(), scope) {
  const requested = fs.realpathSync(path.resolve(repo));
  const root = fs.realpathSync(git(requested, ['rev-parse', '--show-toplevel']).trim());
  const given = scope == null ? [] : Array.isArray(scope) ? scope : [scope];
  const scopes = [...new Set(given.length ? given : [slash(path.relative(root, requested)) || '.'])].sort();
  const directories = scopes.map(s => {
    const dir = fs.realpathSync(s === '.' ? root : path.resolve(root, s));
    if (!inside(root, dir) || fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim()) !== root)
      throw new Error('Scope crosses a Git repository boundary');
    return dir;
  });
  const key = hash((process.platform === 'win32' ? root.toLowerCase() : root) + '\0' + scopes.join('\0')).slice(0, 20);
  const home = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'Timewitness', 'v01', key);
  if (inside(root, home)) throw new Error('Timewitness storage must be outside the source repository');
  return { root, directories, scope: scopes.join(','), home, head: head(root) };
}
function head(root) {
  try { return git(root, ['rev-parse', '--verify', 'HEAD']).trim(); } catch { return null; }
}
function guard(ctx) {
  const index = path.resolve(ctx.root, git(ctx.root, ['rev-parse', '--git-path', 'index']).trim());
  return { head: head(ctx.root), index: fs.existsSync(index) ? hash(fs.readFileSync(index)) : null,
    status: hash(git(ctx.root, ['status', '--porcelain=v1', '--untracked-files=all'])) };
}
function boundary(root, full) {
  let cursor = full;
  while (cursor !== root) {
    if (fs.lstatSync(cursor).isSymbolicLink()) return 'LINK_OR_JUNCTION';
    if (fs.lstatSync(cursor).isDirectory() && fs.existsSync(path.join(cursor, '.git'))) return 'NESTED_REPOSITORY';
    cursor = path.dirname(cursor);
  }
  return null;
}
function readItem(full, budget, limit) {
  const stat = fs.statSync(full);
  if (++budget.count > limit.count || (budget.bytes += stat.size) > limit.bytes) throw new Error('CAPTURE_LIMIT_EXCEEDED');
  const content = fs.readFileSync(full);
  const after = fs.statSync(full);
  if (stat.size !== content.length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
    throw new Error('SOURCE_MOVED_DURING_CAPTURE');
  return { sha256: hash(content), content: content.toString('base64'), mode: stat.mode & 0o777 };
}
function snapshot(ctx) {
  const names = git(ctx.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  const files = {}, omitted = [], budget = { bytes: 0, count: 0 };
  for (const name of [...new Set(names)].sort()) {
    const full = safeFile(ctx.root, name);
    if (!ctx.directories.some(d => inside(d, full))) continue;
    const relative = slash(path.relative(ctx.root, full));
    if (/^node_modules(?:\/|$)/.test(relative)) continue;
    if (/(^|\/)node_modules(?:\/|$)/.test(relative)) { omitted.push({ path: relative, reason: 'NESTED_DEPENDENCY_UNSUPPORTED' }); continue; }
    if (excluded.test(relative)) { omitted.push({ path: relative, reason: 'EXCLUDED_PRIVATE_OR_OUTPUT' }); continue; }
    try { fs.lstatSync(full); } catch (error) {
      if (error.code === 'ENOENT') continue; // working-tree deletion, regardless of index contents
      throw error;
    }
    const problem = boundary(ctx.root, full);
    if (problem || !fs.statSync(full).isFile()) { omitted.push({ path: relative, reason: problem || 'NON_FILE_BOUNDARY' }); continue; }
    files[relative] = readItem(full, budget, sourceLimit);
  }
  // Ignored runtime/config files are not silently treated as reproduced.
  const ignored = git(ctx.root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0').filter(Boolean);
  for (const name of ignored) {
    const full = path.resolve(ctx.root, name);
    if (!ctx.directories.some(d => inside(d, full))) continue;
    const relative = slash(path.relative(ctx.root, full));
    if (relative === 'node_modules' || relative.startsWith('node_modules/')) continue;
    omitted.push({ path: relative, reason: 'IGNORED_INPUT_NOT_CAPTURED' });
  }
  return { files, omitted, bytes: budget.bytes };
}
function diff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(n => before[n]?.sha256 !== after[n]?.sha256 || before[n]?.mode !== after[n]?.mode);
}
// Dependency reproduction always anchors at the repo root's own manifests/node_modules,
// independent of --scope: v0.1 only ever supports a single non-workspace root package.json,
// so a scope that excludes the root must not silently skip lockfile/manifest drift detection.
function readRootManifests(ctx, budget) {
  const out = {};
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const full = path.join(ctx.root, name);
    let stat; try { stat = fs.lstatSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    out[name] = readItem(full, budget, dependencyLimit);
  }
  return out;
}
function dependencies(ctx, capture) {
  const files = {}, reasons = [], budget = { bytes: 0, count: 0 };
  const manifestFiles = { ...readRootManifests(ctx, budget), ...Object.fromEntries(Object.entries(capture.files).filter(([n]) => manifests.test(n))) };
  const manifestHashes = Object.fromEntries(Object.entries(manifestFiles).map(([n, f]) => [n, f.sha256]));
  let declared = false;
  for (const [name, f] of Object.entries(manifestFiles)) {
    if (!/(^|\/)package\.json$/.test(name)) continue;
    try {
      const pkg = JSON.parse(Buffer.from(f.content, 'base64'));
      if (name !== 'package.json' || pkg.workspaces) reasons.push('WORKSPACE_OR_NESTED_PACKAGE_UNSUPPORTED');
      declared ||= ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(k => Object.keys(pkg[k] || {}).length);
    } catch { reasons.push('INVALID_PACKAGE_JSON'); }
  }
  if (Object.keys(manifestHashes).some(n => /(?:pnpm-lock\.yaml|yarn\.lock)$/.test(n))) reasons.push('NON_NPM_LOCKFILE_UNSUPPORTED');
  const modules = path.join(ctx.root, 'node_modules');
  const exists = fs.existsSync(modules);
  const walk = (dir) => {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('DEPENDENCY_LINK_UNSUPPORTED');
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error('DEPENDENCY_LINK_UNSUPPORTED');
      if (item.name === '.git' || item.name.endsWith('.node')) throw new Error('NATIVE_OR_REPOSITORY_DEPENDENCY_UNSUPPORTED');
      if (item.isDirectory()) walk(full);
      else if (item.isFile()) files[slash(path.relative(ctx.root, full))] = readItem(full, budget, dependencyLimit);
      else throw new Error('DEPENDENCY_NON_FILE');
    }
  };
  if (exists) {
    try { walk(modules); } catch (error) { reasons.push(error.message); }
    if (declared && !budget.count) reasons.push('NODE_MODULES_EMPTY');
  } else if (declared) reasons.push('NODE_MODULES_MISSING');
  const digest = hash(JSON.stringify(Object.entries(files).map(([n, f]) => [n, f.sha256, f.mode])));
  return { state: reasons.length ? 'ENVIRONMENT_NOT_REPRODUCED' : 'EXISTING_ENV',
    kind: exists ? 'COPIED_NODE_MODULES' : 'NODE_BUILTINS_ONLY', manifestHashes, digest,
    bytes: budget.bytes, count: budget.count, reasons: [...new Set(reasons)], files };
}
function saveNew(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
function materialize(folder, files) {
  if (fs.existsSync(folder)) throw new Error('Sandbox path already exists');
  fs.mkdirSync(folder, { recursive: true });
  for (const [name, item] of Object.entries(files)) {
    const target = safeFile(folder, name), content = Buffer.from(item.content, 'base64');
    if (hash(content) !== item.sha256) throw new Error('Corrupt snapshot');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx', mode: item.mode });
    if (item.mode !== undefined) fs.chmodSync(target, item.mode);
  }
}
module.exports = { hash, slash, git, inside, safeFile, context, head, guard, snapshot, diff, dependencies, saveNew, materialize };

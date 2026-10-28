import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only project-local, owner-private, binary-bound disposable services are allowed. */
export function assertPrivateFixtureRoot(root: unknown): asserts root is string {
  assert.ok(typeof root === 'string');
  assert.ok(root && isAbsolute(root));
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const workspace = dirname(project);
  const physical = realpathSync(root);
  assert.equal(physical, root, 'symlinked fixture roots are not accepted');
  const allowed = [resolve(workspace, '.artifacts'), resolve(workspace, 'privchat-server/.artifacts')];
  assert.ok(allowed.some(parent => {
    const child = relative(parent, physical);
    return child && !child.startsWith('..') && !isAbsolute(child);
  }), 'fixture must be inside project artifacts');
  assert.match(basename(physical), /^privchat-features-im\.[A-Za-z0-9]+$/);
  assert.equal(statSync(physical).mode & 0o077, 0, 'private disposable root required');
  const fixture = JSON.parse(readFileSync(`${physical}/public.json`, 'utf8'));
  assert.equal(fixture.root, physical);
  assert.equal(fixture.host, '127.0.0.1');
  assert.match(fixture.database, /^privchat_features_[a-z0-9_]+$/);
  for (const key of ['wsPort', 'tcpPort', 'quicPort', 'filePort', 'adminPort', 'redisPort']) {
    assert.ok(Number.isInteger(fixture[key]) && fixture[key] >= 30000 && fixture[key] <= 60005);
  }
  const expected = readFileSync(`${physical}/binary.sha256`, 'utf8').split(/\s+/)[0];
  assert.ok(expected);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(readFileSync(`${physical}/server-bin`)).digest('hex'), expected);
}

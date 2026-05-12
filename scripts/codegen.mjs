#!/usr/bin/env node
// Run `flatc --ts` over the canonical FlatBuffers schemas in privchat-protocol.
//
// Schemas are NOT vendored into this package — we read them directly from
// the sibling `privchat-protocol/protocol/` checkout. This keeps the wire
// format single-sourced; any drift becomes a compile-time error here when
// `prebuild` runs.
//
// Layout assumption (current monorepo style):
//
//     <parent>/
//     ├── privchat-protocol/protocol/*.fbs   ← source of truth
//     └── privchat-sdk-typescript/           ← this package
//
// Downstream npm consumers are unaffected — they install the published
// `dist/` (already-generated TS), never the .fbs files.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, '..', '..', 'privchat-protocol', 'protocol');
const OUT_DIR = resolve(__dirname, '..', 'src', 'generated');

if (!existsSync(SCHEMA_DIR)) {
  console.error(`privchat-protocol schemas not found at: ${SCHEMA_DIR}`);
  console.error('');
  console.error('This package consumes FlatBuffers schemas directly from a sibling');
  console.error('clone of privchat-protocol. Clone it next to privchat-sdk-typescript:');
  console.error('');
  console.error('    cd $(dirname $(pwd))');
  console.error('    git clone <privchat-protocol repo url>');
  console.error('');
  process.exit(1);
}

const schemas = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.fbs'))
  .sort()
  .map((f) => resolve(SCHEMA_DIR, f));

if (schemas.length === 0) {
  console.error(`no .fbs files found in ${SCHEMA_DIR}`);
  process.exit(1);
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const args = ['--ts', '--gen-all', '-I', SCHEMA_DIR, '-o', OUT_DIR, ...schemas];
console.log(`flatc ${args.join(' ')}`);
const result = spawnSync('flatc', args, { stdio: 'inherit' });

if (result.error) {
  console.error(
    'Failed to spawn flatc. Install via `brew install flatbuffers` or https://github.com/google/flatbuffers/releases',
  );
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`flatc exited with status ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`Generated ${schemas.length} TS schema(s) → ${OUT_DIR}`);

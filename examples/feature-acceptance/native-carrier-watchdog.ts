import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export class CarrierFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CarrierFailure'; }
}

// SDK request timeouts do not bound connect/auth/disconnect or the overall workflow.
export async function bounded<T>(operation: string, work: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new CarrierFailure('RUN_ABORTED');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CarrierFailure(`${operation}_TIMEOUT`)), ms);
        abort = () => reject(new CarrierFailure('RUN_ABORTED'));
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

function privateBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 262144);
    assert.equal(stat.uid, process.getuid!());
    assert.equal(stat.mode & 0o077, 0);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function validateExchange(path: string, pid: number, readyHash?: string): void {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid!());
  assert.equal(stat.mode & 0o777, 0o700);
  assert.equal(realpathSync(path), path);
  assert.equal(privateBytes(join(path, 'broker.lock')).toString(), String(pid));
  if (readyHash) assert.equal(createHash('sha256').update(privateBytes(join(path, 'peer-ready.json'))).digest('hex'), readyHash);
}

// The CLI anchors applications to the explicitly selected simulator device before calling this.
export function findMovedExchange(applications: string, name: string, pid: number, readyHash: string): string {
  const candidates = readdirSync(applications).filter(value => /^[A-Fa-f0-9-]+$/.test(value))
    .map(value => join(applications, value, 'Documents', name)).filter(path => {
      try { validateExchange(path, pid, readyHash); return true; } catch { return false; }
    });
  if (candidates.length !== 1) throw new CarrierFailure('EXCHANGE_RELOCATION_NOT_UNIQUE');
  assert.equal(dirname(dirname(dirname(candidates[0]!))), applications);
  return candidates[0]!;
}

export class ExchangeLocator {
  readonly original: string;
  current: string;
  moves = 0;
  private readyHash?: string;
  constructor(directory: string, private readonly followMove: boolean) {
    this.original = this.current = directory;
    this.validate(directory);
  }
  bindReady(): void { this.readyHash = this.hashReady(this.current); }
  private hashReady(path: string): string {
    return createHash('sha256').update(privateBytes(join(path, 'peer-ready.json'))).digest('hex');
  }
  private validate(path: string): void {
    validateExchange(path, process.pid, this.readyHash);
  }
  ensure(): string {
    try { this.validate(this.current); return this.current; } catch { /* Locate only an explicitly authorized simulator-container move. */ }
    const match = this.original.match(/^(\/Users\/[^/]+\/Library\/Developer\/CoreSimulator\/Devices\/[A-Fa-f0-9-]+\/data\/Containers\/Data\/Application)\/[A-Fa-f0-9-]+\/Documents\/(privchat-native-peer-[A-Za-z0-9-]{8,64})$/);
    if (!this.followMove || !this.readyHash || !match) throw new CarrierFailure('EXCHANGE_MISSING_OR_REPLACED');
    const applications = match[1]!;
    this.current = findMovedExchange(applications, basename(this.original), process.pid, this.readyHash);
    this.moves++;
    return this.current;
  }
}

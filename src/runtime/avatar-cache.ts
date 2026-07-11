/**
 * Browser-side avatar local cache (CLIENT_GLOBAL_STATE §4 P4.2) — the web equivalent of
 * the app's `{userRoot}/avatars/users/{uid}.img` file cache.
 *
 * Storage: Cache Storage (`caches`), one synthetic entry per user keyed by
 * `https://privchat.avatar/users/{uid}`; the source remote URL is recorded on the cached
 * response (`x-avatar-source-url`) as the freshness key (`avatar_cached_url` semantics).
 * Display handles are in-memory object URLs, memoized per uid and revoked on replacement.
 *
 * All entry points degrade gracefully when Cache Storage is unavailable (SSR/node/tests):
 * resolve returns nulls (→ remote_only/fallback) and ensure is a no-op returning null.
 * Failure never poisons an existing cached copy — the old entry is only replaced after a
 * successful fetch (same "download success before force-set" rule as the SDK re-cache).
 */

const CACHE_NAME = 'privchat-avatars-v1';
const SOURCE_HEADER = 'x-avatar-source-url';

function cacheKey(userId: string): string {
  return `https://privchat.avatar/users/${userId}`;
}

function cachesAvailable(): boolean {
  return typeof caches !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

interface MemoEntry {
  sourceUrl: string;
  objectUrl: string;
}

/** uid → live object URL (revoked when replaced / cleared). */
const memo = new Map<string, MemoEntry>();

export interface AvatarCacheHit {
  /** Object URL for display (the local display source of truth). */
  localUrl: string;
  /** Remote URL the copy was fetched from (freshness key). */
  cachedUrl: string;
}

/** Look up the locally cached copy for `userId` (no network). */
export async function lookupCachedAvatar(userId: string): Promise<AvatarCacheHit | null> {
  const memoHit = memo.get(userId);
  if (memoHit !== undefined) {
    return { localUrl: memoHit.objectUrl, cachedUrl: memoHit.sourceUrl };
  }
  if (!cachesAvailable()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(cacheKey(userId));
    if (!res) return null;
    const sourceUrl = res.headers.get(SOURCE_HEADER) ?? '';
    if (sourceUrl === '') return null;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    replaceMemo(userId, { sourceUrl, objectUrl });
    return { localUrl: objectUrl, cachedUrl: sourceUrl };
  } catch {
    return null;
  }
}

/**
 * Ensure `userId`'s avatar from `remoteUrl` is cached locally (download → store).
 * Any avatar source goes through this single entry (self / friend / member / peer /
 * profile refresh). Returns the new cache hit, or null on failure — **the previous
 * cached copy is left untouched on failure**.
 */
export async function ensureUserAvatarCached(
  userId: string,
  remoteUrl: string,
): Promise<AvatarCacheHit | null> {
  const url = remoteUrl.trim();
  if (url === '' || !url.startsWith('http')) return null;
  const existing = await lookupCachedAvatar(userId);
  if (existing !== null && existing.cachedUrl === url) return existing;
  if (!cachesAvailable()) return null;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    const stored = new Response(blob, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        [SOURCE_HEADER]: url,
      },
    });
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey(userId), stored);
    const objectUrl = URL.createObjectURL(blob);
    replaceMemo(userId, { sourceUrl: url, objectUrl });
    return { localUrl: objectUrl, cachedUrl: url };
  } catch {
    return null; // 失败不污染旧缓存
  }
}

/** Drop all live object URLs (logout/account switch; Cache Storage entries may remain). */
export function clearAvatarObjectUrls(): void {
  for (const entry of memo.values()) {
    try {
      URL.revokeObjectURL(entry.objectUrl);
    } catch {
      /* noop */
    }
  }
  memo.clear();
}

function replaceMemo(userId: string, next: MemoEntry): void {
  const prev = memo.get(userId);
  if (prev !== undefined && prev.objectUrl !== next.objectUrl) {
    try {
      URL.revokeObjectURL(prev.objectUrl);
    } catch {
      /* noop */
    }
  }
  memo.set(userId, next);
}

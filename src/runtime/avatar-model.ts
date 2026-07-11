/**
 * Unified avatar model (CLIENT_GLOBAL_STATE_AND_IDENTITY_STORE_SPEC §4, P4.2 alignment).
 *
 * Canonical semantics (frozen by the KMP app):
 *  - the **local cached copy is the display source of truth** (browser: blob/object URL
 *    backed by Cache Storage — the web equivalent of `avatar_local_path`),
 *  - the remote URL is only the download source,
 *  - `cachedUrl` (the remote URL the local copy was fetched from) is the freshness key,
 *  - UI consumes an AvatarModel; it never assembles remote-first `<img src>` itself.
 */

export type AvatarFreshness =
  /** Local copy present and its source URL matches the current remote URL. */
  | 'fresh_local'
  /** Local copy present but the remote URL changed — show local, refresh in background. */
  | 'stale_local'
  /** No local copy; remote URL available (render remote, cache in background). */
  | 'remote_only'
  /** Neither local nor remote — initials + hash color fallback. */
  | 'fallback';

export interface AvatarModel {
  userId: string;
  displayName?: string | null;
  username?: string | null;
  /** Display source of truth: blob/object URL of the locally cached image. */
  localUrl?: string | null;
  /** Download source only. */
  remoteUrl?: string | null;
  /** Remote URL the local copy corresponds to (freshness key). */
  version?: string | null;
  freshness: AvatarFreshness;
  /** Hash-color seed, `u:<uid>` — same rule as the app/H5/web FNV palette seeds. */
  seed: string;
}

export interface ResolveAvatarInput {
  userId: string | number | bigint;
  remoteUrl?: string | null;
  /** Remote URL the cached copy was fetched from (from the avatar cache). */
  cachedUrl?: string | null;
  /** Blob/object URL of the cached copy, when present. */
  localUrl?: string | null;
  displayName?: string | null;
  username?: string | null;
}

function nonBlank(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Pure freshness resolution — mirrors the app's `AvatarStore.resolveUserAvatar`:
 *   local && cachedUrl === remote → fresh_local
 *   local (version unknown/changed) → stale_local (still display local first)
 *   remote only → remote_only
 *   neither → fallback
 */
export function resolveAvatarModel(input: ResolveAvatarInput): AvatarModel {
  const uid = String(input.userId);
  const local = nonBlank(input.localUrl);
  const remote = nonBlank(input.remoteUrl);
  const version = nonBlank(input.cachedUrl);
  const freshness: AvatarFreshness =
    local !== null && version !== null && version === remote
      ? 'fresh_local'
      : local !== null
        ? 'stale_local'
        : remote !== null
          ? 'remote_only'
          : 'fallback';
  return {
    userId: uid,
    displayName: input.displayName ?? null,
    username: input.username ?? null,
    localUrl: local,
    remoteUrl: remote,
    version,
    freshness,
    seed: `u:${uid}`,
  };
}

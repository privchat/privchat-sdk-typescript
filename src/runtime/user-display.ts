/**
 * Unified user display-name rule (CLIENT_GLOBAL_STATE_AND_IDENTITY_STORE_SPEC §5.2, P4.2
 * cross-client alignment — canonical behavior is the KMP app's `UserDisplay.of`).
 *
 * Rule: system user → localized system name; otherwise
 *   remark(alias) > nickname > username > userId.
 *
 * System-user detection is by **user_type === 1** (server USER_TYPE_SYSTEM) with the
 * legacy username channel (`system` / `__system_1__`) kept for compatibility.
 * Never by uid — uid values are deployment facts, not identity semantics.
 */

export const USER_TYPE_SYSTEM = 1;

export function isSystemUser(opts: {
  userType?: number | null;
  username?: string | null;
}): boolean {
  if (opts.userType === USER_TYPE_SYSTEM) return true;
  const u = opts.username;
  return u === 'system' || u === '__system_1__';
}

export interface UserDisplayInput {
  username?: string | null;
  nickname?: string | null;
  /** Friend remark / alias — highest priority. */
  remark?: string | null;
  userId?: string | number | bigint | null;
  userType?: number | null;
  /** Localized "System Messages" label; callers pass their i18n value. */
  systemName?: string | null;
}

function nonBlank(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** The single display-name entry. Same userId must render the same name everywhere. */
export function userDisplayName(input: UserDisplayInput): string {
  if (isSystemUser(input)) {
    return nonBlank(input.systemName) ?? nonBlank(input.nickname) ?? 'System Messages';
  }
  return (
    nonBlank(input.remark) ??
    nonBlank(input.nickname) ??
    nonBlank(input.username) ??
    (input.userId != null ? String(input.userId) : '')
  );
}

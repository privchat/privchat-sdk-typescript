/**
 * Display-timezone configuration and UTC→local formatting (TIMEZONE_SPEC).
 *
 * local-first hard constraints (spec §1/§4), mirroring the Rust core `timezone` module:
 * - Timestamps in the data model are ALWAYS UTC millis. Nothing here offsets and writes
 *   them back; conversion happens only inside these pure formatting functions.
 * - Configuration is a local display preference ({@link DisplayTimezone}); no network.
 * - IANA zone ids only (DST/history aware via `Intl.DateTimeFormat`). A fixed offset is
 *   rejected — `+08:00` is not a zone id.
 *
 * "Today/yesterday" is decided on the configured zone's calendar day, not the UTC day.
 * "This week" is a rolling 7-day window (`ts >= now - 7d`), matching privchat-ui and the
 * Rust core. The `format*` helpers emit the spec's canonical Chinese labels; localized
 * UIs should instead build strings from the {@link epochMillisToLocalDateTime} atom.
 */

import { PrivchatClient } from './client.js';

/** Local calendar components of a UTC instant in a given IANA zone (spec §3.3 atom). */
export interface LocalDateTimeParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: Monday=1 … Sunday=7. */
  dayOfWeek: number;
}

/** Thrown when a zone id is not a valid IANA name (or is a fixed offset). */
export class UnknownTimezoneError extends Error {
  constructor(readonly zoneId: string) {
    super(`unknown IANA timezone id: ${zoneId}`);
    this.name = 'UnknownTimezoneError';
  }
}

/** Thrown when UTC millis are outside the representable Date range. */
export class InvalidTimestampError extends Error {
  constructor(readonly millis: number) {
    super(`timestamp out of range: ${millis}`);
    this.name = 'InvalidTimestampError';
  }
}

const WEEKDAY_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;
const WEEKDAY_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};
const DAY_MS = 86_400_000;

const pad2 = (n: number): string => String(n).padStart(2, '0');

// One formatter per zone; constructing it is also how we validate the id (Intl throws
// RangeError on an unknown zone). `hourCycle: 'h23'` forces 00–23 (some engines emit
// "24" for midnight under hour12:false).
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function getFormatter(zoneId: string): Intl.DateTimeFormat {
  // Intl accepts a leading-offset literal like "+08:00"; the spec forbids fixed offsets
  // and the Rust core rejects them, so reject them here too for cross-language parity.
  if (/^[+-]/.test(zoneId)) throw new UnknownTimezoneError(zoneId);
  let fmt = FORMATTERS.get(zoneId);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zoneId,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        weekday: 'short',
      });
    } catch {
      throw new UnknownTimezoneError(zoneId);
    }
    FORMATTERS.set(zoneId, fmt);
  }
  return fmt;
}

/**
 * UTC millis → local calendar components in `zoneId` (atom, spec §3.3).
 *
 * Pure and local. Upper layers needing localized text should assemble it from these
 * components plus their own i18n — never add/subtract a raw offset (spec §4).
 */
export function epochMillisToLocalDateTime(
  millis: number,
  zoneId: string,
): LocalDateTimeParts {
  const fmt = getFormatter(zoneId);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) throw new InvalidTimestampError(millis);
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    dayOfWeek: WEEKDAY_ISO[p.weekday!] ?? 0,
  };
}

/** The device/system IANA zone id (atom). Falls back to `"UTC"` when unavailable. */
export function systemDefaultTimezoneId(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Local display preference. Only affects formatting output, never a data-model timestamp.
 * Defaults to the system zone; `set` validates the IANA id and keeps the old value on error.
 */
export class DisplayTimezone {
  private zoneId: string;

  constructor(zoneId?: string) {
    if (zoneId === undefined) {
      this.zoneId = systemDefaultTimezoneId();
    } else {
      getFormatter(zoneId); // validate before storing
      this.zoneId = zoneId;
    }
  }

  /** A instance configured to the device system zone. */
  static systemDefault(): DisplayTimezone {
    return new DisplayTimezone();
  }

  set(zoneId: string): void {
    getFormatter(zoneId); // throws (and leaves this.zoneId untouched) on an invalid id
    this.zoneId = zoneId;
  }

  get(): string {
    return this.zoneId;
  }

  reset(): void {
    this.zoneId = systemDefaultTimezoneId();
  }
}

const sameDay = (a: LocalDateTimeParts, b: LocalDateTimeParts): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

const hhmm = (p: LocalDateTimeParts): string => `${pad2(p.hour)}:${pad2(p.minute)}`;

/** Message-bubble time `"HH:mm"` in `zoneId`. `millis <= 0` → `""`. */
export function formatMessageTime(millis: number, zoneId: string): string {
  if (millis <= 0) return '';
  return hhmm(epochMillisToLocalDateTime(millis, zoneId));
}

/**
 * Conversation-list time (spec §3.2): today `"HH:mm"` / yesterday `"昨天"` /
 * within 7 days `"周X"` / older `"MM-dd"`. `nowMillis` defaults to the current UTC instant
 * and is explicit for deterministic tests.
 */
export function formatConversationTime(
  millis: number,
  zoneId: string,
  nowMillis: number = Date.now(),
): string {
  if (millis <= 0) return '';
  const ts = epochMillisToLocalDateTime(millis, zoneId);
  const now = epochMillisToLocalDateTime(nowMillis, zoneId);
  if (sameDay(ts, now)) return hhmm(ts);
  const yesterday = epochMillisToLocalDateTime(nowMillis - DAY_MS, zoneId);
  if (sameDay(ts, yesterday)) return '昨天';
  if (millis >= nowMillis - 7 * DAY_MS) return WEEKDAY_ZH[ts.dayOfWeek - 1]!;
  return `${pad2(ts.month)}-${pad2(ts.day)}`;
}

/**
 * Message time separator (spec §3.2): today `"今天 HH:mm"` / yesterday `"昨天 HH:mm"` /
 * same year `"MM月dd日 HH:mm"` / cross-year `"yyyy年MM月dd日 HH:mm"`.
 */
export function formatSeparatorTime(
  millis: number,
  zoneId: string,
  nowMillis: number = Date.now(),
): string {
  if (millis <= 0) return '';
  const ts = epochMillisToLocalDateTime(millis, zoneId);
  const now = epochMillisToLocalDateTime(nowMillis, zoneId);
  const time = hhmm(ts);
  if (sameDay(ts, now)) return `今天 ${time}`;
  const yesterday = epochMillisToLocalDateTime(nowMillis - DAY_MS, zoneId);
  if (sameDay(ts, yesterday)) return `昨天 ${time}`;
  if (ts.year === now.year) return `${pad2(ts.month)}月${pad2(ts.day)}日 ${time}`;
  return `${ts.year}年${pad2(ts.month)}月${pad2(ts.day)}日 ${time}`;
}

// ----- PrivchatClient instance surface (parity with the Rust core / FFI / Kotlin) -----
//
// Declaration merge + prototype assignment, the same pattern api-methods.ts uses, so
// client.ts stays focused on lifecycle/state/events. Per-instance display preference is
// held in a WeakMap (lazily created on first use) rather than a new class field.

const CLIENT_TIMEZONES = new WeakMap<PrivchatClient, DisplayTimezone>();

function clientTimezone(client: PrivchatClient): DisplayTimezone {
  let tz = CLIENT_TIMEZONES.get(client);
  if (!tz) {
    tz = new DisplayTimezone();
    CLIENT_TIMEZONES.set(client, tz);
  }
  return tz;
}

declare module './client.js' {
  interface PrivchatClient {
    /** Set the display zone (IANA id). Invalid id throws and keeps the old value. */
    setDisplayTimezone(zoneId: string): void;
    /** Current display zone IANA id. */
    getDisplayTimezone(): string;
    /** Reset the display zone to the device system default. */
    resetDisplayTimezone(): void;
    /** Message-bubble `"HH:mm"` in the configured zone. */
    formatMessageTime(millis: number): string;
    /** Conversation-list time in the configured zone, "now" = current UTC. */
    formatConversationTime(millis: number): string;
    /** Message time separator in the configured zone, "now" = current UTC. */
    formatSeparatorTime(millis: number): string;
    /** UTC millis → local components in an explicit zone (atom, ignores configured zone). */
    epochMillisToLocalDateTime(millis: number, zoneId: string): LocalDateTimeParts;
    /** Device system IANA zone id (atom). */
    systemDefaultTimezoneId(): string;
  }
}

const proto = PrivchatClient.prototype;
proto.setDisplayTimezone = function (zoneId: string): void {
  clientTimezone(this).set(zoneId);
};
proto.getDisplayTimezone = function (): string {
  return clientTimezone(this).get();
};
proto.resetDisplayTimezone = function (): void {
  clientTimezone(this).reset();
};
proto.formatMessageTime = function (millis: number): string {
  return formatMessageTime(millis, clientTimezone(this).get());
};
proto.formatConversationTime = function (millis: number): string {
  return formatConversationTime(millis, clientTimezone(this).get());
};
proto.formatSeparatorTime = function (millis: number): string {
  return formatSeparatorTime(millis, clientTimezone(this).get());
};
proto.epochMillisToLocalDateTime = function (
  millis: number,
  zoneId: string,
): LocalDateTimeParts {
  return epochMillisToLocalDateTime(millis, zoneId);
};
proto.systemDefaultTimezoneId = function (): string {
  return systemDefaultTimezoneId();
};
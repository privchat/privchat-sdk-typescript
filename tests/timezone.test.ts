// Display-timezone behavior parity with the Rust core `timezone` module (TIMEZONE_SPEC).
//
// Every case mirrors a Rust unit test: same UTC fixtures, same expected strings. The
// `format*` helpers emit the spec's canonical Chinese labels; `now` is passed explicitly
// so nothing depends on the host clock or host zone.

import { describe, expect, it } from 'vitest';
import {
  DisplayTimezone,
  InvalidTimestampError,
  PrivchatClient,
  UnknownTimezoneError,
  epochMillisToLocalDateTime,
  formatConversationTime,
  formatMessageTime,
  formatSeparatorTime,
  systemDefaultTimezoneId,
} from '../src/index.js';

// UTC calendar fixture (month is 1-based, like the Rust `utc_millis` helper).
const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number): number =>
  Date.UTC(y, mo - 1, d, h, mi, s);

const NOW = utc(2026, 11, 12, 12, 0, 0); // Thursday
const DAY = 86_400_000;

describe('timezone atom — epochMillisToLocalDateTime', () => {
  it('epoch zero in UTC is 1970-01-01 00:00:00, Thursday(4)', () => {
    expect(epochMillisToLocalDateTime(0, 'UTC')).toEqual({
      year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, dayOfWeek: 4,
    });
  });

  it('Shanghai is UTC+8', () => {
    const p = epochMillisToLocalDateTime(0, 'Asia/Shanghai');
    expect([p.year, p.month, p.day, p.hour]).toEqual([1970, 1, 1, 8]);
    expect(p.dayOfWeek).toBe(4);
  });

  it('New York follows DST (summer -4, winter -5), not a fixed offset', () => {
    const summer = epochMillisToLocalDateTime(utc(2026, 7, 1, 12, 0, 0), 'America/New_York');
    const winter = epochMillisToLocalDateTime(utc(2026, 1, 1, 12, 0, 0), 'America/New_York');
    expect(summer.hour).toBe(8);
    expect(winter.hour).toBe(7);
    expect(summer.hour).not.toBe(winter.hour);
  });

  it('Ho Chi Minh is UTC+7 year-round (no DST)', () => {
    expect(epochMillisToLocalDateTime(utc(2026, 7, 1, 12, 0, 0), 'Asia/Ho_Chi_Minh').hour).toBe(19);
    expect(epochMillisToLocalDateTime(utc(2026, 1, 1, 12, 0, 0), 'Asia/Ho_Chi_Minh').hour).toBe(19);
  });

  it('rejects unknown zones and fixed offsets', () => {
    expect(() => epochMillisToLocalDateTime(0, 'Mars/Olympus')).toThrow(UnknownTimezoneError);
    expect(() => epochMillisToLocalDateTime(0, '+8')).toThrow(UnknownTimezoneError);
    // Node's Intl accepts "+08:00"; the spec/Rust core reject it, so we must too.
    expect(() => epochMillisToLocalDateTime(0, '+08:00')).toThrow(UnknownTimezoneError);
  });

  it('rejects out-of-range timestamps', () => {
    expect(() => epochMillisToLocalDateTime(8.64e15 + 1, 'UTC')).toThrow(InvalidTimestampError);
  });
});

describe('systemDefaultTimezoneId', () => {
  it('is a usable IANA id', () => {
    const id = systemDefaultTimezoneId();
    expect(id.length).toBeGreaterThan(0);
    expect(() => epochMillisToLocalDateTime(0, id)).not.toThrow();
  });
});

describe('DisplayTimezone', () => {
  it('set/get/reset, keeps the old value on an invalid set', () => {
    const tz = new DisplayTimezone('UTC');
    expect(tz.get()).toBe('UTC');
    tz.set('Asia/Shanghai');
    expect(tz.get()).toBe('Asia/Shanghai');
    expect(() => tz.set('Mars/Olympus')).toThrow(UnknownTimezoneError);
    expect(tz.get()).toBe('Asia/Shanghai');
    tz.reset();
    expect(tz.get()).toBe(systemDefaultTimezoneId());
  });

  it('validates the constructor argument and defaults to the system zone', () => {
    expect(() => new DisplayTimezone('+08:00')).toThrow(UnknownTimezoneError);
    expect(new DisplayTimezone().get()).toBe(systemDefaultTimezoneId());
    expect(DisplayTimezone.systemDefault().get()).toBe(systemDefaultTimezoneId());
  });

  it('stores the id verbatim (does not normalize IANA aliases)', () => {
    // Intl resolves Asia/Ho_Chi_Minh to Asia/Saigon; Rust stores the input string, so we do too.
    expect(new DisplayTimezone('Asia/Ho_Chi_Minh').get()).toBe('Asia/Ho_Chi_Minh');
  });
});

describe('formatMessageTime', () => {
  it('renders HH:mm in the configured zone', () => {
    expect(formatMessageTime(utc(2026, 11, 12, 9, 5, 0), 'UTC')).toBe('09:05');
    expect(formatMessageTime(utc(2026, 11, 12, 9, 5, 0), 'Asia/Shanghai')).toBe('17:05');
  });

  it('returns empty for non-positive millis (before validating the zone)', () => {
    expect(formatMessageTime(0, 'UTC')).toBe('');
    expect(formatMessageTime(-1, 'UTC')).toBe('');
    expect(formatConversationTime(0, 'UTC', NOW)).toBe('');
    expect(formatSeparatorTime(0, 'UTC', NOW)).toBe('');
  });
});

describe('formatConversationTime', () => {
  it('today HH:mm / yesterday / weekday / older MM-dd', () => {
    expect(formatConversationTime(utc(2026, 11, 12, 9, 30, 0), 'UTC', NOW)).toBe('09:30');
    expect(formatConversationTime(utc(2026, 11, 11, 23, 0, 0), 'UTC', NOW)).toBe('昨天');
    expect(formatConversationTime(utc(2026, 11, 9, 10, 0, 0), 'UTC', NOW)).toBe('周一');
    expect(formatConversationTime(utc(2026, 10, 1, 10, 0, 0), 'UTC', NOW)).toBe('10-01');
  });

  it('uses a rolling 7-day window (not an ISO calendar week)', () => {
    expect(formatConversationTime(utc(2026, 11, 6, 12, 0, 0), 'UTC', NOW)).toBe('周五');
    expect(formatConversationTime(utc(2026, 11, 5, 11, 59, 0), 'UTC', NOW)).toBe('11-05');
  });
});

describe('formatSeparatorTime', () => {
  it('today / yesterday / same-year / cross-year', () => {
    expect(formatSeparatorTime(utc(2026, 11, 12, 9, 30, 0), 'UTC', NOW)).toBe('今天 09:30');
    expect(formatSeparatorTime(utc(2026, 11, 11, 23, 0, 0), 'UTC', NOW)).toBe('昨天 23:00');
    expect(formatSeparatorTime(utc(2026, 3, 5, 8, 15, 0), 'UTC', NOW)).toBe('03月05日 08:15');
    expect(formatSeparatorTime(utc(2025, 12, 31, 23, 59, 0), 'UTC', NOW)).toBe('2025年12月31日 23:59');
  });
});

describe('calendar-day boundary uses the configured zone, not UTC', () => {
  // now/ts straddle New York midnight (05:00 UTC) but not Shanghai midnight (16:00 UTC).
  const now = utc(2026, 11, 12, 5, 30, 0);
  const ts = utc(2026, 11, 12, 4, 30, 0);

  it('same UTC pair classifies as today in Shanghai but yesterday in New York', () => {
    expect(formatConversationTime(ts, 'Asia/Shanghai', now)).toBe('12:30');
    expect(formatConversationTime(ts, 'America/New_York', now)).toBe('昨天');
    expect(formatSeparatorTime(ts, 'Asia/Shanghai', now)).toBe('今天 12:30');
    expect(formatSeparatorTime(ts, 'America/New_York', now)).toBe('昨天 23:30');
  });
});

describe('data-model timestamps stay UTC', () => {
  it('local components round-trip back to UTC + offset (no pollution of the instant)', () => {
    const millis = utc(2026, 11, 12, 14, 5, 0);
    const p = epochMillisToLocalDateTime(millis, 'Asia/Shanghai');
    const reconstructed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    expect(reconstructed - millis).toBe(8 * 3_600_000);
  });
});

describe('invalid zone propagates through the formatters', () => {
  const ts = utc(2026, 11, 12, 9, 0, 0);
  it('throws for an unknown zone', () => {
    expect(() => formatMessageTime(ts, 'Mars/Olympus')).toThrow(UnknownTimezoneError);
    expect(() => formatConversationTime(ts, 'Mars/Olympus', NOW)).toThrow(UnknownTimezoneError);
    expect(() => formatSeparatorTime(ts, 'Mars/Olympus', NOW)).toThrow(UnknownTimezoneError);
  });
});

describe('PrivchatClient instance surface', () => {
  it('defaults to the system zone and formats with the configured zone', () => {
    const client = new PrivchatClient({ url: 'ws://127.0.0.1:1' });
    expect(client.getDisplayTimezone()).toBe(systemDefaultTimezoneId());
    client.setDisplayTimezone('Asia/Shanghai');
    expect(client.getDisplayTimezone()).toBe('Asia/Shanghai');
    expect(client.formatMessageTime(utc(2026, 11, 12, 14, 5, 0))).toBe('22:05');
    expect(() => client.setDisplayTimezone('Mars/Olympus')).toThrow(UnknownTimezoneError);
    expect(client.getDisplayTimezone()).toBe('Asia/Shanghai');
    expect(client.epochMillisToLocalDateTime(0, 'UTC').dayOfWeek).toBe(4);
    expect(client.systemDefaultTimezoneId()).toBe(systemDefaultTimezoneId());
    client.resetDisplayTimezone();
    expect(client.getDisplayTimezone()).toBe(systemDefaultTimezoneId());
  });

  it('keeps display preference independent per client instance', () => {
    const a = new PrivchatClient({ url: 'ws://127.0.0.1:1' });
    const b = new PrivchatClient({ url: 'ws://127.0.0.1:1' });
    a.setDisplayTimezone('UTC');
    b.setDisplayTimezone('Asia/Shanghai');
    expect(a.getDisplayTimezone()).toBe('UTC');
    expect(b.getDisplayTimezone()).toBe('Asia/Shanghai');
    expect(a.formatMessageTime(utc(2026, 11, 12, 14, 5, 0))).toBe('14:05');
    expect(b.formatMessageTime(utc(2026, 11, 12, 14, 5, 0))).toBe('22:05');
  });
});
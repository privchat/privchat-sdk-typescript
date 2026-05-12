import { describe, expect, it } from 'vitest';
import { parseRpcJson } from '../src/codec/safe-json.js';

describe('parseRpcJson', () => {
  it('keeps small integers as numbers', () => {
    const out = parseRpcJson<{ a: number; b: number }>(`{"a":1,"b":-42}`);
    expect(out).toEqual({ a: 1, b: -42 });
    expect(typeof out.a).toBe('number');
  });

  it('keeps Number.MAX_SAFE_INTEGER as number (boundary)', () => {
    const text = `{"x":${Number.MAX_SAFE_INTEGER}}`;
    const out = parseRpcJson<{ x: number | string }>(text);
    expect(out.x).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof out.x).toBe('number');
  });

  it('preserves snowflake-sized integers as exact strings', () => {
    // 18-digit snowflake. JSON.parse would round to a multiple of 64.
    const text = `{"id":574987373818023940,"name":"x"}`;
    const out = parseRpcJson<{ id: number | string; name: string }>(text);
    expect(out.id).toBe('574987373818023940');
    expect(typeof out.id).toBe('string');
    expect(out.name).toBe('x');
  });

  it('parses fractional numbers as plain numbers', () => {
    const out = parseRpcJson<{ pi: number }>(`{"pi":3.14}`);
    expect(out.pi).toBeCloseTo(3.14);
    expect(typeof out.pi).toBe('number');
  });

  it('handles arrays + nested objects + booleans + null', () => {
    const text = `{"arr":[1, 999999999999999999, "z"], "ok":true, "nil":null}`;
    const out = parseRpcJson<{
      arr: Array<number | string>;
      ok: boolean;
      nil: null;
    }>(text);
    expect(out.arr[0]).toBe(1);
    expect(out.arr[1]).toBe('999999999999999999');
    expect(out.arr[2]).toBe('z');
    expect(out.ok).toBe(true);
    expect(out.nil).toBeNull();
  });

  it('handles negative unsafe integers', () => {
    const out = parseRpcJson<{ n: number | string }>(`{"n":-9007199254740993}`);
    expect(out.n).toBe('-9007199254740993');
  });
});

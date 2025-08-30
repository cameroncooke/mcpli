import { describe, it, expect } from 'vitest';
import {
  isUnsafeKey,
  safeEmptyRecord,
  safeDefine,
  deepSanitize
} from '../../src/utils/safety.ts';

describe('safety utilities', () => {
  it('safeEmptyRecord returns null-prototype object', () => {
    const rec = safeEmptyRecord();
    expect(Object.getPrototypeOf(rec)).toBe(null);
  });

  it('isUnsafeKey correctly identifies dangerous keys', () => {
    expect(isUnsafeKey('__proto__')).toBe(true);
    expect(isUnsafeKey('constructor')).toBe(true);
    expect(isUnsafeKey('prototype')).toBe(true);
    expect(isUnsafeKey('safe')).toBe(false);
  });

  it('safeDefine defines enumerable data property', () => {
    const o = safeEmptyRecord();
    safeDefine(o, 'foo', 42);
    expect(o.foo).toBe(42);
    expect(Object.getOwnPropertyDescriptor(o, 'foo')?.enumerable).toBe(true);
  });

  it('safeDefine rejects dangerous keys', () => {
    const o = safeEmptyRecord();
    expect(() => safeDefine(o, '__proto__', 'x')).toThrow();
    expect(() => safeDefine(o, 'constructor', 'x')).toThrow();
  });

  it('deepSanitize removes dangerous keys and rehydrates objects safely', () => {
    const input = {
      __proto__: { polluted: true },
      safe: 'ok',
      nested: {
        constructor: 'nope',
        good: [ { prototype: 'bad' }, { foo: 'bar' } ]
      }
    } as unknown as Record<string, unknown>;

    const out = deepSanitize(input) as Record<string, any>;

    expect(out.__proto__).toBeUndefined();
    expect(out.safe).toBe('ok');
    expect(out.nested.constructor).toBeUndefined();
    expect(out.nested.good[0].prototype).toBeUndefined();
    expect(out.nested.good[1].foo).toBe('bar');
    // ensure null-prototype objects are used
    expect(Object.getPrototypeOf(out)).toBe(null);
    expect(Object.getPrototypeOf(out.nested)).toBe(null);
  });
});
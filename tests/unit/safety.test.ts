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
    // Create input object with dangerous keys as actual own properties
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, '__proto__', { value: { polluted: true }, enumerable: true });
    input.safe = 'ok';
    input.nested = {
      constructor: 'nope',
      good: [
        Object.defineProperty({}, 'prototype', { value: 'bad', enumerable: true }),
        { foo: 'bar' }
      ]
    };

    const out = deepSanitize(input) as Record<string, any>;

    // Should not have dangerous keys as own properties
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(out.safe).toBe('ok');
    expect(Object.prototype.hasOwnProperty.call(out.nested, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.nested.good[0], 'prototype')).toBe(false);
    expect(out.nested.good[1].foo).toBe('bar');
    // ensure null-prototype objects are used
    expect(Object.getPrototypeOf(out)).toBe(null);
    expect(Object.getPrototypeOf(out.nested)).toBe(null);
  });
});
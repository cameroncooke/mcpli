/**
 * Safety utilities to prevent prototype pollution for untrusted key/value aggregation.
 */

export const DANGEROUS_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

export function isUnsafeKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/**
 * Create a null-prototype object for safe key/value storage.
 */
export function safeEmptyRecord<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Safely define a property on an object, rejecting dangerous keys
 * and ensuring a data property is created (not invoking accessors).
 */
export function safeDefine<T extends Record<string, unknown>>(
  obj: T,
  key: string,
  value: unknown,
): void {
  if (isUnsafeKey(key)) {
    throw new Error(`Unsafe key "${key}" is not allowed.`);
  }
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Deeply sanitize arrays and objects by removing dangerous keys
 * and rehydrating objects as null-prototype records.
 */
export function deepSanitize<T>(value: T): T {
  return _deepSanitize(value) as T;
}

function _deepSanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => _deepSanitize(v));
  }
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out = safeEmptyRecord<unknown>();
    for (const k of Object.keys(src)) {
      if (isUnsafeKey(k)) continue;
      safeDefine(out, k, _deepSanitize(src[k]));
    }
    return out;
  }
  return value;
}

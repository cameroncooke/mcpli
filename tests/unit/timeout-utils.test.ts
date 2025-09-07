import { describe, it, expect } from 'vitest';

describe('timeout utils', () => {
  it('parsePositiveIntMs parses valid positive integers', async () => {
    const { __testOnly } = await import('../../src/daemon/mcp-client-utils.ts');
    const { parsePositiveIntMs } = __testOnly as unknown as {
      parsePositiveIntMs: (v: unknown) => number | undefined;
    };

    expect(parsePositiveIntMs(1234)).toBe(1234);
    expect(parsePositiveIntMs('5000')).toBe(5000);
    expect(parsePositiveIntMs('  42  ')).toBe(42);
  });

  it('parsePositiveIntMs returns undefined for invalid/zero/negative', async () => {
    const { __testOnly } = await import('../../src/daemon/mcp-client-utils.ts');
    const { parsePositiveIntMs } = __testOnly as unknown as {
      parsePositiveIntMs: (v: unknown) => number | undefined;
    };

    expect(parsePositiveIntMs(undefined)).toBeUndefined();
    expect(parsePositiveIntMs(null)).toBeUndefined();
    expect(parsePositiveIntMs('')).toBeUndefined();
    expect(parsePositiveIntMs('abc')).toBeUndefined();
    expect(parsePositiveIntMs(0)).toBeUndefined();
    expect(parsePositiveIntMs(-5)).toBeUndefined();
  });
});


import { describe, expect, it } from 'vitest';
import { normalizeDoubleBackslashesInMathDelimiters } from './math';

describe('markdown math helpers', () => {
  it('normalizes escaped latex commands inside inline and display math only', () => {
    const source = 'Outside \\alpha and $\\\\alpha + \\\\beta$\n$$\\\\gamma\\\\delta$$';

    expect(normalizeDoubleBackslashesInMathDelimiters(source)).toBe('Outside \\alpha and $\\alpha + \\beta$\n$$\\gamma\\delta$$');
  });
});

import { describe, expect, it } from 'vitest';
import { cn } from '../src/lib/utils.js';

describe('cn utility', () => {
  it('combines class names cleanly', () => {
    expect(cn('class1', 'class2')).toBe('class1 class2');
  });

  it('handles conditionals and falsy values', () => {
    expect(cn('base', (false as boolean) && 'hidden', null, undefined, 'active')).toBe(
      'base active',
    );
  });

  it('merges tailwind classes using tailwind-merge', () => {
    expect(cn('p-4', 'p-8')).toBe('p-8');
  });
});

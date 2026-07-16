import { describe, expect, it } from 'vitest';
import { maskEmail } from './info.js';

describe('maskEmail', () => {
  it('masks local part and domain while keeping the tld', () => {
    expect(maskEmail('alice.smith@example.com')).toBe('al****@****.com');
  });

  it('handles short local parts', () => {
    expect(maskEmail('ab@test.com')).toBe('ab****@****.com');
    expect(maskEmail('a@test.com')).toBe('a****@****.com');
  });

  it('returns a generic mask for invalid emails', () => {
    expect(maskEmail('not-an-email')).toBe('****@****.***');
  });
});

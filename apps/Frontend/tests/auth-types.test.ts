import { describe, expect, it, vi } from 'vitest';
import {
  getUserInitials,
  getStoredToken,
  setStoredToken,
  TOKEN_STORAGE_KEY,
} from '../src/features/auth/auth-types.js';

describe('auth-types and helpers', () => {
  it('computes user initials correctly for various inputs', () => {
    expect(getUserInitials('Ana Souza', 'ana@example.com')).toBe('AS');
    expect(getUserInitials('Ana', 'ana@example.com')).toBe('AN');
    expect(getUserInitials('   ', 'ana@example.com')).toBe('AN');
    expect(getUserInitials('', '   admin@corp.com')).toBe('AD');
    expect(getUserInitials('', '')).toBe('US');
    expect(getUserInitials(undefined, undefined)).toBe('US');
  });

  it('stores and retrieves session token from localStorage', () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    expect(getStoredToken()).toBeNull();

    setStoredToken('test-token-xyz');
    expect(getStoredToken()).toBe('test-token-xyz');

    setStoredToken(null);
    expect(getStoredToken()).toBeNull();
  });

  it('safely catches errors when localStorage access throws', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Access denied');
    });
    expect(getStoredToken()).toBeNull();
    getItemSpy.mockRestore();

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    expect(() => setStoredToken('any-token')).not.toThrow();
    setItemSpy.mockRestore();

    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('Remove error');
    });
    expect(() => setStoredToken(null)).not.toThrow();
    removeItemSpy.mockRestore();
  });
});

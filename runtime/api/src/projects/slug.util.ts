/**
 * Shared slug validator. Single source of truth for the slug
 * contract across DTO validation, route param guards, and service
 * layer insert checks.
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;
export const SLUG_MIN_LENGTH = 2;
export const SLUG_MAX_LENGTH = 64;

export function isValidSlug(s: string): boolean {
  if (typeof s !== 'string') return false;
  if (s.length < SLUG_MIN_LENGTH || s.length > SLUG_MAX_LENGTH) return false;
  return SLUG_REGEX.test(s);
}

import {
  displayNameSchema,
  DISPLAY_NAME_ALLOWED,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
} from '@argus/contracts';

/** Always-visible guidance shown under the display-name field (mirrors the enforced rule). */
export const DISPLAY_NAME_HINT = `${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters: ${DISPLAY_NAME_ALLOWED}`;

/**
 * Validate a candidate display name against the shared policy and return the first human-readable
 * error message, or `null` when it is acceptable. This is the testable seam for the live (as-you-type)
 * validation in `ProfileEdit` — the actual rule lives once in `@argus/contracts`.
 */
export function displayNameFieldError(value: string): string | null {
  const result = displayNameSchema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'Invalid display name.');
}

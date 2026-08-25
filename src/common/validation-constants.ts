/**
 * Shared validation regexes — single source of truth so create/update DTOs can't
 * drift apart.
 */

/** `HH:mm` on a 24-hour clock (e.g. business dayStartTime). */
export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Branch code: 2–6 uppercase letters or digits, unique per business. */
export const BRANCH_CODE_REGEX = /^[A-Z0-9]{2,6}$/;

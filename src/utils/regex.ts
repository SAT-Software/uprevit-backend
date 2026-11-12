/**
 * Escapes user text before building a Mongo regex filter.
 *
 * @param {string} value Text to escape.
 * @return {string} Regex-safe text.
 */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

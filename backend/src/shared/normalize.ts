/**
 * Text normalization used for vendor de-duplication.
 *
 * The goal: turn what a human typed into a canonical form so that
 * "Acme Software, Inc.", "ACME Software Inc" and "acme software" all collapse
 * to the same string. We store that canonical form in vendors.normalized_name
 * and fuzzy-match against it.
 *
 * This deliberately mirrors the logic the demo form used client-side, so the
 * browser and the backend agree on what "the same vendor" means.
 */

/**
 * Legal entity suffixes. These carry no identifying information - dropping them
 * means "Hooli Inc." and "Hooli" match exactly rather than merely closely.
 */
const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'corp', 'corporation', 'ltd', 'limited',
  'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'nv', 'bv',
  'group', 'holdings', 'llp', 'lp',
]);

/**
 * Normalize a company name for comparison.
 *
 *   "Acme Software, Inc."  ->  "acme software"
 *   "  HOOLI   Inc. "      ->  "hooli"
 */
export function normalizeName(input: string): string {
  const cleaned = String(input ?? '')
    .toLowerCase()
    // Replace anything that is not a letter or digit with a space. This handles
    // commas, periods, ampersands, hyphens and accents-as-punctuation.
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  // Drop legal suffixes wherever they appear as whole words.
  const tokens = cleaned.split(' ').filter((t) => !LEGAL_SUFFIXES.has(t));

  // Edge case: a name made up ENTIRELY of suffix words (someone typed just
  // "Inc"). Falling back to the cleaned string beats returning "".
  return tokens.length ? tokens.join(' ') : cleaned;
}

/**
 * Reduce a website field to a bare hostname for comparison.
 *
 *   "https://www.acme.com/pricing"  ->  "acme.com"
 *   "ACME.com"                      ->  "acme.com"
 *
 * The form's field is a full URL, but an exact host match is the single
 * strongest signal that two records are the same company, so it is worth
 * isolating.
 */
export function normalizeDomain(input: string): string {
  const raw = String(input ?? '').toLowerCase().trim();
  if (!raw) return '';

  return raw
    .replace(/^https?:\/\//, '')   // strip scheme
    .replace(/^www\./, '')         // strip leading www.
    .split('/')[0]                 // drop any path
    .split('?')[0]                 // drop any query string
    .split(':')[0]                 // drop any port
    .trim();
}

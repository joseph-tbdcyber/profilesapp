/**
 * POST /vendor-match
 *
 * Powers the live duplicate check as someone types a vendor name into the
 * intake form.
 *
 * Request:   { "name": "Acme", "domain": "https://acme.com" }
 * Response:  {
 *              "topStatus": "approved",          // drives the form's branching
 *              "candidates": [
 *                { "id": "...", "legalName": "Acme Software, Inc.",
 *                  "domain": "acme.com", "status": "approved",
 *                  "score": 0.72, "confidence": "possible", "items": [...] }
 *              ]
 *            }
 *
 * TODO(auth): this endpoint is public. Once Cognito is wired up, API Gateway
 * will reject unauthenticated callers before this code ever runs - no change
 * needed here.
 */
import { query, str, dbl, respond } from '../shared/db';
import { normalizeName, normalizeDomain } from '../shared/normalize';

/**
 * How similar two names must be before we mention the match at all.
 * pg_trgm scores 0..1. Below this, results are noise.
 */
const MIN_SCORE = 0.3;

/** At or above this, we call it a confident match rather than a maybe. */
const STRONG_SCORE = 0.8;

/**
 * At or above this we consider the match real enough to interrupt the user and
 * ask how they want to proceed. Below it, the form treats the vendor as new.
 */
const ACTIONABLE_SCORE = 0.6;

interface MatchRow {
  id: string;
  legal_name: string;
  primary_domain: string | null;
  status: string;
  score: number;
  items: string | null;
}

export const handler = async (event: { body?: string | null }) => {
  try {
    const input = JSON.parse(event.body || '{}');
    const rawName = String(input.name ?? '');
    const rawDomain = String(input.domain ?? '');

    const name = normalizeName(rawName);
    const domain = normalizeDomain(rawDomain);

    // Nothing worth querying yet. Returning early keeps us from waking a paused
    // database on every keystroke of the first two characters.
    if (name.length < 3 && !domain) {
      return respond(200, { topStatus: null, candidates: [], reason: 'too_short' });
    }

    // GREATEST(...) means an exact domain hit scores a perfect 1 even if the
    // company name was typed completely differently - domain is the strongest
    // available signal that this is the same company.
    //
    // The items sub-select gives the form the "Known items: ..." line.
    const rows = await query<MatchRow>(
      `
      SELECT
        v.id,
        v.legal_name,
        v.primary_domain,
        v.status,
        GREATEST(
          similarity(v.normalized_name, :name),
          CASE WHEN :domain <> '' AND v.primary_domain = :domain THEN 1.0 ELSE 0.0 END
        )::float8 AS score,
        (
          SELECT string_agg(i.name, ', ' ORDER BY i.name)
          FROM items i
          WHERE i.vendor_id = v.id
        ) AS items
      FROM vendors v
      WHERE
        (:name <> '' AND similarity(v.normalized_name, :name) >= :threshold)
        OR (:domain <> '' AND v.primary_domain = :domain)
      ORDER BY score DESC, v.legal_name ASC
      LIMIT 5
      `,
      [str('name', name), str('domain', domain), dbl('threshold', MIN_SCORE)],
    );

    const candidates = rows.map((r) => ({
      id: r.id,
      legalName: r.legal_name,
      domain: r.primary_domain,
      status: r.status,
      score: Number(r.score.toFixed(3)),
      confidence: r.score >= STRONG_SCORE ? 'strong' : 'possible',
      items: r.items ? r.items.split(', ') : [],
    }));

    // The form branches on this single value. "none" means "nothing convincing
    // found, treat this as a new vendor and carry on".
    const best = candidates[0];
    const topStatus = best && best.score >= ACTIONABLE_SCORE ? best.status : 'none';

    return respond(200, { topStatus, candidates });
  } catch (err) {
    console.error('vendor-match failed', err);
    return respond(500, { error: 'vendor_match_failed' });
  }
};

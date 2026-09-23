/**
 * POST /submit
 *
 * Accepts a completed intake form and stores it.
 *
 * Three writes happen together, inside one transaction:
 *   1. vendors      - create the vendor, or reuse it if we already know them
 *   2. items        - one row per entry in the form's "third_party_items" panel
 *   3. submissions  - the untouched payload, for the record
 *
 * Response: { "submissionId": "...", "vendorId": "...", "itemIds": [...] }
 *
 * TODO(auth): public endpoint. With Cognito in front, the submitter's identity
 * would come from the JWT rather than the self-reported submitter_email field.
 */
import { query, withTransaction, str, respond } from '../shared/db';
import { normalizeName, normalizeDomain } from '../shared/normalize';

/** One entry from the form's repeating "items" panel. */
interface SurveyItem {
  item_name?: string;
  item_type?: string;
  [key: string]: unknown;
}

export const handler = async (event: { body?: string | null }) => {
  try {
    const payload = JSON.parse(event.body || '{}');

    // --- Map the form's fields onto our tables ---------------------------
    const legalName = String(payload.vendor_legal_name ?? '').trim();
    const website = String(payload.vendor_website ?? '');
    const items: SurveyItem[] = Array.isArray(payload.third_party_items)
      ? payload.third_party_items
      : [];

    // The vendor name is the one field we genuinely cannot proceed without -
    // it is what every row here hangs off.
    if (!legalName) {
      return respond(400, {
        error: 'missing_vendor_name',
        message: 'vendor_legal_name is required.',
      });
    }

    const normalized = normalizeName(legalName);
    const domain = normalizeDomain(website);

    const result = await withTransaction(async (tx) => {
      // --- 1. Upsert the vendor -----------------------------------------
      // ON CONFLICT means: if a vendor with this normalized name already
      // exists, update it instead of failing.
      //
      // Note what is NOT updated: status. If this vendor is already 'approved'
      // or 'rejected', a new submission must not quietly reset that - only the
      // TPRM team changes a status.
      //
      // "xmax = 0" is a Postgres idiom for "this row was freshly inserted
      // rather than updated", which tells the caller whether the vendor is new.
      const vendorRows = await query<{ id: string; created: boolean }>(
        `
        INSERT INTO vendors (normalized_name, legal_name, primary_domain, status)
        VALUES (:normalized, :legal_name, NULLIF(:domain, ''), 'in_review')
        ON CONFLICT (normalized_name) DO UPDATE
          SET legal_name     = EXCLUDED.legal_name,
              primary_domain = COALESCE(EXCLUDED.primary_domain, vendors.primary_domain)
        RETURNING id, (xmax = 0) AS created
        `,
        [str('normalized', normalized), str('legal_name', legalName), str('domain', domain)],
        tx,
      );

      const vendorId = vendorRows[0].id;
      const vendorCreated = vendorRows[0].created;

      // --- 2. Insert the items ------------------------------------------
      // item_name and item_type get their own columns because we query on them;
      // every other answer in the panel (description, data_types, criticality,
      // provisional_tier, the deep-dive panels) goes into the JSONB blob so the
      // questionnaire can change without a schema migration.
      const itemIds: string[] = [];
      for (const item of items) {
        const itemName = String(item.item_name ?? '').trim();
        if (!itemName) continue;   // skip blank repeat-panels

        const rows = await query<{ id: string }>(
          `
          INSERT INTO items (vendor_id, name, type, status, data)
          VALUES (:vendor_id::uuid, :name, :type, 'in_review', :data::jsonb)
          RETURNING id
          `,
          [
            str('vendor_id', vendorId),
            str('name', itemName),
            str('type', item.item_type ? String(item.item_type) : null),
            str('data', JSON.stringify(item)),
          ],
          tx,
        );
        itemIds.push(rows[0].id);
      }

      // --- 3. Store the raw submission ----------------------------------
      const submissionRows = await query<{ id: string }>(
        `
        INSERT INTO submissions (vendor_id, payload)
        VALUES (:vendor_id::uuid, :payload::jsonb)
        RETURNING id
        `,
        [str('vendor_id', vendorId), str('payload', JSON.stringify(payload))],
        tx,
      );

      return {
        submissionId: submissionRows[0].id,
        vendorId,
        vendorCreated,
        itemIds,
      };
    });

    return respond(201, result);
  } catch (err) {
    console.error('submit failed', err);
    return respond(500, { error: 'submit_failed' });
  }
};

-- ===========================================================================
-- TPRM intake POC - database schema
--
-- Safe to run more than once: every statement uses IF NOT EXISTS, so re-running
-- the init script will not error or wipe anything.
-- ===========================================================================

-- pg_trgm ("trigram") is a built-in PostgreSQL extension for fuzzy text
-- matching. It chops text into 3-character chunks and compares how many chunks
-- two strings share. That is what lets "Cyberdine" still find "Cyberdyne".
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ---------------------------------------------------------------------------
-- vendors - the companies themselves (one row per legal entity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The name reduced to a comparable form: lowercased, punctuation removed,
  -- legal suffixes (Inc, LLC, Corp...) stripped. "Acme Software, Inc."
  -- becomes "acme software". This is the column we fuzzy-match against.
  -- UNIQUE is what makes the upsert in /submit work (ON CONFLICT).
  normalized_name text NOT NULL UNIQUE,

  -- The name as a human typed it, for display.
  legal_name      text NOT NULL,

  -- Host only - "acme.com", not "https://acme.com/pricing". An exact domain
  -- match is the strongest possible signal that two records are the same company.
  primary_domain  text,

  -- Where this vendor sits in the review process.
  -- NOTE: the API can also answer "none", meaning no match was found at all.
  -- That is not stored here - it is not a state a vendor can be in.
  status          text NOT NULL DEFAULT 'in_review'
                    CHECK (status IN ('approved', 'rejected', 'in_review')),

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A GIN trigram index. Without this, similarity() would scan every row.
-- With it, Postgres can narrow down candidates fast.
CREATE INDEX IF NOT EXISTS vendors_normalized_name_trgm
  ON vendors USING gin (normalized_name gin_trgm_ops);

-- Lets us match on domain quickly too.
CREATE INDEX IF NOT EXISTS vendors_primary_domain_idx
  ON vendors (primary_domain);


-- ---------------------------------------------------------------------------
-- items - the things a vendor provides (one vendor -> many items)
-- This is the "third_party_items" panel in the intake form.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Links this item to its vendor. ON DELETE CASCADE means deleting a vendor
  -- also deletes its items, so you cannot end up with orphaned rows.
  vendor_id  uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,

  name       text NOT NULL,          -- form field: item_name
  type       text,                   -- form field: item_type (saas, software, service...)

  status     text NOT NULL DEFAULT 'in_review'
               CHECK (status IN ('approved', 'rejected', 'in_review')),

  -- Everything else the form collected for this item, stored as-is:
  -- item_description, data_types, criticality, provisional_tier, and any
  -- deep-dive panels that were revealed. JSONB means we do not have to add a
  -- column every time the questionnaire changes.
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_vendor_id_idx ON items (vendor_id);


-- ---------------------------------------------------------------------------
-- submissions - the raw intake, exactly as the form sent it
--
-- Keeping the untouched payload means that if we later decide we want a field
-- we did not break out into a column, it is still here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE SET NULL (not CASCADE): if a vendor is removed we still want the
  -- historical record that someone submitted this.
  vendor_id  uuid REFERENCES vendors(id) ON DELETE SET NULL,

  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_vendor_id_idx ON submissions (vendor_id);

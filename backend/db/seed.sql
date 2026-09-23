-- ===========================================================================
-- TPRM intake POC - seed data
--
-- These are the SAME twelve vendors the demo form used as its hardcoded mock
-- list. That is deliberate: the form's own help panel lists these names and
-- invites you to "type these, or misspell them", so seeding the same set keeps
-- that instruction true now that matching is backed by the real database.
--
-- Safe to re-run: ON CONFLICT DO NOTHING means running this twice does not
-- create duplicates or error.
-- ===========================================================================

INSERT INTO vendors (normalized_name, legal_name, primary_domain, status) VALUES
  ('acme software',      'Acme Software, Inc.',       'acme.com',             'approved'),
  ('globex',             'Globex Corporation',        'globex.com',           'in_review'),
  ('initech',            'Initech LLC',               'initech.com',          'approved'),
  ('umbrella health systems', 'Umbrella Health Systems', 'umbrellahealth.com', 'rejected'),
  ('hooli',              'Hooli Inc.',                'hooli.com',            'approved'),
  ('stark industries',   'Stark Industries',          'stark.com',            'approved'),
  ('wayne enterprises',  'Wayne Enterprises',         'wayneenterprises.com', 'in_review'),
  ('cyberdyne systems',  'Cyberdyne Systems',         'cyberdyne.com',        'rejected'),
  ('soylent foods',      'Soylent Foods Co.',         'soylentfoods.com',     'approved'),
  ('vandelay industries','Vandelay Industries',       'vandelay.com',         'approved'),
  ('massive dynamic',    'Massive Dynamic',           'massivedynamic.com',   'in_review'),
  ('pied piper',         'Pied Piper, Inc.',          'piedpiper.com',        'rejected')
ON CONFLICT (normalized_name) DO NOTHING;


-- A couple of vendors have known items already on file, so that a match result
-- can show "Known items: ..." the way the demo did.
INSERT INTO items (vendor_id, name, type, status, data)
SELECT v.id, i.name, i.type, i.status, '{"seeded": true}'::jsonb
FROM vendors v
JOIN (VALUES
  ('acme software', 'Acme Analytics Cloud', 'saas',    'approved'),
  ('acme software', 'Acme Mail Gateway',    'saas',    'approved'),
  ('initech',       'Initech TPS Portal',   'saas',    'approved')
) AS i(vendor_key, name, type, status)
  ON v.normalized_name = i.vendor_key
-- Do not insert an item that is already there (makes re-running safe).
WHERE NOT EXISTS (
  SELECT 1 FROM items existing
  WHERE existing.vendor_id = v.id AND existing.name = i.name
);

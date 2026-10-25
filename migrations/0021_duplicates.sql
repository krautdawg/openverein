-- "Not a duplicate" decisions, stored per unordered pair (smaller id first).
create table duplicate_dismissal (
  organization_id uuid not null references organization(id),
  person_a uuid not null references person(id),
  person_b uuid not null references person(id),
  dismissed_by uuid references app_user(id),
  dismissed_at timestamptz not null default now(),
  primary key (person_a, person_b),
  check (person_a < person_b)
);

-- Name key for duplicate search: lower case, German spellings folded (ü/ue …), accents removed. Immutable (explicit
-- dictionary), so a trigram index can serve the candidate search instead of comparing every pair.
create function ov_dup_key(first text, last text, company text) returns text language sql immutable parallel safe as $$
  select public.unaccent('public.unaccent'::regdictionary,
    replace(replace(replace(replace(lower(coalesce(last, '') || ' ' || coalesce(first, '') || ' ' || coalesce(company, '')), 'ü', 'ue'), 'ö', 'oe'), 'ä', 'ae'), 'ß', 'ss'))
$$;
create index person_dup_key_trgm on person using gin (ov_dup_key(first_name, last_name, company_name) gin_trgm_ops);
